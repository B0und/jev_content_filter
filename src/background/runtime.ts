// Background service worker runtime: single rate-limited Jev classification
// queue, image fetch proxy, status broadcasting, and toolbar icon state.
//
// MV3 wake contract: startBackground() must register every browser listener
// synchronously, before its first await, so events arriving while the worker
// spins up are never missed. Async work (settings load, status restore) runs
// after registration; message handlers await the readiness chain instead.
import { evaluateText } from './text-provider';
import { browser } from 'wxt/browser';
import { appendBlocked, appendScanError, clearLog, clearScanErrors } from '../shared/log';
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
// Cap on requests waiting for a classification slot: past this the gateway is
// hopelessly saturated and callers fail open instead of piling up.
const MAX_WAITING = 64;

let settings: Settings | null = null;
let active = 0;
const waiting: Array<() => void> = [];

let failingReason: string | null = null;

// Serialized read-modify-write queue for blocked-log/scan-error appends and
// clears: concurrent content tabs (and log clears) would otherwise clobber
// each other over storage.local.
let logQueue: Promise<void> = Promise.resolve();

// Settings are loaded once before any request is served, then reloaded
// through this serialized chain on storage changes.
let settingsSync: Promise<void> = Promise.resolve();

// Full worker readiness (settings + persisted status restored). Message
// handlers wait on this so an early success cannot miss a stored failing
// status and leave a stale banner behind.
let ready: Promise<void> = Promise.resolve();

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

// Slot ownership is transferred explicitly: releaseSlot hands the permit
// directly to the next waiter (keeping `active` as the count of held
// permits) instead of decrementing and re-incrementing, which let requests
// arriving between the two steps push concurrency past the limit.
async function acquireSlot(): Promise<() => void> {
  if (waiting.length >= MAX_WAITING) {
    throw new Error(`classification queue full (${MAX_WAITING} waiting)`);
  }
  if (active < QUEUE_CONCURRENCY) {
    active++;
    return releaseSlot;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  return releaseSlot;
}

function releaseSlot(): void {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

// Single API attempt: visible retry handling (countdowns, backoff) is owned
// by the content script, which re-sends 'jev' requests for failed posts.
async function classify(text: string): Promise<JevReply> {
  const release = await acquireSlot();
  try {
    const current = settings;
    if (!current?.gatewayKey) throw new Error('no API key configured');
    const result = await evaluateText({
      provider: current.textProvider,
      apiKey: current.gatewayKey,
      text,
    });
    // Only a clean success clears the failing banner: a failing result from
    // one request must never be overwritten by another request's stale ok.
    if (failingReason) await setFailing(null);
    return { ok: true, ...result };
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    // The content script decides whether a failure is worth retrying from
    // this text alone: prefix the HTTP status so auth/permission failures
    // (e.g. a revoked key) are recognized as non-retryable even when the
    // gateway error wrapper hides the status in its message.
    const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
    if (typeof statusCode === 'number' && !message.includes(String(statusCode))) {
      message = `${statusCode}: ${message}`;
    }
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
      // Icon/title failures are cosmetic: they must never poison the
      // classification status (a rejected setIcon would otherwise flip the
      // worker into a failing state and fail open unrelated posts).
      await browser.action
        .setIcon({
          path: {
            16: `/icons/${name}-16.png`,
            32: `/icons/${name}-32.png`,
            48: `/icons/${name}-48.png`,
            128: `/icons/${name}-128.png`,
          },
        })
        .catch((error) => console.warn('[jev-filter] setIcon failed', error));
      const reason = failingReason ? ` — failing: ${failingReason.slice(0, 120)}` : '';
      await browser.action
        .setTitle({
          title: `Jev Feed Filter${paused ? ' (paused)' : reason}`,
        })
        .catch((error) => console.warn('[jev-filter] setTitle failed', error));
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
    if (
      key.startsWith(TAB_COUNT_PREFIX) &&
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0
    ) {
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

// Serialized log mutation: every append/clear of the blocked log and the
// scan-error log joins the same queue, so a clear racing an in-flight append
// can never be overwritten by the append's pre-clear read.
function enqueueLogOperation(operation: () => Promise<void>): Promise<{ ok: true }> {
  const run = logQueue.catch(() => undefined).then(operation);
  logQueue = run;
  return run.then(() => ({ ok: true }) as const);
}

const BG_REQUEST_TYPES = [
  'jev',
  'fetch-image',
  'get-status',
  'log-blocked',
  'log-error',
  'clear-log',
  'clear-errors',
  'open-logs',
  'tab-stats',
] as const;

function isBgRequest(value: unknown): value is BgRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as { type: unknown }).type === 'string' &&
    (BG_REQUEST_TYPES as readonly string[]).includes((value as { type: string }).type)
  );
}

async function handleRequest(
  request: BgRequest,
  sender: { tab?: { id?: number } },
): Promise<unknown> {
  switch (request.type) {
    case 'jev':
      return classify(request.text);
    case 'fetch-image':
      return fetchImageDataUrl(request.url);
    case 'get-status': {
      const stored = await browser.storage.local.get(STORAGE_KEYS.status);
      return stored[STORAGE_KEYS.status] ?? { state: 'ok', updatedAt: 0 };
    }
    case 'log-blocked':
      return enqueueLogOperation(() => appendBlocked(request.entry));
    case 'log-error':
      return enqueueLogOperation(() =>
        appendScanError(
          request.message,
          request.tweetId ? { tweetId: request.tweetId, handle: request.handle } : undefined,
        ),
      );
    case 'clear-log':
      return enqueueLogOperation(() => clearLog());
    case 'clear-errors':
      return enqueueLogOperation(() => clearScanErrors());
    case 'open-logs': {
      // Page contexts cannot navigate to chrome-extension:// URLs; open the
      // log from the privileged worker instead.
      const url = browser.runtime.getURL('/logs.html') + (request.errors ? '#errors' : '');
      void browser.tabs.create({ url });
      return { ok: true };
    }
    case 'tab-stats': {
      // uBlock-style per-tab badge; only content scripts have a sender tab.
      // Awaited so the reply confirms the badge state was applied.
      const tabId = sender.tab?.id;
      if (typeof tabId !== 'number') return { ok: false };
      if (!Number.isFinite(request.blocked) || request.blocked < 0) return { ok: false };
      await updateTabCount(tabId, Math.floor(request.blocked));
      return { ok: true };
    }
  }
}

// Return `true` and reply via sendResponse: the canonical MV3 pattern that
// keeps the message channel open for the async reply in every runtime
// (returning only a Promise silently yields `undefined` in some hosts).
function onMessageListener(
  request: unknown,
  sender: { tab?: { id?: number } },
  sendResponse: (reply: unknown) => void,
): true | undefined {
  if (!isBgRequest(request)) return;
  void ready
    .then(() => handleRequest(request, sender))
    .then((reply) => sendResponse(reply))
    .catch((error) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
  return true;
}

async function init(): Promise<void> {
  await syncSettings();
  // Restore the failing banner persisted by a previous worker run before any
  // classification can report success: otherwise a request served before
  // this line could "succeed" while the stored status stays stale-failing.
  const stored = await browser.storage.local.get(STORAGE_KEYS.status);
  const status = stored[STORAGE_KEYS.status] as FilterStatus | undefined;
  failingReason = status?.state === 'failing' ? (status.reason ?? 'unknown') : null;
  await updateIcon();
}

/**
 * Register all browser listeners and start worker initialization. Every
 * listener attaches synchronously, before this function's first await —
 * required for the MV3 worker to wake on these events.
 */
export function startBackground(): void {
  browser.runtime.onMessage.addListener(onMessageListener);

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

  void browser.action.setBadgeBackgroundColor({ color: '#1d9bf0' });
  void browser.action.setBadgeTextColor({ color: '#ffffff' });

  ready = init();
}
