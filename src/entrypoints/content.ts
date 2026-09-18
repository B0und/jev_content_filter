import { load as loadNsfwCore, type NSFWJS } from 'nsfwjs/core';
import { MobileNetV2Model } from 'nsfwjs/models/mobilenet_v2';
import * as tf from '@tensorflow/tfjs';
import { appendScanError } from '../shared/log';
import { loadSettings, saveSettings } from '../shared/settings';
import { CATEGORY_KEYS, CATEGORY_LABELS, IMAGE_KEYS, STORAGE_KEYS,
  type CategoryKey, type Settings, type JevReply, type ImageReply, type TabReport } from '../shared/types';

interface Post {
  id: string;
  author: string;
  text: string;
  urls: string[];
  scores: Partial<Record<CategoryKey, number>>;
  errors: string[];
  pending: boolean;
  textDone: boolean;
  imagesDone: boolean;
  scannedAt: number;
  logged: boolean;
  recorded: Set<string>;
  textRetries: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
}
interface Binding { post: Post; host: HTMLElement; root: ShadowRoot; button: HTMLButtonElement; observer: IntersectionObserver | null }
const posts = new Map<string, Post>();
const bindings = new Map<HTMLElement, Binding>();
const overrides = new Map<string, 'hide' | 'allow'>();
let settings: Settings;
let reviewing = false;
let modelPromise: Promise<NSFWJS> | null = null;
let imageQueue: Promise<unknown> = Promise.resolve();
// Portal panel for the currently open inspector.
let openPostId: string | null = null;
let panelHost: HTMLElement | null = null;
let panelRoot: ShadowRoot | null = null;
const overridePrefix = `${STORAGE_KEYS.overrides}:`;

export default defineContentScript({
  matches: ['https://x.com/*', 'https://twitter.com/*', ...(import.meta.env.DEV ? ['http://127.0.0.1:8811/*'] : [])],
  runAt: 'document_idle',
  main() { void main(); },
});

async function main(): Promise<void> {
  settings = await loadSettings();
  const stored = await browser.storage.local.get(null);
  for (const [key, value] of Object.entries(stored)) {
    if (key.startsWith(overridePrefix) && (value === 'hide' || value === 'allow')) overrides.set(key.slice(overridePrefix.length), value);
  }
  const style = document.createElement('style');
  style.textContent = `article[data-jev-hidden]:not([data-jev-review]) { display:none!important; }`;
  document.head.append(style);
  browser.runtime.onMessage.addListener((request) => {
    if (request?.type === 'get-report') return Promise.resolve(report());
    if (request?.type === 'review-posts') {
      reviewing = request.enabled === true;
      renderAll();
      return Promise.resolve(report());
    }
    if (request?.type === 'rescan') {
      for (const post of posts.values()) if (!post.pending) { post.textDone = false; post.imagesDone = false; void scan(post); }
      return Promise.resolve(report());
    }
  });
  browser.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    let changed = false;
    if (changes[STORAGE_KEYS.settings]) { settings = await loadSettings(); changed = true; }
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(overridePrefix)) continue;
      const id = key.slice(overridePrefix.length);
      if (change.newValue === 'hide' || change.newValue === 'allow') overrides.set(id, change.newValue);
      else overrides.delete(id);
      changed = true;
    }
    if (changed) {
      renderAll();
      discover();
      for (const post of posts.values()) void scan(post);
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
    const id = link?.getAttribute('href')?.match(/\/status\/(\d+)/)?.[1];
    if (!id) continue;
    const text = Array.from(article.querySelectorAll('[data-testid="tweetText"]'), node => node.textContent?.trim() ?? '').join('\n');
    // X swaps image srcs as media loads; any change re-arms scanning.
    const urls = [...new Set(Array.from(article.querySelectorAll<HTMLImageElement>('img[src*="pbs.twimg.com/media"]'), img => img.currentSrc || img.src))];
    let post = posts.get(id);
    if (!post) {
      post = { id, author: '', text, urls, scores: {}, errors: [], pending: false, textDone: false, imagesDone: false, scannedAt: 0, logged: false, recorded: new Set(), textRetries: 0, retryTimer: null };
      posts.set(id, post);
    } else {
      if (post.text !== text) { post.text = text; post.textDone = false; }
      if (!sameUrls(post.urls, urls)) { post.urls = urls; post.imagesDone = false; }
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
      article.append(host);
      binding = { post, host, root, button, observer: null };
      bindings.set(article, binding);
    }
    render(article, binding);
    void scan(post);
  }
}
function sameUrls(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((url, i) => url === b[i]);
}

function timeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out. Retry scans.`)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

async function scan(post: Post): Promise<void> {
  if (!settings.masterEnabled || post.pending) return;
  const textNeeded = !post.textDone && !!post.text && (settings.enabled.sexualText || settings.enabled.aiGenerated);
  const imagesNeeded = !post.imagesDone && post.urls.length > 0 && IMAGE_KEYS.some(key => settings.enabled[key]);
  if (!textNeeded && !imagesNeeded) return;
  post.pending = true;
  post.errors = [];
  renderPost(post);
  const jobs: Promise<void>[] = [];
  if (textNeeded) jobs.push((async () => {
    try {
      if (!settings.gatewayKey) throw new Error('No AI Gateway key. Text was not checked; image filtering runs locally.');
      const reply = await timeout(browser.runtime.sendMessage({ type: 'jev', tweetId: post.id, author: post.author, text: post.text }) as Promise<JevReply>, 12000, 'Text scan');
      if (!reply.ok) throw new Error(reply.error);
      if (![reply.sexual, reply.ai].every(score => Number.isFinite(score) && score >= 0 && score <= 1)) throw new Error('Invalid text scores');
      post.scores.sexualText = reply.sexual;
      post.scores.aiGenerated = reply.ai;
    } catch (error) { post.errors.push(`Text: ${message(error)}`); }
    finally { post.textDone = true; }
  })());
  if (imagesNeeded) jobs.push((async () => {
    try {
      const work = imageQueue.then(() => classifyImages(post.urls));
      imageQueue = work.catch(() => {});
      const result = await timeout(work, 30000, 'Image scan');
      Object.assign(post.scores, result.scores);
      post.errors.push(...result.errors);
    } catch (error) { post.errors.push(`Images: ${message(error)}`); }
    finally { post.imagesDone = true; }
  })());
  await Promise.all(jobs);
  post.pending = false;
  post.scannedAt = Date.now();
  for (const text of post.errors) {
    if (!post.recorded.has(text)) {
      post.recorded.add(text);
      void appendScanError(text).catch(() => {});
    }
  }
  renderPost(post);
  // Quota walls reset over time: re-arm the text scan so late posts get
  // filtered as the limits allow, instead of failing silently forever.
  if (post.errors.some(text => /429|rate.?limit/i.test(text)) && post.textRetries < 5 && !post.retryTimer) {
    post.textRetries += 1;
    post.textDone = false;
    post.retryTimer = setTimeout(() => {
      post.retryTimer = null;
      void scan(post);
    }, 45_000);
  }
}

async function classifyImages(urls: string[]) {
  const scores: Partial<Record<CategoryKey, number>> = {};
  const errors: string[] = [];
  const model = await loadModel();
  for (let index = 0; index < urls.length; index++) {
    let bitmap: ImageBitmap | undefined;
    let pixels: tf.Tensor3D | undefined;
    try {
      bitmap = await fetchBitmap(urls[index] ?? '');
      pixels = tf.browser.fromPixels(bitmap, 3);
      const predictions = await model.classify(pixels);
      for (const prediction of predictions) {
        const key = prediction.className.toLowerCase() as CategoryKey;
        if (IMAGE_KEYS.includes(key)) scores[key] = Math.max(scores[key] ?? 0, prediction.probability);
      }
    } catch (error) { errors.push(`Image ${index + 1}: ${message(error)}`); }
    finally { pixels?.dispose(); bitmap?.close(); }
  }
  return { scores, errors };
}
async function fetchBitmap(url: string): Promise<ImageBitmap> {
  if (!url) throw new Error('No image URL found; retry the scan.');
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
function blocked(post: Post): boolean {
  if (!settings.masterEnabled) return false;
  const override = overrides.get(post.id);
  return override ? override === 'hide' : hits(post).length > 0;
}
function report(): TabReport {
  const values = [...posts.values()];
  return {
    analyzed: values.filter(post => Object.keys(post.scores).length > 0).length,
    blocked: values.filter(blocked).length,
    pending: values.filter(post => post.pending).length,
    failed: values.filter(post => post.errors.length > 0).length,
    lastScannedAt: values.reduce((last, post) => Math.max(last, post.scannedAt), 0),
    errors: [...new Set(values.flatMap(post => post.errors))].slice(-5), reviewing,
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
const WARN_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 2 1 21h22L12 2zm1 14h-2v2h2v-2zm0-7h-2v5h2V9z"/></svg>';
const SPIN_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke-dasharray="42 15"/></svg>';

const ICON_CSS = `
:host { display: flex; justify-content: flex-end; align-items: center; padding: 2px 16px 10px; }
.btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; padding: 0; margin: 0;
  border: none; border-radius: 9999px; background: transparent;
  color: var(--jev-fg, #536471); cursor: pointer; opacity: 0.75;
}
.btn:hover { opacity: 1; background: var(--jev-hover); color: var(--jev-accent, #1d9bf0); }
.btn:focus-visible { outline: 2px solid var(--jev-accent, #1d9bf0); outline-offset: 2px; opacity: 1; }
.btn.warn { color: #d18808; opacity: 1; }
.btn.warn:hover { color: #d18808; background: var(--jev-hover); }
.spin { animation: jev-rot 0.9s linear infinite; }
@keyframes jev-rot { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
`;

function renderAll(): void { for (const [article, binding] of bindings) render(article, binding); }
function renderPost(post: Post): void {
  if (posts.get(post.id) !== post) return;
  for (const [article, binding] of bindings) if (binding.post === post) render(article, binding);
  if (openPostId === post.id) renderPanel(post);
  if (blocked(post) && !post.logged && hits(post).length) {
    post.logged = true;
    void browser.runtime.sendMessage({ type: 'log-blocked', entry: {
      tweetId: post.id, author: post.author, snippet: post.text.slice(0, 140), surface: location.pathname.includes('/status/') ? 'status/replies' : 'timeline', ts: Date.now(), reasons: hits(post),
    } }).catch(error => { post.logged = false; post.errors.push(`Log: ${message(error)}`); });
  }
}

function render(article: HTMLElement, binding: Binding): void {
  const { post, host, button } = binding;
  article.toggleAttribute('data-jev-review', reviewing);
  applyVisibility(article, binding);
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
  const icon = post.pending ? SPIN_SVG : blocked(post) ? BLOCKED_SVG : post.errors.length > 0 ? WARN_SVG : EYE_SVG;
  button.innerHTML = icon;
  const spinner = button.querySelector('svg');
  if (post.pending && spinner) spinner.classList.add('spin');
  if (post.errors.length > 0) button.classList.add('warn');
  else button.classList.remove('warn');
  button.setAttribute('aria-label', `Inspect filter for this post: ${stateOf(post)}`);
  button.setAttribute('aria-expanded', String(openPostId === post.id));
  button.onclick = (event) => {
    event.stopPropagation();
    if (openPostId === post.id) closePanel();
    else openPanel(post, button);
  };
}

/**
 * Visibility policy: never yank a post the user is looking at. Blocked posts
 * below the fold (or explicitly hidden by the user) disappear immediately;
 * onscreen ones defer their hide until they scroll out of the viewport, so
 * the timeline never jumps.
 */
function applyVisibility(article: HTMLElement, binding: Binding): void {
  const { post, observer } = binding;
  if (!blocked(post) || reviewing) {
    observer?.disconnect();
    binding.observer = null;
    article.removeAttribute('data-jev-hidden');
    return;
  }
  if (overrides.get(post.id) === 'hide' || !onScreen(article)) {
    observer?.disconnect();
    binding.observer = null;
    article.setAttribute('data-jev-hidden', '');
    return;
  }
  // Onscreen: stay visible for now; hide when it leaves the viewport.
  if (!binding.observer) {
    binding.observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          binding.observer?.disconnect();
          binding.observer = null;
          if (blocked(post) && !reviewing) article.setAttribute('data-jev-hidden', '');
        }
      }
    });
    binding.observer.observe(article);
  }
}
function onScreen(article: HTMLElement): boolean {
  const rect = article.getBoundingClientRect();
  return rect.bottom > 0 && rect.top < window.innerHeight;
}
function stateOf(post: Post): string {
  if (!settings.masterEnabled) return 'Paused';
  if (post.pending) return 'Scanning';
  if (blocked(post)) return 'Blocked';
  if (overrides.get(post.id) === 'allow') return 'Allowed by you';
  if (post.errors.length > 0) return 'Not fully checked';
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
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0 4px; }
.foot { display: flex; gap: 14px; margin-top: 8px; }
a { color: var(--p-accent); text-decoration: none; font-size: 14px; font-weight: 600; }
a:hover { text-decoration: underline; }
.hint { color: var(--p-muted); font-size: 13px; margin: 6px 0 0; }
`;

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
  const onScroll = () => closePanel();
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScroll, true);
  (panelHost as HTMLElement & { _jevClose?: () => void })._jevClose = () => {
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
  };
  renderPanel(post);
  const rect = anchor.getBoundingClientRect();
  const panel = panelRoot.querySelector('.panel') as HTMLElement;
  const width = panel.offsetWidth;
  let left = Math.min(Math.max(8, rect.right - width + 30), window.innerWidth - width - 8);
  let top = rect.bottom + 6;
  if (top + panel.offsetHeight > window.innerHeight - 8) top = Math.max(8, rect.top - panel.offsetHeight - 6);
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}
function closePanel(): void {
  if (!panelHost) { openPostId = null; return; }
  (panelHost as HTMLElement & { _jevClose?: () => void })._jevClose?.();
  panelHost.remove();
  const previous = openPostId;
  panelHost = null;
  panelRoot = null;
  openPostId = null;
  if (previous) {
    const post = posts.get(previous);
    if (post) renderPost(post); // refresh aria-expanded on the icon
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
  const head = element('div', `${stateOf(post)}${reason ? ` · ${reason}` : ''}`);
  head.className = 'head';
  const meta = element('p',
    `${post.urls.length} image${post.urls.length === 1 ? '' : 's'} found · ${post.scannedAt ? `Last scan ${new Date(post.scannedAt).toLocaleTimeString()}` : 'No completed scan yet'}`);
  meta.className = 'meta';
  panel.append(head, meta);
  const table = element('table');
  const heading = element('tr');
  for (const title of ['Category', 'Score', 'Block at']) heading.append(element('th', title));
  table.append(heading);
  for (const key of CATEGORY_KEYS) {
    const row = element('tr');
    const score = post.scores[key];
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
    row.append(cell); table.append(row);
  }
  panel.append(table, element('p', 'Lower thresholds block more. Applies to the whole feed. Drawings includes ordinary anime.'));
  const actions = element('div'); actions.className = 'actions';
  const foot = element('div'); foot.className = 'foot';
  const action = (label: string, run: () => Promise<unknown>, container: HTMLElement = actions, isButton = true) => {
    if (!isButton) {
      const link = element('a', label);
      link.href = browser.runtime.getURL('/logs.html#errors');
      link.target = '_blank';
      link.rel = 'noreferrer';
      container.append(link);
      return link;
    }
    const button = element('button', label); button.type = 'button';
    button.addEventListener('click', () => { void run(); });
    container.append(button); return button;
  };
  action('Hide this post', () => browser.storage.local.set({ [overridePrefix + post.id]: 'hide' }));
  action('Always allow', () => browser.storage.local.set({ [overridePrefix + post.id]: 'allow' }));
  if (overrides.has(post.id)) action('Use automatic filtering', () => browser.storage.local.remove(overridePrefix + post.id));
  const retry = action('Retry scan', async () => { post.textDone = false; post.imagesDone = false; await scan(post); }) as HTMLButtonElement;
  retry.disabled = post.pending;
  panel.append(actions);
  action('Open error log', async () => {}, foot, false);
  const logsLink = element('a', 'Blocked log');
  logsLink.href = browser.runtime.getURL('/logs.html');
  logsLink.target = '_blank';
  logsLink.rel = 'noreferrer';
  foot.append(logsLink);
  panel.append(foot, element('p', 'Post overrides are saved locally. They do not train the model.'));
  panelRoot.append(panel);
  const focusTarget = wasFocus ? panelRoot.querySelector<HTMLButtonElement>(`[aria-label="${wasFocus}"]`) : null;
  focusTarget?.focus();
}
