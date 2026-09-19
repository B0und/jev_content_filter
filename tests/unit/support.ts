// Shared harness for content runtime unit tests. Tests drive the real
// runtime (startContentFilter + ContentScriptContext) over WXT fake storage
// and a fake background listening on real runtime.onMessage. External
// compute (Jev gateway, NSFWJS/tfjs) is mocked here; decisions and storage
// stay real.
import { expect, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import { ContentScriptContext } from 'wxt/utils/content-script-context';
import {
  defaultSettings,
  STORAGE_KEYS,
  type BlockedEntry,
  type JevReply,
  type Settings,
  type TabReport,
} from '../../src/shared/types';
import { newPost, type Post } from '../../src/content/state';

/** A minimal Post for direct classify-module calls. */
export function newPostStub(id: string, text = `text ${id}`): Post {
  return newPost(id, `user${id}`, text, [], '', '');
}

// NSFWJS + TF are heavy and external; replaced with a controllable stub.
const nsfw = vi.hoisted(() => ({
  predictions: [] as Array<{ className: string; probability: number }>,
  loadCount: 0,
}));
vi.mock('nsfwjs/core', () => ({
  load: async () => {
    nsfw.loadCount += 1;
    return { classify: async () => nsfw.predictions };
  },
}));
vi.mock('nsfwjs/models/mobilenet_v2', () => ({ MobileNetV2Model: class {} }));
vi.mock('@tensorflow/tfjs', () => ({
  browser: { fromPixels: () => ({ dispose: () => {} }) },
}));
// No network in unit tests: image downloads and bitmap decode are stubbed;
// inference itself comes from the NSFWJS stub above.
vi.stubGlobal(
  'fetch',
  vi.fn(async () => ({ ok: true, blob: async () => ({}) })),
);
vi.stubGlobal(
  'createImageBitmap',
  vi.fn(async () => ({ close: () => {} })),
);

export { browser, fakeBrowser, ContentScriptContext };
/** Read/write view on the NSFWJS stub (same object the mock returns). */
export const nsfwProbe = nsfw;

export function baseSettings(overrides: Partial<Settings> = {}): Settings {
  const base = defaultSettings();
  return {
    ...base,
    ...overrides,
    enabled: { ...base.enabled, ...overrides.enabled },
    thresholds: { ...base.thresholds, ...overrides.thresholds },
  };
}

export interface FakeBackground {
  /** Replies for 'jev'; replaced per test. May return a promise. */
  respond: (request: { tweetId: string; text: string }) => JevReply | Promise<JevReply>;
  jevCalls: Array<{ tweetId: string; text: string }>;
  blockedEntries: BlockedEntry[];
  loggedErrors: string[];
  openLogs: Array<{ errors: boolean }>;
  stats: number[];
}

export function installFakeBackground(): FakeBackground {
  const bg: FakeBackground = {
    respond: () => ({ ok: true, sexual: 0.01, ai: 0.01 }),
    jevCalls: [],
    blockedEntries: [],
    loggedErrors: [],
    openLogs: [],
    stats: [],
  };
  // fakeBrowser messaging delivers a response only through sendResponse
  // combined with a literal `true` return (callback style).
  browser.runtime.onMessage.addListener(
    (request: unknown, _sender, sendResponse: (value: unknown) => void) => {
      const type = (request as { type?: string } | null)?.type;
      if (type === 'jev') {
        const req = request as { tweetId: string; text: string };
        bg.jevCalls.push(req);
        void (async () => {
          sendResponse(await bg.respond(req));
        })();
        return true;
      }
      if (type === 'log-blocked') {
        bg.blockedEntries.push((request as { entry: BlockedEntry }).entry);
        sendResponse({ ok: true });
        return true;
      }
      if (type === 'log-error') {
        bg.loggedErrors.push((request as { message: string }).message);
        sendResponse({ ok: true });
        return true;
      }
      if (type === 'open-logs') {
        bg.openLogs.push(request as { errors: boolean });
        sendResponse({ ok: true });
        return true;
      }
      if (type === 'tab-stats') {
        bg.stats.push((request as { blocked: number }).blocked);
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
  // Realistic default: a gateway key must be present for text checks.
  await browser.storage.local.set({
    [STORAGE_KEYS.settings]: baseSettings({ gatewayKey: 'test-key', ...settingsOverrides }),
  });
  const bg = installFakeBackground();
  const ctx = new ContentScriptContext('test');
  // Imported here so the vi.mock registrations above mock the NSFWJS/TF
  // modules before the runtime (and its heavy deps) is ever loaded.
  const { startContentFilter } = await import('../../src/content/runtime');
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
