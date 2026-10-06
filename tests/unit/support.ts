// Shared harness for content runtime unit tests. Tests drive the real
// runtime (startContentFilter + ContentScriptContext) over WXT fake storage
// and a fake background listening on real runtime.onMessage. External
// compute is controlled at its browser-message seam; decisions and storage
// stay real.
import { Effect } from 'effect';
import * as Schema from 'effect/Schema';
import { expect, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import { ContentScriptContext } from 'wxt/utils/content-script-context';
import {
  defaultSettings,
  STORAGE_KEYS,
  type BlockedEntry,
  type Settings,
  type TabReport,
} from '../../src/filtering/types';
import type { InferenceReply } from '../../src/inference/contracts';
import { newPost, type Post } from '../../src/content/state';
import { applySettingsChange, loadSettings } from '../../src/filtering/settings';
import { BgRequestSchema } from '../../src/filtering/schemas';
import { startContentFilter } from '../../src/content/runtime';

const isBgRequest = Schema.is(BgRequestSchema);

/** A minimal Post for direct classify-module calls. */
export function newPostStub(id: string, text = `text ${id}`): Post {
  return newPost(id, `user${id}`, text, [], '', '');
}

export function baseSettings(overrides: Partial<Settings> = {}): Settings {
  const base = defaultSettings();
  return {
    ...base,
    ...overrides,
    enabled: { ...base.enabled, ...overrides.enabled },
    providerKeys: { ...base.providerKeys, ...overrides.providerKeys },
    thresholds: { ...base.thresholds, ...overrides.thresholds },
  };
}

export interface FakeBackground {
  /** Replies for 'jev'; replaced per test. May return a promise. */
  respond: (request: {
    tweetId: string;
    text: string;
  }) =>
    | { ok: true; sexual: number }
    | { ok: false; error: string }
    | Promise<{ ok: true; sexual: number } | { ok: false; error: string }>;
  aiRespond: (request: {
    type: 'classify-ai';
    text: string;
  }) => InferenceReply | Promise<InferenceReply>;
  imageRespond: (request: {
    type: 'classify-image';
    url: string;
  }) => InferenceReply | Promise<InferenceReply>;
  ocrRespond: (request: {
    type: 'extract-image-text';
    url: string;
  }) => InferenceReply | Promise<InferenceReply>;
  ocrCalls: Array<{ type: 'extract-image-text'; url: string }>;
  jevCalls: Array<{ tweetId: string; text: string }>;
  aiCalls: Array<{ type: 'classify-ai'; text: string }>;
  imageCalls: Array<{ type: 'classify-image'; url: string }>;
  blockedEntries: BlockedEntry[];
  loggedErrors: string[];
  openLogs: Array<{ errors: boolean }>;
  stats: number[];
}

export function installFakeBackground(): FakeBackground {
  const bg: FakeBackground = {
    respond: () => ({ ok: true, sexual: 0.01 }),
    aiRespond: () => ({ ok: true, scores: { aiGenerated: 0.01 } }),
    imageRespond: () => ({
      ok: true,
      scores: { porn: 0.01, hentai: 0.01, sexy: 0.01, drawings: 0.01 },
    }),
    ocrRespond: () => ({ ok: true, scores: {}, text: '' }),
    ocrCalls: [],
    jevCalls: [],
    aiCalls: [],
    imageCalls: [],
    blockedEntries: [],
    loggedErrors: [],
    openLogs: [],
    stats: [],
  };
  // fakeBrowser messaging delivers a response only through sendResponse
  // combined with a literal `true` return (callback style).
  browser.runtime.onMessage.addListener(
    (request: unknown, _sender, sendResponse: (value: unknown) => void) => {
      if (!isBgRequest(request)) return false;
      if (request.type === 'jev') {
        bg.jevCalls.push(request);
        void (async () => {
          const reply = await bg.respond(request);
          sendResponse(
            reply.ok ? { ...reply, provider: request.provider, revision: request.revision } : reply,
          );
        })();
        return true;
      }
      if (request.type === 'classify-ai') {
        bg.aiCalls.push(request);
        void (async () => sendResponse(await bg.aiRespond(request)))();
        return true;
      }
      if (request.type === 'extract-image-text') {
        bg.ocrCalls.push(request);
        void (async () => sendResponse(await bg.ocrRespond(request)))();
        return true;
      }
      if (request.type === 'classify-image') {
        bg.imageCalls.push(request);
        void (async () => sendResponse(await bg.imageRespond(request)))();
        return true;
      }
      if (request.type === 'update-settings') {
        void (async () => {
          const next = applySettingsChange(await Effect.runPromise(loadSettings()), request.change);
          await browser.storage.local.set({ [STORAGE_KEYS.settings]: next });
          sendResponse({ ok: true, settings: next });
        })();
        return true;
      }
      if (request.type === 'log-blocked') {
        bg.blockedEntries.push(request.entry);
        sendResponse({ ok: true });
        return true;
      }
      if (request.type === 'log-error') {
        bg.loggedErrors.push(request.message);
        sendResponse({ ok: true });
        return true;
      }
      if (request.type === 'open-logs') {
        bg.openLogs.push(request);
        sendResponse({ ok: true });
        return true;
      }
      if (request.type === 'tab-stats') {
        bg.stats.push(request.blocked);
        sendResponse({ ok: true });
        return true;
      }
      return false;
    },
  );
  return bg;
}

export interface ContentHandle {
  discover(): void;
  report(): TabReport;
}

export interface RuntimeTest {
  ctx: ContentScriptContext;
  handle: ContentHandle;
  bg: FakeBackground;
}

export async function startRuntime(
  settingsOverrides: Partial<Settings> = {},
): Promise<RuntimeTest> {
  fakeBrowser.reset();
  const runtimeSettings = baseSettings({
    providerKeys: { vercel: 'test-key', typesafe: 'test-key', openrouter: 'test-key' },
    ...settingsOverrides,
  });
  // Default runtime tests exercise remote sexual-text only. Other classifiers
  // must be explicitly enabled by the scenario that uses them.
  if (settingsOverrides.enabled === undefined) {
    runtimeSettings.enabled.porn = false;
    runtimeSettings.enabled.hentai = false;
    runtimeSettings.enabled.sexy = false;
    runtimeSettings.enabled.drawings = false;
    runtimeSettings.enabled.aiGenerated = false;
  }
  await browser.storage.local.set({ [STORAGE_KEYS.settings]: runtimeSettings });
  const bg = installFakeBackground();
  const ctx = new ContentScriptContext('test');
  const handle = await startContentFilter(ctx);
  return { ctx, handle, bg };
}

export function buildTweetArticle(options: {
  id: string;
  handle?: string;
  author?: string;
  text?: string;
  images?: string[];
  previewUrl?: string;
  previewText?: string;
}): HTMLElement {
  const { id } = options;
  const handle = options.handle ?? `user${id}`;
  const article = document.createElement('article');
  article.setAttribute('data-testid', 'tweet');
  article.innerHTML = `
    <div data-testid="User-Name"><span>${options.author ?? `@${handle}`}</span></div>
    <div><a href="/${handle}/status/${id}"><time datetime="2026-01-01"></time></a></div>
    ${options.text ? `<div data-testid="tweetText">${options.text}</div>` : ''}
    ${(options.images ?? []).map((url) => `<img src="${url}">`).join('')}
    ${options.previewUrl || options.previewText ? `<div data-testid="card.wrapper"><a href="https://example.com/x/${id}">${options.previewUrl ? `<img src="${options.previewUrl}">` : ''}${options.previewText ?? ''}</a></div>` : ''}
  `;
  document.body.append(article);
  return article;
}

export function iconButton(article: HTMLElement): HTMLButtonElement {
  const host = article.querySelector<HTMLElement>('[data-jev-host]');
  const button = host?.shadowRoot?.querySelector<HTMLButtonElement>('button');
  if (!button) throw new Error('Jev icon button not rendered');
  return button;
}

export function aria(button: HTMLButtonElement): string {
  return button.getAttribute('aria-label') ?? '';
}

/** Wait until `check()` passes (observer/rAF/microtask effects). */
export async function until(check: () => boolean, message = 'condition not met'): Promise<void> {
  await vi.waitFor(
    () => {
      expect(check(), message).toBe(true);
    },
    { timeout: 2_000, interval: 5 },
  );
}

export function stopRuntime(test: RuntimeTest): void {
  test.ctx.notifyInvalidated();
}

/** Tests share one happy-dom document; drop leftover fixtures between tests. */
export function clearFeed(): void {
  document.body.replaceChildren();
}
