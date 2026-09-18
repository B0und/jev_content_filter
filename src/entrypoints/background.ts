// Background service worker: single rate-limited Jev classification queue,
// image fetch proxy, status broadcasting, and toolbar icon state.
import { experimental_evaluate } from 'ai';
import { createGateway, type GatewayProvider } from '@ai-sdk/gateway';
import { appendBlocked, appendScanError } from '../shared/log';
import { loadSettings, saveStatus } from '../shared/settings';
import {
  STORAGE_KEYS,
  formatCount,
  type BgRequest,
  type FilterStatus,
  type ImageReply,
  type JevReply,
  type Settings,
} from '../shared/types';

const QUEUE_CONCURRENCY = 3;

let settings: Settings | null = null;
let gatewayInstance: GatewayProvider | null = null;
let gatewayKeyUsed = '';

let active = 0;
const waiting: Array<() => void> = [];

let failingReason: string | null = null;

// Serialized read-modify-write queue for blocked-log appends: concurrent
// content tabs would otherwise clobber each other over storage.local.
let logQueue: Promise<void> = Promise.resolve();

// Settings are loaded once before any request is served, then reloaded
// through this serialized chain on storage changes.
let settingsSync: Promise<void> = Promise.resolve();

function syncSettings(): Promise<void> {
  settingsSync = settingsSync
    .catch(() => undefined)
    .then(async () => {
      settings = await loadSettings();
    })
    .catch((error) => {
      // Keep the chain alive; a later storage change or restart retries.
      console.error('[jev-filter] failed to load settings', error);
    });
  return settingsSync;
}

function gateway() {
  const key = settings?.gatewayKey ?? '';
  if (!gatewayInstance || gatewayKeyUsed !== key) {
    gatewayInstance = createGateway({ apiKey: key });
    gatewayKeyUsed = key;
  }
  return gatewayInstance;
}

async function acquireSlot(): Promise<() => void> {
  if (active < QUEUE_CONCURRENCY) {
    active++;
    return releaseSlot;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  return releaseSlot;
}

function releaseSlot(): void {
  active--;
  const next = waiting.shift();
  if (next) next();
}

async function evaluateText(
  author: string,
  text: string,
): Promise<{ sexual: number; ai: number }> {
  const result = await experimental_evaluate({
    model: gateway().evaluationModel('typesafe-ai/jev'),
    maxRetries: 0,
    // Gateway can take ~15s to surface a rate-limit error; cap the wait so
    // the fail-open path isn't held hostage by a doomed request.
    abortSignal: AbortSignal.timeout(8000),
    state: { tweet_author: author, tweet_text: text },
    questions: {
      sexual: {
        type: 'boolean',
        instructions:
          'Does this tweet contain explicit sexual content, lewd innuendo, heavily implied sexual content, or engagement bait designed to arouse?',
        criteria: {
          true: 'Lewd imagery descriptions, sexual innuendo, thirst traps, or gooner-bait phrasing',
          false: 'Ordinary non-sexual content, even if it discusses news, health, or relationships factually',
        },
      },
      ai: {
        type: 'boolean',
        instructions:
          'Was this tweet most likely written by an AI or LLM, e.g. generic AI phrasing, engagement-farming templates, or machine-generated summaries?',
        criteria: {
          true: 'Tell-tale LLM phrasing, over-structured lists, hollow engagement bait, synthetic voice',
          false: 'Natural human writing, including slang, typos, or short fragments',
        },
      },
    },
  });
  const sexual = (result.answers.sexual as { probability: number }).probability;
  const ai = (result.answers.ai as { probability: number }).probability;
  return { sexual, ai };
}

// Single API attempt: visible retry handling (countdowns, backoff) is owned
// by the content script, which re-sends 'jev' requests for failed posts.
async function classify(author: string, text: string): Promise<JevReply> {
  const release = await acquireSlot();
  try {
    if (!settings?.gatewayKey) throw new Error('no API key configured');
    const result = await evaluateText(author, text);
    const invalid = Object.values(result).find(
      (p) => typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1,
    );
    if (invalid !== undefined) {
      throw new Error(`Jev returned invalid probability ${String(invalid)}`);
    }
    // Only a clean success clears the failing banner: a failing result from
    // one request must never be overwritten by another request's stale ok.
    if (failingReason) await setFailing(null);
    return { ok: true, ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await setFailing(message);
    // Fail-open: content script shows the tweet unfiltered.
    return { ok: false, error: message };
  } finally {
    release();
  }
}

async function setFailing(reason: string | null): Promise<void> {
  failingReason = reason;
  const status: FilterStatus = {
    state: reason ? 'failing' : 'ok',
    reason: reason ?? undefined,
    updatedAt: Date.now(),
  };
  await saveStatus(status);
  await updateIcon();
}

/**
 * Toolbar icon: paused (gray) when filtering is off, normal otherwise. The
 * failing state keeps the normal icon — the badge-less, neutral look — and
 * the tooltip explains what is wrong instead of an alarm color.
 * Serialized so concurrent callers can't apply stale icon state.
 */
let iconSync: Promise<void> = Promise.resolve();

function updateIcon(): Promise<void> {
  const run = iconSync
    .catch(() => undefined)
    .then(async () => {
      const paused = !settings?.masterEnabled;
      const name = paused ? 'paused' : 'normal';
      await browser.action.setIcon({
        path: {
          16: `/icons/${name}-16.png`,
          32: `/icons/${name}-32.png`,
          48: `/icons/${name}-48.png`,
          128: `/icons/${name}-128.png`,
        },
      });
      const reason = failingReason
        ? ` — failing: ${failingReason.slice(0, 120)}`
        : '';
      await browser.action.setTitle({
        title: `Jev Feed Filter${paused ? ' (paused)' : reason}`,
      });
    });
  iconSync = run;
  return run;
}

// Per-tab blocked counts for the toolbar badge, uBlock-style: each tab's
// badge is set with an explicit tabId so counts never bleed across tabs.
// Counts live in storage.session (covered by the existing 'storage'
// permission) so they survive MV3 worker suspension; the browser clears
// session storage only when the browser itself closes.
const TAB_COUNT_PREFIX = 'jevTabBlocked:';
let tabCounts = new Map<number, number>();
let tabCountsLoaded = false;
let tabCountSync: Promise<void> = Promise.resolve();

async function loadTabCounts(): Promise<void> {
  if (tabCountsLoaded) return;
  const stored = await browser.storage.session.get(null);
  tabCounts = new Map<number, number>();
  for (const [key, value] of Object.entries(stored)) {
    if (key.startsWith(TAB_COUNT_PREFIX) && typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      tabCounts.set(Number(key.slice(TAB_COUNT_PREFIX.length)), value);
    }
  }
  tabCountsLoaded = true;
}

// Paused hides every badge; a zero count shows nothing.
function badgeTextFor(count: number): string {
  return !settings?.masterEnabled || count <= 0 ? '' : formatCount(count);
}

function setTabBadge(tabId: number, text: string): void {
  // The tab can close between tracking and the call: badge errors are benign.
  void browser.action.setBadgeText({ text, tabId }).catch(() => undefined);
}

function updateTabCount(tabId: number, blocked: number): Promise<void> {
  const run = tabCountSync
    .catch(() => undefined)
    .then(async () => {
      await loadTabCounts();
      tabCounts.set(tabId, blocked);
      await browser.storage.session.set({ [TAB_COUNT_PREFIX + tabId]: blocked });
      setTabBadge(tabId, badgeTextFor(blocked));
    });
  tabCountSync = run;
  return run;
}

function clearTabCount(tabId: number): Promise<void> {
  const run = tabCountSync
    .catch(() => undefined)
    .then(async () => {
      if (tabCounts.delete(tabId)) {
        await browser.storage.session.remove(TAB_COUNT_PREFIX + tabId).catch(() => undefined);
      }
      setTabBadge(tabId, '');
    });
  tabCountSync = run;
  return run;
}

// Pause hides every tab's badge but keeps the counts; resume repaints them
// from storage, so a worker restart mid-pause still restores correctly.
function repaintTabBadges(): Promise<void> {
  const run = tabCountSync
    .catch(() => undefined)
    .then(async () => {
      await loadTabCounts();
      for (const [tabId, count] of tabCounts) setTabBadge(tabId, badgeTextFor(count));
    });
  tabCountSync = run;
  return run;
}

// Convert Blob to a data URL without FileReader, which is unavailable in
// some non-Chromium MV3 runtimes: decode via arrayBuffer + bounded btoa
// chunks. Bytes stay function-local so nothing is retained afterwards.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const BTOA_CHUNK = 0x8000; // String.fromCharCode spread limit headroom

async function blobToDataUrl(blob: Blob): Promise<string> {
  if (blob.size > MAX_IMAGE_BYTES) {
    throw new Error(`image too large: ${blob.size} bytes (limit ${MAX_IMAGE_BYTES})`);
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const mime = blob.type || 'application/octet-stream';
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BTOA_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BTOA_CHUNK));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

const IMAGE_FETCH_TIMEOUT_MS = 10_000;

function isAllowedImageUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') {
    return parsed.hostname === 'pbs.twimg.com' || parsed.hostname === 'video.twimg.com';
  }
  // Dev-only fixture server (mock/ mirrors the twimg path layout).
  if (import.meta.env.DEV && parsed.protocol === 'http:') {
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  }
  return false;
}

async function fetchImageDataUrl(url: string): Promise<ImageReply> {
  if (!isAllowedImageUrl(url)) {
    return { ok: false, error: `image proxy: host not allowed for ${url}` };
  }
  try {
    const response = await fetch(url, {
      credentials: 'omit',
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`image fetch HTTP ${response.status}`);
    const dataUrl = await blobToDataUrl(await response.blob());
    return { ok: true, dataUrl };
  } catch (error) {
    const message =
      error instanceof DOMException && error.name === 'TimeoutError'
        ? `image fetch timed out after ${IMAGE_FETCH_TIMEOUT_MS}ms`
        : error instanceof Error
          ? error.message
          : String(error);
    return { ok: false, error: `image proxy failed for ${url}: ${message}` };
  }
}

async function handleRequest(request: BgRequest, sender: { tab?: { id?: number } }): Promise<unknown> {
  switch (request.type) {
    case 'jev':
      return classify(request.author, request.text);
    case 'fetch-image':
      return fetchImageDataUrl(request.url);
    case 'get-status': {
      const stored = await browser.storage.local.get(STORAGE_KEYS.status);
      return stored[STORAGE_KEYS.status] ?? { state: 'ok', updatedAt: 0 };
    }
    case 'log-blocked': {
      // Content tabs log concurrently; the queue serializes read-modify-write
      // appends over storage.local so updates never clobber each other.
      const run = logQueue.catch(() => undefined).then(() => appendBlocked(request.entry));
      logQueue = run;
      return run;
    }
    case 'open-logs': {
      // Page contexts cannot navigate to chrome-extension:// URLs; open the
      // log from the privileged worker instead.
      const url = browser.runtime.getURL('/logs.html') + (request.errors ? '#errors' : '');
      void browser.tabs.create({ url });
      return { ok: true };
    }
    case 'tab-stats': {
      // uBlock-style per-tab badge; only content scripts have a sender tab.
      const tabId = sender.tab?.id;
      if (typeof tabId !== 'number') return { ok: false };
      if (!Number.isFinite(request.blocked) || request.blocked < 0) return { ok: false };
      void updateTabCount(tabId, Math.floor(request.blocked));
      return { ok: true };
    }
    case 'log-error': {
      // Scan-error rows share the blocked-log queue so read-modify-write
      // appends from concurrent tabs never clobber each other.
      const run = logQueue
        .catch(() => undefined)
        .then(() =>
          appendScanError(
            request.message,
            request.tweetId
              ? { tweetId: request.tweetId, handle: request.handle }
              : undefined,
          ),
        );
      logQueue = run;
      return run;
    }
  }
}

browser.runtime.onMessage.addListener((request: BgRequest, sender) => {
  if (!request || typeof request !== 'object' || !('type' in request)) return;
  if (!['jev', 'fetch-image', 'get-status', 'log-blocked', 'log-error', 'open-logs', 'tab-stats'].includes(request.type)) return;
  // Return a promise: keeps the message channel open for the async reply.
  // Startup requests wait for settings instead of racing loadSettings().
  return settingsSync.then(() => handleRequest(request, sender));
});

async function init(): Promise<void> {
  await syncSettings();
  const stored = await browser.storage.local.get(STORAGE_KEYS.status);
  const status = stored[STORAGE_KEYS.status] as FilterStatus | undefined;
  failingReason = status?.state === 'failing' ? (status.reason ?? 'unknown') : null;
  await updateIcon();
  void browser.action.setBadgeBackgroundColor({ color: '#1d9bf0' });
  void browser.action.setBadgeTextColor({ color: '#ffffff' });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_KEYS.settings]) {
      void syncSettings().then(() => {
        void updateIcon();
        // Pause hides every badge but keeps counts; resume repaints them.
        void repaintTabBadges();
      });
    }
  });

  // Navigation or tab close wipes that tab's count: the content script
  // re-reports on load, so no stale badge survives onto the next page.
  browser.tabs.onRemoved.addListener((tabId) => {
    void clearTabCount(tabId);
  });
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') void clearTabCount(tabId);
  });
}

export default defineBackground(() => {
  void init();
});
