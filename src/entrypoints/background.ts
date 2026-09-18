// Background service worker: single rate-limited Jev classification queue,
// image fetch proxy, status broadcasting, and toolbar icon state.
import { experimental_evaluate } from 'ai';
import { createGateway, type GatewayProvider } from '@ai-sdk/gateway';
import { appendBlocked } from '../shared/log';
import { loadSettings, saveStatus } from '../shared/settings';
import {
  STORAGE_KEYS,
  type BgRequest,
  type FilterStatus,
  type ImageReply,
  type JevReply,
  type Settings,
} from '../shared/types';

const QUEUE_CONCURRENCY = 3;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;

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

function isRateLimited(errorMessage: string): boolean {
  return errorMessage.includes('429') || /RateLimitError/i.test(errorMessage);
}

function isTimeout(errorMessage: string): boolean {
  const s = errorMessage.toLowerCase();
  return s.includes('aborted') || s.includes('timed out') || s.includes('timeout');
}

function isTransient(errorMessage: string): boolean {
  const s = errorMessage.toLowerCase();
  return (
    s.startsWith('5') ||
    s.includes('fetch failed') ||
    s.includes('network') ||
    s.includes('timeout')
  );
}

async function classifyWithRetry(
  author: string,
  text: string,
): Promise<JevReply> {
  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
      if (failingReason) await setFailing(null);
      return { ok: true, ...result };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      // A quota wall or a capped-out call won't improve within a retry
      // window: fail fast so the feed goes visible and the icon shows the
      // broken state now.
      if (isRateLimited(lastError) || isTimeout(lastError) || !isTransient(lastError)) break;
      if (attempt === MAX_ATTEMPTS) break;
      await new Promise((r) => setTimeout(r, BACKOFF_BASE_MS * 2 ** (attempt - 1)));
    } finally {
      release();
    }
  }
  await setFailing(lastError);
  return { ok: false, error: lastError };
}

async function setFailing(reason: string | null): Promise<void> {
  failingReason = reason;
  const status: FilterStatus = {
    state: reason ? 'failing' : 'ok',
    reason: reason ?? undefined,
    updatedAt: Date.now(),
  };
  await saveStatus(status);
  const iconPrefix = reason ? 'failing' : 'normal';
  await browser.action.setIcon({
    path: {
      16: `/icons/${iconPrefix}-16.png`,
      32: `/icons/${iconPrefix}-32.png`,
      48: `/icons/${iconPrefix}-48.png`,
      128: `/icons/${iconPrefix}-128.png`,
    },
  });
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

async function handleRequest(request: BgRequest): Promise<unknown> {
  switch (request.type) {
    case 'jev': {
      const reply = await classifyWithRetry(request.author, request.text);
      if (reply.ok) return reply;
      // Fail-open: content script shows the tweet unfiltered.
      return reply;
    }
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
  }
}

browser.runtime.onMessage.addListener((request: BgRequest) => {
  if (!request || typeof request !== 'object' || !('type' in request)) return;
  if (!['jev', 'fetch-image', 'get-status', 'log-blocked'].includes(request.type)) return;
  // Return a promise: keeps the message channel open for the async reply.
  // Startup requests wait for settings instead of racing loadSettings().
  return settingsSync.then(() => handleRequest(request));
});

async function init(): Promise<void> {
  await syncSettings();
  const stored = await browser.storage.local.get(STORAGE_KEYS.status);
  const status = stored[STORAGE_KEYS.status] as FilterStatus | undefined;
  failingReason = status?.state === 'failing' ? (status.reason ?? 'unknown') : null;
  await setFailing(failingReason);

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_KEYS.settings]) void syncSettings();
  });
}

export default defineBackground(() => {
  void init();
});
