// Rendering and the inspector panel. Everything here owns DOM only — policy
// decisions come from state, classification from classify, and lifecycle
// wiring from runtime.
import { browser } from 'wxt/browser';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { CATEGORY_LABELS, IMAGE_KEYS, TEXT_KEYS, type CategoryKey } from '../shared/types';
import { loadSettings, saveSettings } from '../shared/settings';
import { message } from './classify';
import { headerCarets, insertHost } from './dom';
import {
  blocked,
  bindings,
  hits,
  posts,
  previewBlocked,
  previewHits,
  reviewMode,
  settings,
  stateOf,
  type Binding,
  type Post,
} from './state';

const EYE_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const BLOCKED_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.5 10.5 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.5 9.5 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

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

const GLOBAL_CSS = `article[data-jev-hidden], [data-jev-card-hidden] { display:none!important; } [data-jev-card-link] { display:block; margin:8px 0; color:#1d9bf0; overflow-wrap:anywhere; }`;

let globalStyle: HTMLStyleElement | null = null;

export function injectGlobalStyle(): void {
  if (globalStyle?.isConnected) return;
  globalStyle = document.createElement('style');
  globalStyle.setAttribute('data-jev-style', '');
  globalStyle.textContent = GLOBAL_CSS;
  document.head.append(globalStyle);
}

export function removeGlobalStyle(): void {
  globalStyle?.remove();
  globalStyle = null;
}

// --- Visibility -------------------------------------------------------------

/**
 * Undo every hiding decision: posts unhidden, link previews restored, our
 * card-link placeholders removed. Called when pausing (before scan's early
 * return), on invalidation, and per-article by the paused render branch.
 */
export function restoreAll(): void {
  for (const [article, binding] of bindings) {
    if (article.isConnected) {
      article.removeAttribute('data-jev-hidden');
      applyCard(article, binding.post, false);
    }
  }
}

function applyVisibility(article: HTMLElement, binding: Binding): void {
  const { post } = binding;
  if (!blocked(post)) {
    article.removeAttribute('data-jev-hidden');
    return;
  }
  article.setAttribute('data-jev-hidden', '');
}

function applyCard(article: HTMLElement, post: Post, hiding: boolean): void {
  const card = article.querySelector<HTMLElement>('[data-testid="card.wrapper"]');
  if (!card) return;
  if (hiding && previewBlocked(post)) {
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
    const previous = card.previousElementSibling;
    if (previous?.hasAttribute('data-jev-card-link')) previous.remove();
  }
}

// --- Button rendering -------------------------------------------------------

/** Tracks what each button points at so the capture-phase click listener can find the post. */
const buttonPosts = new WeakMap<HTMLButtonElement, Post>();

export function createBinding(post: Post): Binding {
  const host = document.createElement('div');
  host.setAttribute('data-jev-host', '');
  const root = host.attachShadow({ mode: 'open' });
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn';
  button.addEventListener('pointerdown', (event) => event.stopPropagation());
  root.append(button);
  host.addEventListener('click', (event) => event.stopPropagation());
  return { post, host, root, button };
}

export function isDark(element: Element): boolean {
  const color = getComputedStyle(element).color;
  const parts = color.match(/\d+/g)?.slice(0, 3).map(Number) ?? [15, 20, 25];
  const [r = 15, g = 20, b = 25] = parts;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5;
}

export function renderAll(): void {
  for (const [article, binding] of bindings) render(article, binding);
}

export function renderPost(post: Post): void {
  if (posts.get(post.id) !== post) return;
  for (const [article, binding] of bindings) if (binding.post === post) render(article, binding);
  if (openPostId === post.id) renderPanel(post);
  if (settings.current.masterEnabled && !reviewMode.current) {
    const postHits = hits(post);
    if (postHits.length && !post.logged) {
      post.logged = true;
      void logBlocked(post, postHits, post.text, 'post');
    }
    const previewReasons = previewHits(post);
    if (previewBlocked(post) && previewReasons.length && !post.previewLogged) {
      post.previewLogged = true;
      void logBlocked(post, previewReasons, post.previewText || post.text, 'preview');
    }
  }
}

function logBlocked(
  post: Post,
  reasons: Array<{ key: CategoryKey; score: number }>,
  snippet: string,
  target: 'post' | 'preview',
): Promise<unknown> {
  const entry = {
    tweetId: post.id,
    handle: post.handle,
    target,
    author: post.author,
    snippet: snippet.slice(0, 140),
    surface: location.pathname.includes('/status/') ? 'status/replies' : 'timeline',
    ts: Date.now(),
    reasons,
  };
  return browser.runtime.sendMessage({ type: 'log-blocked', entry }).catch((error) => {
    if (target === 'post') {
      post.logged = false;
      post.errors.push(`Log: ${message(error)}`);
    } else post.previewLogged = false;
  });
}

export function render(article: HTMLElement, binding: Binding): void {
  const { post, host, button } = binding;
  // Paused: no filter UI on the page at all — and nothing stays hidden.
  if (!settings.current.masterEnabled) {
    host.remove();
    article.removeAttribute('data-jev-hidden');
    applyCard(article, post, false);
    if (openPostId === post.id) closePanel();
    return;
  }
  if (!article.isConnected) return;
  applyVisibility(article, binding);
  applyCard(article, post, true);
  if (!host.isConnected) insertHost(article, host);
  else if (host.dataset.jevSpot === 'below' && headerCarets(article).length > 0) {
    // X may add the ⋯ cluster after first paint; move up beside it.
    host.remove();
    insertHost(article, host);
  }
  const dark = isDark(article);
  host.style.setProperty('--jev-fg', dark ? '#71767b' : '#536471');
  host.style.setProperty('--jev-hover', dark ? 'rgba(239,243,244,0.1)' : 'rgba(15,20,25,0.05)');
  const shadow = host.shadowRoot as ShadowRoot;
  if (!shadow.querySelector('style')) {
    const style = document.createElement('style');
    style.textContent = ICON_CSS;
    shadow.prepend(style);
  }
  const stateLabel = stateOf(post);
  const retryLabel = post.retryAt
    ? ` — retrying in ${Math.max(0, Math.ceil((post.retryAt - Date.now()) / 1000))}s`
    : '';
  const expanded = openPostId === post.id;
  const signature = [
    blocked(post) ? 'b' : 'e',
    String(post.pending || post.retryTimer != null),
    post.errors.length > 0 && !post.pending ? 'warn' : '',
    stateLabel,
    retryLabel,
    String(expanded),
    dark ? 'd' : 'l',
  ].join('|');
  if (binding.renderState === signature) return;
  binding.renderState = signature;
  button.innerHTML = blocked(post) ? BLOCKED_SVG : EYE_SVG;
  button.classList.toggle('pending', !!post.pending || !!post.retryTimer);
  button.classList.toggle('warn', post.errors.length > 0 && !post.pending);
  buttonPosts.set(button, post);
  button.setAttribute('aria-label', `${stateLabel}${retryLabel}`);
  button.setAttribute('title', `${stateLabel}${retryLabel}`);
  button.setAttribute('aria-expanded', String(expanded));
}

// --- Inspector panel --------------------------------------------------------

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
.errors { margin: 6px 0; padding: 0; list-style: none; }
.errors li { color: #d18808; font-size: 13px; margin: 2px 0; overflow-wrap: anywhere; }
.group-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--p-muted); margin: 10px 0 4px; padding-top: 6px; border-top: 1px solid var(--p-border); }
.group-label:first-of-type { border-top: none; margin-top: 0; }
table { width: 100%; border-collapse: collapse; font-size: 15px; }
td, th { text-align: left; padding: 6px 4px; font-weight: 400; border-bottom: 1px solid var(--p-border); }
th { color: var(--p-muted); font-size: 13px; font-weight: 600; }
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

let openPostId: string | null = null;
let panelHost: HTMLElement | null = null;
let panelRoot: ShadowRoot | null = null;
let panelAnchor: HTMLButtonElement | null = null;
let panelPos: { left: number; top: number } | null = null;
let panelSize = { width: 0, height: 0 };
let panelCountdownTimer: ReturnType<typeof setInterval> | undefined;
let panelFrame = 0;
/** data-jev-cat of the threshold input last focused inside the panel, if any. */
let panelFocusCategory: string | null = null;

export function panelOpenFor(id: string): boolean {
  return openPostId === id && !!panelHost;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  return node;
}

function placePanel(anchor: HTMLElement): void {
  if (!panelRoot) return;
  const panel = panelRoot.querySelector('.panel') as HTMLElement | null;
  if (!panel) return;
  const rect = anchor.getBoundingClientRect();
  let left = Math.min(
    Math.max(8, rect.right - panelSize.width + 30),
    window.innerWidth - panelSize.width - 8,
  );
  let top = rect.bottom + 6;
  if (top + panelSize.height > window.innerHeight - 8)
    top = Math.max(8, rect.top - panelSize.height - 6);
  panelPos = { left, top };
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

/**
 * Activation runs on a document-level capture click so X's own interception
 * handlers on timeline containers (which stop propagation during capture)
 * can never swallow the click before it reaches our button's bubble-phase
 * onclick. composedPath() crosses our shadow root and names the button.
 */
export function installActivation(ctx: ContentScriptContext): void {
  ctx.addEventListener(
    document,
    'click',
    (event: Event) => {
      if (!(event instanceof MouseEvent)) return;
      for (const node of event.composedPath()) {
        if (!(node instanceof HTMLButtonElement)) continue;
        const post = buttonPosts.get(node);
        if (!post) continue;
        event.stopPropagation();
        if (panelOpenFor(post.id)) closePanel();
        else if (node.isConnected) openPanel(post, node, ctx);
        return;
      }
    },
    { capture: true },
  );
}

function openPanel(post: Post, anchor: HTMLButtonElement, _ctx: ContentScriptContext): void {
  closePanel();
  openPostId = post.id;
  panelAnchor = anchor;
  panelFocusCategory = null;
  panelHost = document.createElement('div');
  panelHost.setAttribute('data-jev-panel', '');
  panelRoot = panelHost.attachShadow({ mode: 'open' });
  document.body.append(panelHost);
  // Keep this panel's dismissal listeners independent of script-wide
  // invalidation: each open gets its own lifetime, torn down on close.
  const panelSignals = new AbortController();
  const outside = (event: Event) => {
    if (!(event.target instanceof Node)) return;
    if (panelHost?.contains(event.target) || event.composedPath().includes(anchor)) return;
    closePanel();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    // Escape always closes and returns focus to the trigger.
    closePanel();
    anchor.focus();
  };
  // Track focus for rebuilds ourselves: shadow-root activeElement reads are
  // not portable, and only threshold inputs carry a category marker.
  const onFocus = (event: FocusEvent) => {
    if (event.target instanceof Element)
      panelFocusCategory = event.target.getAttribute('data-jev-cat');
  };
  document.addEventListener('pointerdown', outside, { capture: true, signal: panelSignals.signal });
  document.addEventListener('keydown', onKey, { capture: true, signal: panelSignals.signal });
  document.addEventListener('focusin', onFocus, { capture: true, signal: panelSignals.signal });
  // Follow the post instead of closing: X's feed shifts constantly (new
  // posts, lazy media), so a plain scroll listener would kill the panel
  // seconds after opening. Only Escape, outside clicks, or the post
  // leaving the DOM dismiss it.
  const onScroll = () => {
    if (panelFrame) return;
    panelFrame = requestAnimationFrame(() => {
      panelFrame = 0;
      if (!panelHost) return;
      if (!anchor.isConnected) {
        closePanel();
        return;
      }
      placePanel(anchor);
    });
  };
  window.addEventListener('scroll', onScroll, { capture: true, signal: panelSignals.signal });
  window.addEventListener('resize', onScroll, { signal: panelSignals.signal });
  stopPanelListeners = () => {
    panelSignals.abort();
    if (panelFrame) cancelAnimationFrame(panelFrame);
    panelFrame = 0;
  };
  renderPanel(post);
  const panel = panelRoot.querySelector('.panel') as HTMLElement;
  panelSize = { width: panel.offsetWidth, height: panel.offsetHeight };
  placePanel(anchor);
  // Keyboard users land in the panel itself, not nowhere.
  panel.focus({ preventScroll: true });
}

let stopPanelListeners: (() => void) | null = null;

function closePanel(): void {
  if (!panelHost) {
    openPostId = null;
    return;
  }
  clearInterval(panelCountdownTimer);
  panelCountdownTimer = undefined;
  stopPanelListeners?.();
  stopPanelListeners = null;
  const anchor = panelAnchor;
  panelHost.remove();
  const previous = openPostId;
  panelHost = null;
  panelRoot = null;
  panelPos = null;
  openPostId = null;
  panelAnchor = null;
  if (previous) {
    const post = posts.get(previous);
    if (post) renderPost(post);
  }
  // Return focus to the button that opened the panel (no-op when focus is
  // already elsewhere, e.g. the user clicked into another control).
  if (anchor?.isConnected && (!document.activeElement || document.activeElement === document.body))
    anchor.focus();
}

function renderPanel(post: Post): void {
  if (!panelRoot || openPostId !== post.id) return;
  const dark = isDark(document.body);
  const vars = dark
    ? {
        '--p-bg': 'rgb(21,32,43)',
        '--p-fg': '#e7e9ea',
        '--p-muted': '#71767b',
        '--p-border': '#2f3336',
        '--p-hover': 'rgba(239,243,244,0.08)',
        '--p-accent': '#1d9bf0',
        '--p-shadow': 'rgba(255,255,255,0.08)',
      }
    : {
        '--p-bg': '#ffffff',
        '--p-fg': '#0f1419',
        '--p-muted': '#536471',
        '--p-border': '#eff3f4',
        '--p-hover': 'rgba(15,20,25,0.05)',
        '--p-accent': '#1d9bf0',
        '--p-shadow': 'rgba(101,119,134,0.28)',
      };
  for (const [name, value] of Object.entries(vars)) panelHost!.style.setProperty(name, value);
  // Preserve focus across rebuilds (countdown ticks re-render the panel);
  // threshold inputs are found again by category instead of label escaping.
  const focusedCategory = panelFocusCategory;
  panelFocusCategory = null;
  panelRoot.replaceChildren();
  const style = element('style');
  style.textContent = PANEL_CSS;
  panelRoot.append(style);
  const panel = element('div');
  panel.className = 'panel';
  panel.tabIndex = -1;
  const reason = hits(post)
    .map((h) => `${CATEGORY_LABELS[h.key]} ${(h.score * 100).toFixed(0)}%`)
    .join(', ');
  const previewReason = previewBlocked(post)
    ? previewHits(post)
        .map((h) => `${CATEGORY_LABELS[h.key]} ${(h.score * 100).toFixed(0)}%`)
        .join(', ')
    : '';
  const head = element(
    'div',
    `${stateOf(post)}${reason ? ` · ${reason}` : ''}${previewReason && !reason ? ` · ${previewReason} (link preview)` : ''}`,
  );
  head.className = 'head';
  const imageCount = post.urls.length + (post.previewUrl ? 1 : 0);
  const meta = element(
    'p',
    `${[imageCount ? `${imageCount} image${imageCount === 1 ? '' : 's'} found` : '', post.text ? 'Text found' : ''].filter(Boolean).join(' · ') || 'Nothing to check'} · ${post.scannedAt ? `Last scan ${new Date(post.scannedAt).toLocaleTimeString()}` : 'No completed scan yet'}`,
  );
  meta.className = 'meta';
  panel.append(head, meta);
  if (post.retryAt) {
    panel.append(retryLine(post));
  }
  // Surface scan errors so failures are visible, not just a warn dot.
  const errors = [...new Set(post.errors)];
  if (errors.length) {
    const list = element('ul');
    list.className = 'errors';
    for (const error of errors) list.append(element('li', `⚠ ${error}`));
    panel.append(list);
  }
  // Text categories — shown when the post has text and the category is enabled.
  const visibleTextKeys = TEXT_KEYS.filter((key) => settings.current.enabled[key]);
  if (post.text && visibleTextKeys.length > 0) {
    const groupLabel = element('div', 'Text');
    groupLabel.className = 'group-label';
    panel.append(groupLabel);
    const textTable = element('table');
    const heading = element('tr');
    for (const title of ['Category', 'Score', 'Block at']) heading.append(element('th', title));
    textTable.append(heading);
    for (const key of visibleTextKeys) {
      textTable.append(buildCategoryRow(post, key));
    }
    panel.append(textTable);
  }
  const visibleImageKeys = IMAGE_KEYS.filter((key) => settings.current.enabled[key]);
  // Image categories disabled in the popup are not relevant in this inspector.
  if (imageCount > 0 && visibleImageKeys.length > 0) {
    const groupLabel = element('div', 'Images');
    groupLabel.className = 'group-label';
    panel.append(groupLabel);
    const imageTable = element('table');
    const heading = element('tr');
    for (const title of ['Category', 'Score', 'Block at']) heading.append(element('th', title));
    imageTable.append(heading);
    for (const key of visibleImageKeys) {
      imageTable.append(buildCategoryRow(post, key, { ...post.scores, ...post.previewScores }));
    }
    panel.append(imageTable);
  }
  panel.append(element('p', 'Lower thresholds block more. Applies to the whole feed.'));
  const foot = element('div');
  foot.className = 'foot';
  // Page contexts cannot open chrome-extension:// URLs by navigation — ask
  // the privileged background to open the logs page. The link role stays so
  // assistive tech and the URL still describe the destination.
  const logsLink = element('a', 'Open logs');
  logsLink.href = browser.runtime.getURL('/logs.html');
  logsLink.target = '_blank';
  logsLink.rel = 'noreferrer';
  logsLink.addEventListener('click', (event) => {
    event.preventDefault();
    void browser.runtime.sendMessage({ type: 'open-logs', errors: false }).catch(() => {});
  });
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
  if (focusedCategory) {
    const restored = panelRoot.querySelector<HTMLInputElement>(
      `[data-jev-cat="${focusedCategory}"]`,
    );
    restored?.focus();
  }
  // Live countdown for retry timers; stops once no retry is pending.
  clearInterval(panelCountdownTimer);
  panelCountdownTimer = undefined;
  if (post.retryAt) {
    panelCountdownTimer = setInterval(() => {
      const current = posts.get(post.id);
      if (!panelHost || openPostId !== post.id || !current) {
        clearInterval(panelCountdownTimer);
        panelCountdownTimer = undefined;
        return;
      }
      if (!current.retryAt) renderPanel(current);
      else
        panelRoot?.querySelector<HTMLElement>('.retry-status')?.replaceChildren(retryText(current));
    }, 1000);
  }
}

function retryLine(post: Post): HTMLElement {
  const line = element('p');
  line.className = 'retry-status';
  line.replaceChildren(retryText(post));
  return line;
}

function retryText(post: Post): Text {
  const secs = Math.max(0, Math.ceil(((post.retryAt ?? 0) - Date.now()) / 1000));
  return document.createTextNode(`Retrying in ${secs}s…`);
}

function buildCategoryRow(
  post: Post,
  key: CategoryKey,
  scores: Partial<Record<CategoryKey, number>> = post.scores,
): HTMLElement {
  const row = element('tr');
  const score = scores[key];
  row.append(
    element('td', CATEGORY_LABELS[key]),
    element('td', score === undefined ? 'Not checked' : `${(score * 100).toFixed(1)}%`),
  );
  const cell = element('td');
  const input = element('input');
  input.type = 'number';
  input.min = '0';
  input.max = '100';
  input.step = '0.1';
  input.value = String(Number((settings.current.thresholds[key] * 100).toFixed(1)));
  input.setAttribute('aria-label', `${CATEGORY_LABELS[key]} threshold percent`);
  input.setAttribute('data-jev-cat', key);
  input.addEventListener('change', () => {
    if (!input.validity.valid || input.value === '') return;
    void (async () => {
      try {
        const latest = await loadSettings();
        latest.thresholds[key] = input.valueAsNumber / 100;
        await saveSettings(latest);
      } catch {
        /* surface through the error log */
      }
    })();
  });
  cell.append(input, document.createTextNode('%'));
  row.append(cell);
  return row;
}

export function closePanelIfOpen(): void {
  if (panelHost) closePanel();
}

// --- Teardown ---------------------------------------------------------------

/** Remove every trace of injected UI and hiding. Used on invalidation. */
export function removeAllUI(): void {
  closePanelIfOpen();
  for (const [article, binding] of bindings) {
    binding.host.remove();
    article.removeAttribute('data-jev-hidden');
    applyCard(article, binding.post, false);
  }
  bindings.clear();
  removeGlobalStyle();
}
