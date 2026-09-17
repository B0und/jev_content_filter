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

function blobToDataUrl(blob: Blob): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result as string);
  reader.onerror = () => reject(new Error('blob read failed'));
  reader.readAsDataURL(blob);
  return promise;
}

async function fetchImageDataUrl(url: string): Promise<JevReply | { ok: true; dataUrl: string }> {
  try {
    const response = await fetch(url, { credentials: 'omit' });
    if (!response.ok) throw new Error(`image fetch HTTP ${response.status}`);
    const blob = await response.blob();
    const dataUrl = await blobToDataUrl(blob);
    return { ok: true, dataUrl };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
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
  }
}

browser.runtime.onMessage.addListener((request: BgRequest) => {
  if (!request || typeof request !== 'object' || !('type' in request)) return;
  if (!['jev', 'fetch-image', 'get-status'].includes(request.type)) return;
  // Return a promise: keeps the message channel open for the async reply.
  return handleRequest(request);
});

async function init(): Promise<void> {
  settings = await loadSettings();
  const stored = await browser.storage.local.get(STORAGE_KEYS.status);
  const status = stored[STORAGE_KEYS.status] as FilterStatus | undefined;
  failingReason = status?.state === 'failing' ? (status.reason ?? 'unknown') : null;
  await setFailing(failingReason);

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const settingsChange = changes[STORAGE_KEYS.settings];
    if (settingsChange) {
      settings = settingsChange.newValue as Settings | null;
    }
  });
}

export default defineBackground(() => {
  void init();
});
