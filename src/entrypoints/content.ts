import { load as loadNsfwCore, type NSFWJS } from 'nsfwjs/core';
import { MobileNetV2Model } from 'nsfwjs/models/mobilenet_v2';
import * as tf from '@tensorflow/tfjs';
import { loadSettings, saveSettings } from '../shared/settings';
import { CATEGORY_KEYS, CATEGORY_LABELS, IMAGE_KEYS, TEXT_KEYS, STORAGE_KEYS,
  type CategoryKey, type Settings, type JevReply, type ImageReply, type TabReport } from '../shared/types';

interface Post {
  id: string;
  handle: string;
  author: string;
  text: string;
  urls: string[];
  previewUrl: string;
  previewText: string;
  version: number;
  partErrors: Record<'text' | 'images' | 'preview', string[]>;
  scores: Partial<Record<CategoryKey, number>>;
  previewScores: Partial<Record<CategoryKey, number>>;
  errors: string[];
  pending: boolean;
  textDone: boolean;
  imagesDone: boolean;
  previewDone: boolean;
  scannedAt: number;
  logged: boolean;
  recorded: Set<string>;
  retryCount: number;
  retryAt: number | null;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
}
interface Binding { post: Post; host: HTMLElement; root: ShadowRoot; button: HTMLButtonElement }
const posts = new Map<string, Post>();
const bindings = new Map<HTMLElement, Binding>();
const overrides = new Map<string, 'allow'>();
let settings: Settings;
let modelPromise: Promise<NSFWJS> | null = null;
let imageQueue: Promise<unknown> = Promise.resolve();
// Portal panel for the currently open inspector.
let openPostId: string | null = null;
let panelHost: HTMLElement | null = null;
let panelRoot: ShadowRoot | null = null;
let panelCountdownTimer: ReturnType<typeof setInterval> | undefined;
const overridePrefix = `${STORAGE_KEYS.overrides}:`;
/** Tracks what blocked count we last told the background for this tab. */
let lastBadgeBlocked = -1;

export default defineContentScript({
  matches: ['https://x.com/*', 'https://twitter.com/*', ...(import.meta.env.DEV ? ['http://127.0.0.1:8811/*'] : [])],
  runAt: 'document_idle',
  main() { void main(); },
});

async function main(): Promise<void> {
  settings = await loadSettings();
  const stored = await browser.storage.local.get(null);
  for (const [key, value] of Object.entries(stored)) {
    if (key.startsWith(overridePrefix) && value === 'allow') overrides.set(key.slice(overridePrefix.length), 'allow');
  }
  const style = document.createElement('style');
  style.textContent = `article[data-jev-hidden], [data-jev-card-hidden] { display:none!important; } [data-jev-card-link] { display:block; margin:8px 0; color:#1d9bf0; overflow-wrap:anywhere; }`;
  document.head.append(style);
  browser.runtime.onMessage.addListener((request) => {
    if (request?.type === 'get-report') return Promise.resolve(report());
  });
  browser.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    let changed = false;
    if (changes[STORAGE_KEYS.settings]) {
      const previous = settings;
      settings = await loadSettings();
      for (const post of posts.values()) {
        if (!settings.masterEnabled || previous.gatewayKey !== settings.gatewayKey) cancelRetry(post);
        if (previous.gatewayKey !== settings.gatewayKey) {
          post.version++;
          post.textDone = false;
          post.previewDone = false;
          post.partErrors.text = [];
          post.partErrors.preview = [];
          post.retryCount = 0;
        }
      }
      changed = true;
    }
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(overridePrefix)) continue;
      const id = key.slice(overridePrefix.length);
      if (change.newValue === 'allow') overrides.set(id, 'allow');
      else overrides.delete(id);
      changed = true;
    }
    if (changed) {
      renderAll();
      discover();
      for (const post of posts.values()) if (isAttached(post)) void scan(post);
      sendStats();
    }
  });
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; discover(); });
  };
  new MutationObserver(schedule).observe(document.body, {
    childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['src', 'srcset', 'href'],
  });
  discover();
  sendStats();
}

function discover(): void {
  for (const [article, binding] of bindings) {
    if (!article.isConnected) {
      binding.host.remove();
      bindings.delete(article);
      if (openPostId === binding.post.id) closePanel();
    }
  }
  for (const article of document.querySelectorAll<HTMLElement>('article[data-testid="tweet"]')) {
    if (article.parentElement?.closest('article[data-testid="tweet"]')) continue;
    const link = article.querySelector<HTMLAnchorElement>('a[href*="/status/"]:has(time)') ?? article.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
    const href = link?.getAttribute('href') ?? '';
    const idMatch = href.match(/\/([^/]+?)\/status\/(\d+)/);
    const id = idMatch?.[2] ?? link?.getAttribute('href')?.match(/\/status\/(\d+)/)?.[1];
    if (!id) continue;
    const handle = idMatch?.[1] ?? '';
    const text = Array.from(article.querySelectorAll('[data-testid="tweetText"]'), node => node.textContent?.trim() ?? '').join('\n');
    // X swaps image srcs as media loads; any change re-arms scanning.
    const urls = [...new Set(Array.from(article.querySelectorAll<HTMLImageElement>('img[src*="pbs.twimg.com/media"]'))
      .filter(img => !img.closest('[data-testid="card.wrapper"]')).map(img => img.currentSrc || img.src))];
    const cardImg = article.querySelector<HTMLImageElement>('[data-testid="card.wrapper"] img[src*="pbs.twimg.com"]');
    const previewUrl = cardImg?.currentSrc || cardImg?.src || '';
    const previewText = article.querySelector('[data-testid="card.wrapper"]')?.textContent?.trim() ?? '';
    let post = posts.get(id);
    if (!post) {
      post = { id, handle, author: '', text, urls, previewUrl, previewText, version: 0, partErrors: { text: [], images: [], preview: [] }, scores: {}, previewScores: {}, errors: [], pending: false, textDone: false, imagesDone: false, previewDone: false, scannedAt: 0, logged: false, recorded: new Set(), retryCount: 0, retryAt: null, retryTimer: undefined };
      posts.set(id, post);
    } else {
      if (post.text !== text || !sameUrls(post.urls, urls) || post.previewUrl !== previewUrl || post.previewText !== previewText) {
        cancelRetry(post);
        post.version++;
        post.retryCount = 0;
        if (post.text !== text) {
          post.text = text; post.textDone = false; post.partErrors.text = [];
          for (const key of TEXT_KEYS) delete post.scores[key];
        }
        if (!sameUrls(post.urls, urls)) {
          post.urls = urls; post.imagesDone = false; post.partErrors.images = [];
          for (const key of IMAGE_KEYS) delete post.scores[key];
        }
        if (post.previewUrl !== previewUrl || post.previewText !== previewText) {
          post.previewUrl = previewUrl; post.previewText = previewText; post.previewDone = false;
          post.previewScores = {}; post.partErrors.preview = [];
        }
        post.errors = Object.values(post.partErrors).flat();
      }
      if (!post.handle && handle) post.handle = handle;
    }
    post.author = article.querySelector('[data-testid="User-Name"]')?.textContent?.trim() ?? post.author;
    let binding = bindings.get(article);
    if (!binding || binding.post !== post) {
      binding?.host.remove();
      const host = document.createElement('div');
      host.dataset.jevHost = '';
      const root = host.attachShadow({ mode: 'open' });
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn';
      button.addEventListener('pointerdown', event => event.stopPropagation());
      root.append(button);
      host.addEventListener('click', event => event.stopPropagation());
      binding = { post, host, root, button };
      bindings.set(article, binding);
    }
    if (!binding.host.isConnected) insertHost(article, binding.host);
    else if (binding.host.dataset.jevSpot === 'below' && headerCarets(article).length > 0) {
      // X may add the ⋯ cluster after first paint; move up beside it.
      binding.host.remove();
      insertHost(article, binding.host);
    }
    render(article, binding);
    void scan(post);
  }
  for (const post of posts.values()) if (!isAttached(post)) cancelRetry(post);
}

function headerCarets(article: HTMLElement): HTMLElement[] {
  return Array.from(article.querySelectorAll<HTMLElement>('[data-testid="caret"]'))
    .filter(caret => !(caret.closest('article[data-testid="tweet"]')?.parentElement?.closest('article[data-testid="tweet"]')));
}

/**
 * Put the icon after the ⋯ button in the post header; posts without
 * a caret fall back to a right-aligned row under the content.
 */
function insertHost(article: HTMLElement, host: HTMLElement): void {
  const caret = headerCarets(article)[0];
  if (caret?.parentElement) {
    host.dataset.jevSpot = 'header';
    caret.parentElement.insertBefore(host, caret.nextSibling);
  } else {
    host.dataset.jevSpot = 'below';
    article.append(host);
  }
}
function sameUrls(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((url, i) => url === b[i]);
}

function timeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out.`)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

// Persistent classification cache: scores keyed by content hash so page
// reloads reuse the Jev API result for unchanged text and skip local image
// inference for images already classified. One storage key per score keeps
// concurrent tabs from clobbering each other's read-modify-write.
const CACHE_PREFIX = `${STORAGE_KEYS.scores}:`;
const CACHE_LIMIT = 4000;
let cacheWrites = 0;

/** 64-bit-ish FNV-1a + djb2 pair, base36: collisions become vanishingly unlikely. */
function hash64(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 5381;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = (Math.imul(h2, 33) ^ code) >>> 0;
  }
  return `${(h1 >>> 0).toString(36)}${h2.toString(36)}`;
}

/** Media URLs vary only by size/format params; key on the stable media id. */
function normImageUrl(url: string): string {
  return (url.split('?')[0] ?? url).toLowerCase().replace(/:[a-z0-9]+$/, '').replace(/\.(jpe?g|png|webp|gif)$/, '');
}

interface CachedScores { scores: Partial<Record<CategoryKey, number>>; ts: number }

async function readCache(key: string): Promise<CachedScores | null> {
  try {
    const stored = await browser.storage.local.get(key);
    const value = stored[key] as CachedScores | undefined;
    return value?.scores ? value : null;
  } catch { return null; }
}

function writeCache(key: string, scores: Partial<Record<CategoryKey, number>>): void {
  cacheWrites += 1;
  void browser.storage.local.set({ [key]: { scores, ts: Date.now() } }).catch(() => {});
  if (cacheWrites % 250 === 0) void evictCache();
}

async function evictCache(): Promise<void> {
  try {
    const all = await browser.storage.local.get(null);
    const entries = Object.entries(all).filter(([key]) => key.startsWith(CACHE_PREFIX));
    if (entries.length <= CACHE_LIMIT) return;
    // Keep the newest entries; drop the rest.
    const dropKeys = entries
      .sort((a, b) => ((b[1] as CachedScores)?.ts ?? 0) - ((a[1] as CachedScores)?.ts ?? 0))
      .slice(CACHE_LIMIT)
      .map(([key]) => key);
    await browser.storage.local.remove(dropKeys);
  } catch { /* cache is best-effort */ }
}

function isAttached(post: Post): boolean {
  for (const [article, binding] of bindings) if (binding.post === post && article.isConnected) return true;
  return false;
}

function cancelRetry(post: Post): void {
  clearTimeout(post.retryTimer);
  post.retryTimer = undefined;
  post.retryAt = null;
  if (post.partErrors.text.length) post.textDone = false;
  if (post.partErrors.images.length) post.imagesDone = false;
  if (post.partErrors.preview.length) post.previewDone = false;
}

function canRetry(error: string): boolean {
  return !/no .*key|401|403|unauthorized|forbidden|invalid.*key|billing|payment|insufficient/i.test(error);
}

async function textScores(post: Post, text: string): Promise<Partial<Record<CategoryKey, number>>> {
  const key = `${CACHE_PREFIX}t:${hash64(`${post.author}\n${text}`)}`;
  const cached = await readCache(key);
  if (cached) return cached.scores;
  if (!settings.gatewayKey) throw new Error('Add an AI Gateway key in the extension popup to check text.');
  const reply = await browser.runtime.sendMessage({ type: 'jev', tweetId: post.id, author: post.author, text }) as JevReply;
  if (!reply.ok) throw new Error(reply.error);
  if (![reply.sexual, reply.ai].every(score => Number.isFinite(score) && score >= 0 && score <= 1)) throw new Error('Invalid text scores');
  const scores = { sexualText: reply.sexual, aiGenerated: reply.ai };
  writeCache(key, scores);
  return scores;
}

function imageScores(urls: string[]) {
  const work = imageQueue.then(() => classifyImages(urls));
  imageQueue = work.catch(() => {});
  return work;
}

async function scan(post: Post): Promise<void> {
  if (!settings.masterEnabled || post.pending || post.retryTimer || !isAttached(post)) return;
  const textEnabled = TEXT_KEYS.some(key => settings.enabled[key]);
  const imageEnabled = IMAGE_KEYS.some(key => settings.enabled[key]);
  const textNeeded = !post.textDone && !!post.text && textEnabled;
  const imagesNeeded = !post.imagesDone && post.urls.length > 0 && imageEnabled;
  const previewNeeded = !post.previewDone && ((!!post.previewUrl && imageEnabled) || (!!post.previewText && textEnabled));
  if (!textNeeded && !imagesNeeded && !previewNeeded) return;
  const version = post.version;
  const text = post.text, urls = post.urls, previewUrl = post.previewUrl, previewText = post.previewText;
  post.pending = true;
  post.retryAt = null;
  renderPost(post);
  const run = async (part: 'text' | 'images' | 'preview', work: () => Promise<{ scores: Partial<Record<CategoryKey, number>>; errors: string[] }>) => {
    let result;
    try { result = await work(); }
    catch (error) { result = { scores: {}, errors: [message(error)] }; }
    if (post.version !== version) return;
    post.partErrors[part] = result.errors.map(error => `${part === 'text' ? 'Text' : part === 'images' ? 'Images' : 'Link preview'}: ${error}`);
    if (part === 'preview') { post.previewScores = result.scores; post.previewDone = true; }
    else {
      for (const key of part === 'text' ? TEXT_KEYS : IMAGE_KEYS) delete post.scores[key];
      Object.assign(post.scores, result.scores);
      if (part === 'text') post.textDone = true;
      else post.imagesDone = true;
    }
  };
  const jobs: Promise<void>[] = [];
  if (textNeeded) jobs.push(run('text', async () => ({ scores: await textScores(post, text), errors: [] })));
  if (imagesNeeded) jobs.push(run('images', () => imageScores(urls)));
  if (previewNeeded) jobs.push(run('preview', async () => {
    const results = await Promise.allSettled([
      previewUrl && imageEnabled ? imageScores([previewUrl]) : Promise.resolve({ scores: {}, errors: [] }),
      previewText && textEnabled ? textScores(post, previewText).then(scores => ({ scores, errors: [] as string[] })) : Promise.resolve({ scores: {}, errors: [] }),
    ]);
    const scores: Partial<Record<CategoryKey, number>> = {}, errors: string[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') { Object.assign(scores, result.value.scores); errors.push(...result.value.errors); }
      else errors.push(message(result.reason));
    }
    return { scores, errors };
  }));
  await Promise.all(jobs);
  post.pending = false;
  if (post.version !== version) { void scan(post); return; }
  post.errors = Object.values(post.partErrors).flat();
  post.scannedAt = Date.now();
  for (const error of post.errors) if (!post.recorded.has(error)) {
    post.recorded.add(error);
    void browser.runtime.sendMessage({ type: 'log-error', message: error, tweetId: post.id, handle: post.handle })
      .catch(() => post.recorded.delete(error));
  }
  const retryParts = (['text', 'images', 'preview'] as const)
    .filter(part => post.partErrors[part].some(canRetry));
  if (retryParts.length && settings.masterEnabled && isAttached(post)) {
    const delay = Math.min(4_000 * 2 ** Math.min(post.retryCount++, 4), 60_000);
    post.retryAt = Date.now() + delay;
    post.retryTimer = setTimeout(() => {
      post.retryTimer = undefined;
      post.retryAt = null;
      for (const part of retryParts) {
        if (part === 'text') post.textDone = false;
        else if (part === 'images') post.imagesDone = false;
        else post.previewDone = false;
      }
      void scan(post);
    }, delay);
  } else if (!post.errors.length) post.retryCount = 0;
  renderPost(post);
  sendStats();
}

async function classifyImages(urls: string[]): Promise<{ scores: Partial<Record<CategoryKey, number>>; errors: string[] }> {
  const scores: Partial<Record<CategoryKey, number>> = {};
  const errors: string[] = [];
  const misses: Array<{ url: string; index: number }> = [];
  for (let index = 0; index < urls.length; index++) {
    const cached = await readCache(`${CACHE_PREFIX}i:${hash64(normImageUrl(urls[index] ?? ''))}`);
    if (cached) {
      for (const [key, value] of Object.entries(cached.scores)) {
        const category = key as CategoryKey;
        scores[category] = Math.max(scores[category] ?? 0, value);
      }
    } else {
      misses.push({ url: urls[index] ?? '', index });
    }
  }
  if (!misses.length) return { scores, errors };
  const model = await loadModel();
  for (const miss of misses) {
    let bitmap: ImageBitmap | undefined;
    let pixels: tf.Tensor3D | undefined;
    try {
      bitmap = await fetchBitmap(miss.url);
      pixels = tf.browser.fromPixels(bitmap, 3);
      const predictions = await model.classify(pixels);
      const imageScores: Partial<Record<CategoryKey, number>> = {};
      for (const prediction of predictions) {
        const key = prediction.className.toLowerCase() as CategoryKey;
        if (IMAGE_KEYS.includes(key)) {
          imageScores[key] = Math.max(imageScores[key] ?? 0, prediction.probability);
          scores[key] = Math.max(scores[key] ?? 0, prediction.probability);
        }
      }
      writeCache(`${CACHE_PREFIX}i:${hash64(normImageUrl(miss.url))}`, imageScores);
    } catch (error) { errors.push(`Image ${miss.index + 1}: ${message(error)}`); }
    finally { pixels?.dispose(); bitmap?.close(); }
  }
  return { scores, errors };
}
async function fetchBitmap(url: string): Promise<ImageBitmap> {
  if (!url) throw new Error('No image URL found.');
  try {
    const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await createImageBitmap(await response.blob());
  } catch {
    const reply = await timeout(browser.runtime.sendMessage({ type: 'fetch-image', url }) as Promise<ImageReply>, 10000, 'Image download');
    if (!reply.ok) throw new Error(reply.error);
    return createImageBitmap(await (await fetch(reply.dataUrl)).blob());
  }
}
function loadModel(): Promise<NSFWJS> {
  if (!modelPromise) modelPromise = loadNsfwCore('MobileNetV2', { size: 224, modelDefinitions: [MobileNetV2Model] })
    .catch(error => { modelPromise = null; throw error; });
  return modelPromise;
}
function hits(post: Post) {
  return CATEGORY_KEYS.flatMap(key => {
    const score = post.scores[key];
    return settings.enabled[key] && score !== undefined && score >= settings.thresholds[key] ? [{ key, score }] : [];
  });
}
function previewBlocked(post: Post): boolean {
  // Fail open: only hide the preview when its own scan finished cleanly.
  if (!settings.masterEnabled || overrides.has(post.id) || post.partErrors.preview.length) return false;
  return CATEGORY_KEYS.some(key => {
    const score = post.previewScores[key];
    return settings.enabled[key] && score !== undefined && score >= settings.thresholds[key];
  });
}
function blocked(post: Post): boolean {
  if (!settings.masterEnabled) return false;
  const override = overrides.get(post.id);
  return override ? false : hits(post).length > 0;
}
function report(): TabReport {
  const values = [...posts.values()];
  return {
    analyzed: values.filter(post => Object.keys(post.scores).length > 0 || Object.keys(post.previewScores).length > 0).length,
    blocked: values.filter(post => blocked(post) || previewBlocked(post)).length,
    pending: values.filter(post => post.pending).length,
    failed: values.filter(post => post.errors.length > 0).length,
    retrying: values.filter(post => !!post.retryTimer).length,
    lastScannedAt: values.reduce((last, post) => Math.max(last, post.scannedAt), 0),
    errors: [...new Set(values.flatMap(post => post.errors))].slice(-5),
  };
}

function isDark(element: Element): boolean {
  const color = getComputedStyle(element).color;
  const parts = color.match(/\d+/g)?.slice(0, 3).map(Number) ?? [15, 20, 25];
  const [r = 15, g = 20, b = 25] = parts;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5;
}

const EYE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const BLOCKED_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.5 10.5 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.5 9.5 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

const ICON_CSS = `
:host { display: inline-flex; align-items: center; margin: 0 2px; }
:host([data-jev-spot="below"]) { display: flex; justify-content: flex-end; padding: 2px 16px 10px; }
.btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; padding: 0; margin: 0;
  border: none; border-radius: 9999px; background: transparent;
  color: var(--jev-fg, #536471); cursor: pointer; opacity: 0.75;
  position: relative; transition: opacity 0.15s;
}
.btn:hover { opacity: 1; background: var(--jev-hover); color: var(--jev-accent, #1d9bf0); }
.btn:focus-visible { outline: 2px solid var(--jev-accent, #1d9bf0); outline-offset: 2px; opacity: 1; }
.btn.pending { opacity: 0.5; }
.btn.warn::after { content: ''; position: absolute; top: 3px; right: 3px; width: 7px; height: 7px; border-radius: 50%; background: #d18808; }
`;

function sendStats() {
  const r = report();
  const blocked = r.blocked;
  if (blocked === lastBadgeBlocked) return;
  lastBadgeBlocked = blocked;
  void browser.runtime.sendMessage({ type: 'tab-stats', blocked }).catch(() => {});
}

function renderAll(): void { for (const [article, binding] of bindings) render(article, binding); }
function renderPost(post: Post): void {
  if (posts.get(post.id) !== post) return;
  for (const [article, binding] of bindings) if (binding.post === post) render(article, binding);
  if (openPostId === post.id) renderPanel(post);
  if (blocked(post) && !post.logged && hits(post).length) {
    post.logged = true;
    void browser.runtime.sendMessage({ type: 'log-blocked', entry: {
      tweetId: post.id, handle: post.handle, author: post.author, snippet: post.text.slice(0, 140), surface: location.pathname.includes('/status/') ? 'status/replies' : 'timeline', ts: Date.now(), reasons: hits(post),
    } }).catch(error => { post.logged = false; post.errors.push(`Log: ${message(error)}`); });
  }
}

function render(article: HTMLElement, binding: Binding): void {
  const { post, host, button } = binding;
  // Paused: no filter UI on the page at all.
  if (!settings.masterEnabled) {
    host.remove();
    if (openPostId === post.id) closePanel();
    return;
  }
  applyVisibility(article, binding);
  applyCard(article, post);
  if (!host.isConnected) return;
  const dark = isDark(article);
  host.style.setProperty('--jev-fg', dark ? '#71767b' : '#536471');
  host.style.setProperty('--jev-hover', dark ? 'rgba(239,243,244,0.1)' : 'rgba(15,20,25,0.05)');
  const shadow = host.shadowRoot as ShadowRoot;
  if (!shadow.querySelector('style')) {
    const style = document.createElement('style');
    style.textContent = ICON_CSS;
    shadow.prepend(style);
  }
  const icon = blocked(post) ? BLOCKED_SVG : EYE_SVG;
  button.innerHTML = icon;
  button.classList.toggle('pending', !!post.pending || !!post.retryTimer);
  button.classList.toggle('warn', post.errors.length > 0 && !post.pending);
  const stateLabel = stateOf(post);
  const retryLabel = post.retryAt ? ` — retrying in ${Math.max(0, Math.ceil((post.retryAt - Date.now()) / 1000))}s` : '';
  button.setAttribute('aria-label', `${stateLabel}${retryLabel}`);
  button.setAttribute('title', `${stateLabel}${retryLabel}`);
  button.setAttribute('aria-expanded', String(openPostId === post.id));
  button.onclick = (event) => {
    event.stopPropagation();
    if (openPostId === post.id) closePanel();
    else openPanel(post, button);
  };
}

function applyVisibility(article: HTMLElement, binding: Binding): void {
  const { post } = binding;
  if (!blocked(post)) {
    article.removeAttribute('data-jev-hidden');
    return;
  }
  article.setAttribute('data-jev-hidden', '');
}
function applyCard(article: HTMLElement, post: Post): void {
  const card = article.querySelector<HTMLElement>('[data-testid="card.wrapper"]');
  if (!card) return;
  if (previewBlocked(post)) {
    card.dataset.jevCardHidden = '';
    if (!card.previousElementSibling?.hasAttribute('data-jev-card-link')) {
      // Keep the link itself; only the preview chrome disappears.
      const link = document.createElement('a');
      link.dataset.jevCardLink = '';
      link.href = card.querySelector('a')?.href ?? '';
      link.textContent = 'Link preview hidden — open link';
      card.before(link);
    }
  } else {
    delete card.dataset.jevCardHidden;
    card.previousElementSibling?.hasAttribute('data-jev-card-link') && card.previousElementSibling.remove();
  }
}
function stateOf(post: Post): string {
  if (!settings.masterEnabled) return 'Paused';
  if (post.pending) return 'Scanning';
  if (blocked(post)) return 'Blocked';
  if (overrides.get(post.id) === 'allow') return 'Allowed by you';
  if (post.errors.length > 0) return post.retryTimer ? 'Retry scheduled' : 'Not fully checked';
  if (post.scannedAt) return 'Allowed';
  return 'Not scanned';
}

const PANEL_CSS = `
:host { all: initial; }
.panel {
  position: fixed; z-index: 999999; width: min(440px, calc(100vw - 16px));
  font: 15px/1.5 system-ui, sans-serif; color: var(--p-fg);
  background: var(--p-bg); border: 1px solid var(--p-border); border-radius: 16px;
  box-shadow: 0 8px 32px var(--p-shadow); padding: 14px 16px;
}
.head { font-weight: 700; font-size: 15px; margin-bottom: 2px; }
.meta { color: var(--p-muted); font-size: 13px; margin: 0 0 8px; }
.retry-status { font-size: 13px; color: var(--p-accent); margin: 4px 0 8px; font-weight: 500; }
.group-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--p-muted); margin: 10px 0 4px; padding-top: 6px; border-top: 1px solid var(--p-border); }
.group-label:first-of-type { border-top: none; margin-top: 0; }
table { width: 100%; border-collapse: collapse; font-size: 15px; }
td, th { text-align: left; padding: 6px 4px; font-weight: 400; border-bottom: 1px solid var(--p-border); }
th { color: var(--p-muted); font-size: 13px; font-weight: 600; }
tr:last-child td { border-bottom: none; }
input {
  width: 4.6em; font: inherit; color: inherit;
  background: transparent; border: 1px solid var(--p-border); border-radius: 8px; padding: 3px 6px;
}
input:focus-visible { outline: 2px solid var(--p-accent); }
button {
  font: inherit; font-size: 14px; font-weight: 700; cursor: pointer;
  color: var(--p-fg); background: transparent;
  border: 1px solid var(--p-border); border-radius: 9999px; padding: 6px 14px;
}
button:hover { background: var(--p-hover); }
button:disabled { opacity: 0.5; cursor: default; }
button:focus-visible, a:focus-visible { outline: 2px solid var(--p-accent); outline-offset: 2px; }
.foot { display: flex; gap: 14px; margin-top: 8px; }
a { color: var(--p-accent); text-decoration: none; font-size: 14px; font-weight: 600; }
a:hover { text-decoration: underline; }
.hint { color: var(--p-muted); font-size: 13px; margin: 6px 0 0; }
`;

let panelPos: { left: number; top: number } | null = null;
let panelSize = { width: 0, height: 0 };

function placePanel(anchor: HTMLElement): void {
  if (!panelRoot || !panelPos) return;
  const panel = panelRoot.querySelector('.panel') as HTMLElement | null;
  if (!panel) return;
  const rect = anchor.getBoundingClientRect();
  let left = Math.min(Math.max(8, rect.right - panelSize.width + 30), window.innerWidth - panelSize.width - 8);
  let top = rect.bottom + 6;
  if (top + panelSize.height > window.innerHeight - 8) top = Math.max(8, rect.top - panelSize.height - 6);
  panelPos = { left, top };
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

function openPanel(post: Post, anchor: HTMLButtonElement): void {
  closePanel();
  openPostId = post.id;
  panelHost = document.createElement('div');
  panelHost.dataset.jevPanel = '';
  panelRoot = panelHost.attachShadow({ mode: 'open' });
  document.body.append(panelHost);
  const outside = (event: Event) => {
    if (!(event.target instanceof Node)) return;
    if (panelHost?.contains(event.target) || event.composedPath().includes(anchor)) return;
    closePanel();
  };
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') closePanel(); };
  // Follow the post instead of closing: X's feed shifts constantly (new
  // posts, lazy media), so a plain scroll listener would kill the panel
  // seconds after opening. Only Escape, outside clicks, or the post
  // leaving the DOM dismiss it.
  let frame = 0;
  const onScroll = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!panelHost) return;
      if (!anchor.isConnected) { closePanel(); return; }
      placePanel(anchor);
    });
  };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll);
  (panelHost as HTMLElement & { _jevClose?: () => void })._jevClose = () => {
    if (frame) cancelAnimationFrame(frame);
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll);
  };
  renderPanel(post);
  const panel = panelRoot.querySelector('.panel') as HTMLElement;
  panelSize = { width: panel.offsetWidth, height: panel.offsetHeight };
  placePanel(anchor);
}
function closePanel(): void {
  if (!panelHost) { openPostId = null; return; }
  clearInterval(panelCountdownTimer);
  panelCountdownTimer = undefined;
  (panelHost as HTMLElement & { _jevClose?: () => void })._jevClose?.();
  panelHost.remove();
  const previous = openPostId;
  panelHost = null;
  panelRoot = null;
  panelPos = null;
  openPostId = null;
  if (previous) {
    const post = posts.get(previous);
    if (post) renderPost(post);
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  return node;
}

function renderPanel(post: Post): void {
  if (!panelRoot || openPostId !== post.id) return;
  const dark = isDark(document.body);
  const vars = dark
    ? { '--p-bg': 'rgb(21,32,43)', '--p-fg': '#e7e9ea', '--p-muted': '#71767b', '--p-border': '#2f3336', '--p-hover': 'rgba(239,243,244,0.08)', '--p-accent': '#1d9bf0', '--p-shadow': 'rgba(255,255,255,0.08)' }
    : { '--p-bg': '#ffffff', '--p-fg': '#0f1419', '--p-muted': '#536471', '--p-border': '#eff3f4', '--p-hover': 'rgba(15,20,25,0.05)', '--p-accent': '#1d9bf0', '--p-shadow': 'rgba(101,119,134,0.28)' };
  for (const [name, value] of Object.entries(vars)) panelHost!.style.setProperty(name, value);
  const wasFocus = panelRoot.activeElement?.getAttribute?.('aria-label');
  panelRoot.replaceChildren();
  const style = element('style');
  style.textContent = PANEL_CSS;
  panelRoot.append(style);
  const panel = element('div');
  panel.className = 'panel';
  const reason = hits(post).map(h => `${CATEGORY_LABELS[h.key]} ${(h.score * 100).toFixed(0)}%`).join(', ');
  const previewReason = previewBlocked(post)
    ? CATEGORY_KEYS.flatMap(key => {
      const score = post.previewScores[key];
      return settings.enabled[key] && score !== undefined && score >= settings.thresholds[key]
        ? [`${CATEGORY_LABELS[key]} ${(score * 100).toFixed(0)}%`]
        : [];
    }).join(', ')
    : '';
  const head = element('div', `${stateOf(post)}${reason ? ` · ${reason}` : ''}${previewReason && !reason ? ` · ${previewReason} (link preview)` : ''}`);
  head.className = 'head';
  const imageCount = post.urls.length + (post.previewUrl ? 1 : 0);
  const meta = element('p', `${[imageCount ? `${imageCount} image${imageCount === 1 ? '' : 's'} found` : '', post.text ? 'Text found' : ''].filter(Boolean).join(' · ') || 'Nothing to check'} · ${post.scannedAt ? `Last scan ${new Date(post.scannedAt).toLocaleTimeString()}` : 'No completed scan yet'}`);
  meta.className = 'meta';
  panel.append(head, meta);
  if (post.retryAt) {
    const secs = Math.max(0, Math.ceil((post.retryAt - Date.now()) / 1000));
    const retryLine = element('p', `Retrying in ${secs}s…`);
    retryLine.className = 'retry-status';
    panel.append(retryLine);
  }
  // Image categories — shown when post has images or an image preview.
  if (imageCount > 0) {
    const groupLabel = element('div', 'Images');
    groupLabel.className = 'group-label';
    panel.append(groupLabel);
    const imageTable = element('table');
    const heading = element('tr');
    for (const title of ['Category', 'Score', 'Block at']) heading.append(element('th', title));
    imageTable.append(heading);
    for (const key of IMAGE_KEYS) {
      imageTable.append(buildCategoryRow(post, key, { ...post.scores, ...post.previewScores }));
    }
    panel.append(imageTable);
  }
  // Text categories — shown when post has text.
  if (post.text) {
    const groupLabel = element('div', 'Text');
    groupLabel.className = 'group-label';
    panel.append(groupLabel);
    const textTable = element('table');
    const heading = element('tr');
    for (const title of ['Category', 'Score', 'Block at']) heading.append(element('th', title));
    textTable.append(heading);
    for (const key of TEXT_KEYS) {
      textTable.append(buildCategoryRow(post, key));
    }
    panel.append(textTable);
  }
  panel.append(element('p', 'Lower thresholds block more. Applies to the whole feed.'));
  const foot = element('div'); foot.className = 'foot';
  const logsLink = element('a', 'Open logs');
  logsLink.href = browser.runtime.getURL('/logs.html');
  logsLink.target = '_blank';
  logsLink.rel = 'noreferrer';
  foot.append(logsLink);
  panel.append(foot);
  const hint = element('p', 'Unblock posts from the logs page.');
  hint.className = 'hint';
  panel.append(hint);
  panelRoot.append(panel);
  if (panelPos) {
    panel.style.left = `${panelPos.left}px`;
    panel.style.top = `${panelPos.top}px`;
  }
  // Live countdown for retry timers; stops once no retry is pending.
  if (post.retryAt && !panelCountdownTimer) {
    panelCountdownTimer = setInterval(() => {
      if (!panelHost || openPostId !== post.id) { panelCountdownTimer = undefined; return; }
      if (!posts.get(post.id)?.retryAt) { clearInterval(panelCountdownTimer); panelCountdownTimer = undefined; return; }
      const current = posts.get(post.id);
      if (current) renderPanel(current);
    }, 1000);
  }
  const focusTarget = wasFocus ? panelRoot.querySelector<HTMLButtonElement>(`[aria-label="${CSS.escape(wasFocus)}"]`) : null;
  focusTarget?.focus();
}

function buildCategoryRow(post: Post, key: CategoryKey, scores: Partial<Record<CategoryKey, number>> = post.scores): HTMLElement {
  const row = element('tr');
  const score = scores[key];
  row.append(element('td', CATEGORY_LABELS[key]), element('td', score === undefined ? 'Not checked' : `${(score * 100).toFixed(1)}%`));
  const cell = element('td');
  if (!settings.enabled[key]) cell.append(element('span', 'Off'));
  else {
    const input = element('input');
    input.type = 'number'; input.min = '0'; input.max = '100'; input.step = '0.1';
    input.value = String(Number((settings.thresholds[key] * 100).toFixed(1)));
    input.setAttribute('aria-label', `${CATEGORY_LABELS[key]} threshold percent`);
    input.addEventListener('change', () => {
      if (!input.validity.valid || input.value === '') return;
      void (async () => {
        try {
          const latest = await loadSettings();
          latest.thresholds[key] = input.valueAsNumber / 100;
          await saveSettings(latest);
        } catch { /* surface through the error log */ }
      })();
    });
    cell.append(input, document.createTextNode('%'));
  }
  row.append(cell);
  return row;
}
