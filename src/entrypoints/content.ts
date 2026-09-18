import { load as loadNsfwCore, type NSFWJS } from 'nsfwjs/core';
import { MobileNetV2Model } from 'nsfwjs/models/mobilenet_v2';
import * as tf from '@tensorflow/tfjs';
import { loadSettings, saveSettings } from '../shared/settings';
import { CATEGORY_KEYS, CATEGORY_LABELS, IMAGE_KEYS, STORAGE_KEYS,
  type CategoryKey, type Settings, type JevReply, type ImageReply, type TabReport } from '../shared/types';

interface Post {
  id: string;
  author: string;
  text: string;
  urls: string[];
  fingerprint: string;
  scores: Partial<Record<CategoryKey, number>>;
  errors: string[];
  pending: boolean;
  textDone: boolean;
  imagesDone: boolean;
  scannedAt: number;
  logged: boolean;
}
interface Binding { post: Post; host: HTMLElement; root: ShadowRoot }
const posts = new Map<string, Post>();
const bindings = new Map<HTMLElement, Binding>();
const overrides = new Map<string, 'hide' | 'allow'>();
let settings: Settings;
let reviewing = false;
let modelPromise: Promise<NSFWJS> | null = null;
let imageQueue: Promise<unknown> = Promise.resolve();
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
  style.textContent = `article[data-jev-hidden]:not([data-jev-review]) { display:none!important; }
    article[data-jev-hidden][data-jev-review] > :not([data-jev-inspector]) { display:none!important; }
    article[data-jev-pending] > :not([data-jev-inspector]) { visibility:hidden!important; }
    [data-jev-inspector] { display:block!important; visibility:visible!important; }`;
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
    if (!article.isConnected) { binding.host.remove(); bindings.delete(article); }
  }
  for (const article of document.querySelectorAll<HTMLElement>('article[data-testid="tweet"]')) {
    if (article.parentElement?.closest('article[data-testid="tweet"]')) continue;
    const link = article.querySelector<HTMLAnchorElement>('a[href*="/status/"]:has(time)') ?? article.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
    const id = link?.getAttribute('href')?.match(/\/status\/(\d+)/)?.[1];
    if (!id) continue;
    const text = Array.from(article.querySelectorAll('[data-testid="tweetText"]'), node => node.textContent?.trim() ?? '').join('\n');
    // Layout dimensions may still be zero when X inserts lazy-loaded media.
    const urls = [...new Set(Array.from(article.querySelectorAll<HTMLImageElement>('img[src*="pbs.twimg.com/media"]'), img => img.currentSrc || img.src))];
    const fingerprint = JSON.stringify([text, urls]);
    let post = posts.get(id);
    if (!post || post.fingerprint !== fingerprint) {
      post = { id, text, urls, fingerprint, author: article.querySelector('[data-testid="User-Name"]')?.textContent?.trim() ?? '',
        scores: {}, errors: [], pending: false, textDone: false, imagesDone: false, scannedAt: 0, logged: false };
      posts.set(id, post);
    }
    const previous = bindings.get(article);
    if (previous?.post === post && previous.host.isConnected) continue;
    previous?.host.remove();
    const host = document.createElement('div');
    host.dataset.jevInspector = '';
    const root = host.attachShadow({ mode: 'open' });
    host.addEventListener('click', event => event.stopPropagation());
    article.append(host);
    bindings.set(article, { post, host, root });
    render(article, bindings.get(article)!);
    void scan(post);
  }
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
  renderPost(post);
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
function renderAll(): void { for (const [article, binding] of bindings) render(article, binding); }
function renderPost(post: Post): void {
  if (posts.get(post.id) !== post) return;
  for (const [article, binding] of bindings) if (binding.post === post) render(article, binding);
  if (blocked(post) && !post.logged && hits(post).length) {
    post.logged = true;
    void browser.runtime.sendMessage({ type: 'log-blocked', entry: {
      tweetId: post.id, author: post.author, snippet: post.text.slice(0, 140), surface: location.pathname.includes('/status/') ? 'status/replies' : 'timeline', ts: Date.now(), reasons: hits(post),
    } }).catch(error => { post.logged = false; post.errors.push(`Log: ${message(error)}`); });
  }
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  return node;
}
function render(article: HTMLElement, binding: Binding): void {
  const { post, root } = binding;
  const hidden = blocked(post);
  article.toggleAttribute('data-jev-hidden', hidden);
  article.toggleAttribute('data-jev-review', reviewing);
  article.toggleAttribute('data-jev-pending', settings.masterEnabled && post.pending && !overrides.has(post.id));
  const wasOpen = root.querySelector('details')?.open ?? false;
  root.replaceChildren();
  const style = element('style');
  style.textContent = `:host{font:16px/1.45 system-ui,sans-serif;color:#183044;display:block;margin:8px 0}details{background:#f3f7fb;border:1px solid #9dabb8;border-radius:6px;padding:8px 10px}summary{cursor:pointer}p{margin:8px 0}table{width:100%;border-collapse:collapse;font:inherit}td,th{text-align:left;padding:5px 3px;font-weight:400}th{font-weight:600}button{font:inherit;border:1px solid #70879a;background:white;color:#183044;border-radius:4px;padding:6px 9px;cursor:pointer}button:focus-visible,summary:focus-visible{outline:3px solid #166ac1}button:disabled{opacity:.5;cursor:default}.actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}.error{color:#9e2424;overflow-wrap:anywhere}input{width:4.5em;font:inherit}small{font:inherit}`;
  root.append(style);
  const details = element('details');
  details.open = wasOpen || (reviewing && hidden);
  const state = !settings.masterEnabled ? 'Paused' : post.pending ? 'Scanning' : hidden ? 'Blocked' : overrides.get(post.id) === 'allow' ? 'Allowed by you' : post.errors.length ? 'Not fully checked' : post.scannedAt ? 'Allowed' : 'Not scanned';
  details.append(element('summary', `Inspect filter · ${state}`));
  details.append(element('p', `${post.urls.length} image${post.urls.length === 1 ? '' : 's'} found. ${post.scannedAt ? 'Last scan ' + new Date(post.scannedAt).toLocaleTimeString() + '.' : 'No completed scan.'}`));
  if (!post.urls.length && article.querySelector('video')) details.append(element('p', 'Video frames are not scanned.'));
  for (const error of post.errors) { const line = element('p', error); line.className = 'error'; details.append(line); }
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
          } catch (error) { showError(message(error)); }
        })();
      });
      cell.append(input, document.createTextNode('%'));
    }
    row.append(cell); table.append(row);
  }
  details.append(table, element('p', 'Lower thresholds block more posts. Changes apply to the whole feed. Drawings includes ordinary anime, not just sexual images.'));
  const actions = element('div'); actions.className = 'actions';
  const showError = (text: string) => { const error = element('p', text); error.className = 'error'; details.append(error); };
  const action = (label: string, run: () => Promise<unknown>) => {
    const button = element('button', label); button.type = 'button';
    button.addEventListener('click', () => { void run().catch(error => showError(message(error))); });
    actions.append(button); return button;
  };
  action('Hide this post', () => browser.storage.local.set({ [overridePrefix + post.id]: 'hide' }));
  action('Always allow this post', () => browser.storage.local.set({ [overridePrefix + post.id]: 'allow' }));
  if (overrides.has(post.id)) action('Use automatic filtering', () => browser.storage.local.remove(overridePrefix + post.id));
  action('Retry scan', async () => { post.textDone = false; post.imagesDone = false; await scan(post); }).disabled = post.pending;
  details.append(actions, element('p', 'Post overrides are saved locally. They do not train the model.'));
  root.append(details);
}
