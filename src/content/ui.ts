// Rendering and inspector DOM stay here; Effect values represent external
// logging requests that the content runtime owns.
import { Clock, Effect } from 'effect';
import { browserEffect, browserRuntime } from '../platform/browser';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import {
  CATEGORY_LABELS,
  scoreLabel,
  IMAGE_KEYS,
  TEXT_KEYS,
  type CategoryKey,
  type ScoreKey,
} from '../filtering/types';
import { updateSettings } from '../filtering/settings';
import { message } from './classify';
import { headerCarets, insertHost } from './dom';
import {
  blocked,
  bindings,
  hits,
  isAttached,
  posts,
  previewBlocked,
  previewHits,
  recordPageStats,
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
:host { display: inline-block; position: relative; width: 30px; height: 0; flex: 0 0 auto; align-self: center; vertical-align: middle; margin: 0 2px; }
:host([data-jev-spot="below"]) { display: block; width: auto; margin: 0 16px; }
:host([data-jev-spot="below"]) .btn { top: auto; bottom: 0; left: auto; right: 0; transform: none; }
.btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; padding: 0; margin: 0;
  border: none; border-radius: 9999px; background: transparent;
  color: var(--jev-fg, #536471); cursor: pointer; opacity: 0.75;
  position: absolute; top: 0; left: 0; transform: translateY(-50%); transition: opacity 0.15s;
}
.btn:hover { opacity: 1; background: var(--jev-hover); color: var(--jev-accent, #1d9bf0); }
.btn:focus-visible { outline: 2px solid var(--jev-accent, #1d9bf0); outline-offset: 2px; opacity: 1; }
.btn.pending { opacity: 0.5; }
.btn.warn::after { content: ''; position: absolute; top: 3px; right: 3px; width: 7px; height: 7px; border-radius: 50%; background: #d18808; }
`;

const GLOBAL_CSS = `
article[data-jev-hidden]:not([data-jev-reserved]),
[data-testid="cellInnerDiv"]:has(article[data-jev-hidden]):not([data-jev-preserved]):not(:has(article:not([data-jev-hidden]))) {
  display: none !important;
}
[data-jev-card-hidden] {
  position: relative !important;
  visibility: hidden !important;
}
[data-jev-card-hidden] > :not([data-jev-card-link]),
[data-jev-card-hidden] > :not([data-jev-card-link]) * {
  visibility: hidden !important;
}
[data-jev-card-hidden] > [data-jev-card-link] {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  padding: 8px;
  margin: 0;
  color: #1d9bf0;
  overflow-wrap: anywhere;
  visibility: visible !important;
}
article[data-jev-hidden][data-jev-reserved],
article[data-jev-hidden][data-jev-reserved] * {
  visibility: hidden !important;
}
article[data-jev-hidden] [data-jev-retained],
article[data-jev-hidden] [data-jev-retained] * {
  visibility: visible !important;
}
`;

let globalStyle: HTMLStyleElement | null = null;
// Multiple articles can share an X cell. Each slot owns one reservation.
const cellReservations = new WeakMap<HTMLElement, number>();

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
      restoreBinding(article, binding);
      applyCard(article, binding.post, false);
    }
  }
}

/** Remove owned layout reservations on pause, unblocking, recycling and teardown. */
export function restoreBinding(article: HTMLElement, binding: Binding): void {
  article.removeAttribute('data-jev-hidden');
  article.removeAttribute('data-jev-reserved');
  binding.hiddenSizeObserver?.disconnect();
  delete binding.hiddenSizeObserver;
  for (const retained of binding.retainedElements ?? [])
    retained.removeAttribute('data-jev-retained');
  delete binding.retainedElements;
  binding.hiddenSlot?.remove();
  const cell = binding.preservedCell;
  if (cell) {
    const remaining = (cellReservations.get(cell) ?? 1) - 1;
    if (remaining > 0) cellReservations.set(cell, remaining);
    else {
      cellReservations.delete(cell);
      cell.removeAttribute('data-jev-preserved');
    }
  }
  delete binding.hiddenSlot;
  delete binding.preservedCell;
}

/** Describe the active filter matches for a reserved post slot. */
function hiddenReason(post: Post): string {
  return `Hidden by ${hits(post)
    .map(
      (hit) =>
        `${scoreLabel(hit.key, settings.current.textFilters)} (${Math.round(hit.score * 100)}%)`,
    )
    .join(', ')}`;
}

/** Keep the original author header, avatar, menu and action bar accessible. */
function retainPostControls(article: HTMLElement, binding: Binding): void {
  for (const element of binding.retainedElements ?? [])
    element.removeAttribute('data-jev-retained');
  // Quotes can contain their own avatars, timestamps and action groups.
  // Retaining those would expose filtered content and shrink the body mask.
  const original = (element: HTMLElement) =>
    element.closest('article') === article &&
    !article.contains(element.closest('div[role="link"]'));
  const author = [...article.querySelectorAll<HTMLElement>('[data-testid="User-Name"]')].find(
    original,
  );
  const caret = headerCarets(article)[0];
  let header = author;
  while (header?.parentElement && header.parentElement !== article) {
    const parent = header.parentElement;
    if (
      parent.querySelector(
        '[data-testid="tweetText"], [data-testid="tweetPhoto"], video, [data-testid="card.wrapper"]',
      )
    )
      break;
    header = parent;
    if (caret && header.contains(caret)) break;
  }
  const avatar = [...article.querySelectorAll<HTMLElement>('[data-testid^="UserAvatar"]')].find(
    original,
  );
  const footer = [
    ...article.querySelectorAll<HTMLElement>('[role="group"]:has([data-testid="reply"])'),
  ].find(original);
  const timestamp = [...article.querySelectorAll<HTMLElement>('time')].find(
    (element) =>
      original(element) &&
      element.closest('a')?.getAttribute('href')?.split('/status/')[1]?.split(/[/?#]/)[0] ===
        binding.post.id,
  );
  const candidates = [header, caret, binding.host, avatar, footer, timestamp];
  binding.retainedElements = candidates.filter(
    (element): element is HTMLElement =>
      element instanceof HTMLElement && element.closest('article') === article,
  );
  for (const element of binding.retainedElements) element.dataset.jevRetained = '';
}

/** Position an out-of-flow mask between the native header and action bar. */
function placeHiddenNotice(article: HTMLElement, binding: Binding): void {
  const slot = binding.hiddenSlot;
  if (!slot?.isConnected) return;
  const rect = article.getBoundingClientRect();
  const retained = binding.retainedElements ?? [];
  const footer = retained.find((element) => element.getAttribute('role') === 'group');
  const headerBottom = Math.max(
    rect.top,
    ...retained
      .filter((element) => element !== footer && element !== binding.host)
      .map((element) => element.getBoundingClientRect().bottom),
  );
  const bottom = footer?.getBoundingClientRect().top ?? rect.bottom;
  const parent = slot.offsetParent;
  const positioned =
    parent instanceof HTMLElement &&
    (parent !== document.body || getComputedStyle(parent).position !== 'static');
  const origin = positioned ? parent.getBoundingClientRect() : null;
  const originLeft = origin
    ? origin.left + (parent?.clientLeft ?? 0) - (parent?.scrollLeft ?? 0)
    : -window.scrollX;
  const originTop = origin
    ? origin.top + (parent?.clientTop ?? 0) - (parent?.scrollTop ?? 0)
    : -window.scrollY;
  slot.style.left = `${rect.left - originLeft}px`;
  slot.style.top = `${headerBottom - originTop}px`;
  slot.style.width = `${rect.width}px`;
  const height = Math.max(0, bottom - headerBottom);
  slot.style.height = `${height}px`;
  slot.shadowRoot?.querySelector('.notice')?.classList.toggle('compact', height < 80);
}

/** Mask posts without removing their native layout, including offscreen posts. */
function applyVisibility(article: HTMLElement, binding: Binding): void {
  const { post } = binding;
  if (!blocked(post) || binding.revealed) {
    restoreBinding(article, binding);
    if (!blocked(post)) binding.revealed = false;
    return;
  }
  if (!article.hasAttribute('data-jev-hidden')) {
    const slot = document.createElement('div');
    slot.dataset.jevHiddenSlot = '';
    // Keep the real article in layout so media and responsive text continue
    // to measure normally. The notice overlays it without adding height.
    slot.style.cssText = 'position: absolute; pointer-events: none;';
    article.dataset.jevReserved = '';
    const cell = article.closest<HTMLElement>('[data-testid="cellInnerDiv"]');
    if (cell) {
      cellReservations.set(cell, (cellReservations.get(cell) ?? 0) + 1);
      cell.dataset.jevPreserved = '';
      binding.preservedCell = cell;
    }
    const root = slot.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `:host { display: block; } .notice { pointer-events: auto; width: 100%; height: 100%; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 12px; color: var(--jev-muted); background: var(--jev-bg); font: 13px/1.4 system-ui, sans-serif; text-align: center; overflow: hidden; } .notice.compact { flex-direction: row; gap: 6px; padding: 0; font-size: 12px; } .compact p { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 70%; } .compact button { padding: 0 6px; line-height: 1.2; } p { margin: 0; overflow-wrap: anywhere; } button { font: inherit; color: #1d9bf0; background: transparent; border: 1px solid currentColor; border-radius: 999px; padding: 5px 14px; cursor: pointer; } button:focus-visible { outline: 2px solid #1d9bf0; outline-offset: 3px; }`;
    const notice = document.createElement('div');
    notice.className = 'notice';
    const reason = document.createElement('p');
    reason.textContent = hiddenReason(post);
    const show = document.createElement('button');
    show.type = 'button';
    show.textContent = 'Show post';
    revealActions.set(show, () => {
      binding.revealed = true;
      renderPostAtUiBoundary(post);
      binding.button.focus({ preventScroll: true });
    });
    notice.append(reason, show);
    root.append(style, notice);
    slot.style.setProperty('--jev-muted', isDark(article) ? '#a3abb2' : '#536471');
    slot.style.setProperty('--jev-bg', isDark(article) ? '#10171c' : '#f7f9f9');
    article.before(slot);
    binding.hiddenSlot = slot;
    retainPostControls(article, binding);
    const sizeObserver = new ResizeObserver(() => placeHiddenNotice(article, binding));
    sizeObserver.observe(article);
    const parent = slot.offsetParent;
    if (parent instanceof HTMLElement) sizeObserver.observe(parent);
    binding.hiddenSizeObserver = sizeObserver;
    placeHiddenNotice(article, binding);
    article.setAttribute('data-jev-hidden', '');
  }
  retainPostControls(article, binding);
  placeHiddenNotice(article, binding);
  const reason = binding.hiddenSlot?.shadowRoot?.querySelector('p');
  if (reason && reason.textContent !== hiddenReason(post)) reason.textContent = hiddenReason(post);
}

function applyCard(article: HTMLElement, post: Post, hiding: boolean): void {
  const card = article.querySelector<HTMLElement>('[data-testid="card.wrapper"]');
  if (!card) return;
  if (hiding && previewBlocked(post)) {
    card.dataset.jevCardHidden = '';
    if (!card.querySelector('[data-jev-card-link]')) {
      // Keep the card's layout box and put the link over its hidden contents.
      const link = document.createElement('a');
      link.dataset.jevCardLink = '';
      link.href = card.querySelector('a')?.href ?? '';
      link.textContent = 'Link preview hidden — open link';
      card.append(link);
    }
  } else {
    card.removeAttribute('data-jev-card-hidden');
    const link = card.querySelector('[data-jev-card-link]');
    link?.remove();
  }
}

// --- Button rendering -------------------------------------------------------

/** Tracks what each button points at so the capture-phase click listener can find the post. */
const buttonPosts = new WeakMap<HTMLButtonElement, Post>();
const revealActions = new WeakMap<HTMLButtonElement, () => void>();

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
  const openPost = openPostId ? posts.get(openPostId) : undefined;
  if (openPost) renderPanel(openPost);
}

export function renderPost(post: Post): Array<Effect.Effect<void>> {
  if (posts.get(post.id) !== post) return [];
  for (const [article, binding] of bindings) if (binding.post === post) render(article, binding);
  if (openPostId === post.id) renderPanel(post);
  return logEffects(post);
}

/**
 * Log effects for content this moment counts as blocked. Only hidden content is
 * logged: an opened or allowed post is not a block, and its row would have
 * nothing to unblock. Visibility can change without a scan — the URL starts or
 * stops addressing the post, or a threshold change re-blocks existing scores —
 * so discovery dispatches these on every pass.
 */
export function logEffects(post: Post): Array<Effect.Effect<void>> {
  if (!isAttached(post)) return [];
  const effects: Array<Effect.Effect<void>> = [];
  if (blocked(post) && !post.logged) {
    post.logged = true;
    effects.push(logBlocked(post, hits(post), post.text, 'post'));
  }
  if (previewBlocked(post) && !post.previewLogged) {
    post.previewLogged = true;
    effects.push(logBlocked(post, previewHits(post), post.previewText || post.text, 'preview'));
  }
  return effects;
}

function renderPostAtUiBoundary(post: Post): void {
  for (const effect of renderPost(post)) {
    void browserRuntime.runPromise(effect).catch((error: unknown) => {
      console.error('Content logging effect failed', error);
    });
  }
}

function logBlocked(
  post: Post,
  reasons: Array<{ key: ScoreKey; label?: string; score: number }>,
  snippet: string,
  target: 'post' | 'preview',
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const entry = {
      tweetId: post.id,
      handle: post.handle,
      target,
      author: post.author,
      snippet: snippet.slice(0, 140),
      surface: location.pathname.includes('/status/') ? 'status/replies' : 'timeline',
      ts: yield* Clock.currentTimeMillis,
      reasons,
    };
    yield* browserEffect('log blocked content', () =>
      browser.runtime.sendMessage({ type: 'log-blocked', entry }),
    ).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          if (target === 'post') {
            post.logged = false;
            post.errors.push(`Log: ${message(error)}`);
          } else post.previewLogged = false;
        }),
      ),
    );
  });
}

function setHostVisibility(host: HTMLElement, button: HTMLButtonElement, visible: boolean): void {
  host.style.visibility = visible ? '' : 'hidden';
  host.style.pointerEvents = visible ? '' : 'none';
  if (visible) {
    host.removeAttribute('aria-hidden');
    button.removeAttribute('tabindex');
  } else {
    host.setAttribute('aria-hidden', 'true');
    button.tabIndex = -1;
  }
}

/** Refresh a bound post toolbar and visibility from its current classification. */
export function render(article: HTMLElement, binding: Binding): void {
  const { post, host, root, button } = binding;
  // Paused: keep the invisible control slot so toggling cannot reflow the feed.
  if (!settings.current.masterEnabled) {
    setHostVisibility(host, button, false);
    restoreBinding(article, binding);
    applyCard(article, post, false);
    if (openPostId === post.id) closePanel();
    return;
  }
  if (!article.isConnected) return;
  recordPageStats(post);
  setHostVisibility(host, button, true);
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
  const shadow = root;
  if (!shadow.querySelector('style')) {
    const style = document.createElement('style');
    style.textContent = ICON_CSS;
    shadow.prepend(style);
  }
  const stateLabel = binding.revealed && blocked(post) ? 'Shown temporarily' : stateOf(post);
  const retryLabel = post.retryAt
    ? ` — retrying in ${Math.max(0, Math.ceil((post.retryAt - Date.now()) / 1000))}s`
    : '';
  const expanded = openPostId === post.id;
  const signature = [
    blocked(post) ? 'b' : 'e',
    String(post.pending || post.retryAt !== null),
    post.errors.length > 0 && !post.pending ? 'warn' : '',
    stateLabel,
    retryLabel,
    String(expanded),
    dark ? 'd' : 'l',
  ].join('|');
  if (binding.renderState === signature) return;
  binding.renderState = signature;
  button.innerHTML = blocked(post) && !binding.revealed ? BLOCKED_SVG : EYE_SVG;
  button.classList.toggle('pending', !!post.pending || post.retryAt !== null);
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
  const panel = panelRoot.querySelector('.panel');
  if (!(panel instanceof HTMLElement)) return;
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
        const reveal = revealActions.get(node);
        if (reveal) {
          event.stopPropagation();
          reveal();
          return;
        }
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
  const host = document.createElement('div');
  host.setAttribute('data-jev-panel', '');
  const root = host.attachShadow({ mode: 'open' });
  panelHost = host;
  panelRoot = root;
  document.body.append(host);
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
    anchor.focus({ preventScroll: true });
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
  // Dismiss immediately when the feed scrolls, while allowing the inspector's
  // own contents to scroll. Wheel/touch intent also dismisses at feed edges.
  const dismissOnScroll = (event: Event) => {
    if (event.composedPath().includes(host)) return;
    closePanel();
  };
  const onResize = () => {
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
  for (const type of ['scroll', 'wheel', 'touchmove'])
    window.addEventListener(type, dismissOnScroll, {
      capture: true,
      passive: true,
      signal: panelSignals.signal,
    });
  window.addEventListener('resize', onResize, { signal: panelSignals.signal });
  stopPanelListeners = () => {
    panelSignals.abort();
    if (panelFrame) cancelAnimationFrame(panelFrame);
    panelFrame = 0;
  };
  renderPanel(post);
  const panel = root.querySelector('.panel');
  if (!(panel instanceof HTMLElement)) {
    closePanel();
    return;
  }
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
    if (post) renderPostAtUiBoundary(post);
  }
  // Return focus to the button that opened the panel (no-op when focus is
  // already elsewhere, e.g. the user clicked into another control).
  if (anchor?.isConnected && (!document.activeElement || document.activeElement === document.body))
    anchor.focus({ preventScroll: true });
}

/** Build the inspector with temporary reveal and persistent override controls. */
function renderPanel(post: Post): void {
  const root = panelRoot;
  const host = panelHost;
  if (!root || !host || openPostId !== post.id) return;
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
  for (const [name, value] of Object.entries(vars)) host.style.setProperty(name, value);
  // Preserve focus across rebuilds (countdown ticks re-render the panel);
  // threshold inputs are found again by category instead of label escaping.
  const drafts = [...root.querySelectorAll<HTMLInputElement>('[data-jev-cat]')]
    .filter((input) => input.value !== input.defaultValue)
    .map((input) => ({
      category: input.dataset.jevCat,
      value: input.value,
      saved: input.defaultValue,
    }));
  const focusedCategory = panelFocusCategory;
  panelFocusCategory = null;
  root.replaceChildren();
  const style = element('style');
  style.textContent = PANEL_CSS;
  root.append(style);
  const panel = element('div');
  panel.className = 'panel';
  panel.tabIndex = -1;
  const revealed = [...bindings.values()].some(
    (binding) => binding.post === post && binding.revealed,
  );
  const panelState = revealed && blocked(post) ? 'Shown temporarily' : stateOf(post);
  const reason = hits(post)
    .map((h) => `${scoreLabel(h.key, settings.current.textFilters)} ${(h.score * 100).toFixed(0)}%`)
    .join(', ');
  const previewReason = previewBlocked(post)
    ? previewHits(post)
        .map(
          (h) =>
            `${scoreLabel(h.key, settings.current.textFilters)} ${(h.score * 100).toFixed(0)}%`,
        )
        .join(', ')
    : '';
  const head = element(
    'div',
    `${panelState}${reason ? ` · ${reason}` : ''}${previewReason && !reason ? ` · ${previewReason} (link preview)` : ''}`,
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
  if (
    (post.text || post.previewText) &&
    (visibleTextKeys.length > 0 || settings.current.textFilters.some((filter) => filter.enabled))
  ) {
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
    for (const filter of settings.current.textFilters.filter((item) => item.enabled)) {
      const row = element('tr');
      const score = post.scores[`custom:${filter.id}`];
      const previewScore = post.previewScores[`custom:${filter.id}`];
      const values: string[] = [];
      if (post.text)
        values.push(score === undefined ? 'not checked' : `${(score * 100).toFixed(1)}%`);
      if (post.previewText)
        values.push(
          `Preview ${previewScore === undefined ? 'not checked' : `${(previewScore * 100).toFixed(1)}%`}`,
        );
      row.append(element('td', filter.name), element('td', values.join(' · ')));
      const cell = element('td');
      cell.append(
        thresholdInput(post, `custom:${filter.id}`, filter.threshold),
        document.createTextNode('%'),
      );
      row.append(cell);
      textTable.append(row);
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
    void browserRuntime
      .runPromise(
        browserEffect('open logs from content panel', () =>
          browser.runtime.sendMessage({ type: 'open-logs', errors: false }),
        ),
      )
      .catch(() => {});
  });
  if (revealed && blocked(post)) {
    const hide = element('button', 'Hide again');
    hide.type = 'button';
    hide.addEventListener('click', () => {
      for (const binding of bindings.values()) if (binding.post === post) binding.revealed = false;
      closePanel();
      renderPostAtUiBoundary(post);
      const slot = [...bindings.values()].find((binding) => binding.post === post)?.hiddenSlot;
      slot?.shadowRoot?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    });
    foot.append(hide);
  }
  foot.append(logsLink);
  panel.append(foot);
  const hint = element('p', 'Unblock posts from the logs page.');
  hint.className = 'hint';
  panel.append(hint);
  root.append(panel);
  if (panelPos) {
    panel.style.left = `${panelPos.left}px`;
    panel.style.top = `${panelPos.top}px`;
  }
  for (const draft of drafts) {
    const input = root.querySelector<HTMLInputElement>(`[data-jev-cat="${draft.category}"]`);
    if (input?.defaultValue === draft.saved) input.value = draft.value;
  }
  if (focusedCategory) {
    const restored = root.querySelector<HTMLInputElement>(`[data-jev-cat="${focusedCategory}"]`);
    restored?.focus({ preventScroll: true });
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
      else root.querySelector<HTMLElement>('.retry-status')?.replaceChildren(retryText(current));
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
  scores: Partial<Record<ScoreKey, number>> = post.scores,
): HTMLElement {
  const row = element('tr');
  const score = scores[key];
  row.append(
    element('td', CATEGORY_LABELS[key]),
    element('td', score === undefined ? 'Not checked' : `${(score * 100).toFixed(1)}%`),
  );
  const cell = element('td');
  cell.append(
    thresholdInput(post, key, settings.current.thresholds[key]),
    document.createTextNode('%'),
  );
  row.append(cell);
  return row;
}

function thresholdInput(post: Post, key: ScoreKey, threshold: number): HTMLInputElement {
  const input = element('input');
  input.type = 'number';
  input.min = '0';
  input.max = '100';
  input.step = '0.1';
  input.defaultValue = String(Number((threshold * 100).toFixed(1)));
  input.setAttribute(
    'aria-label',
    `${scoreLabel(key, settings.current.textFilters)} threshold percent`,
  );
  input.setAttribute('data-jev-cat', key);
  input.addEventListener('change', () => {
    if (!input.validity.valid || input.value === '') return;
    const filter = settings.current.textFilters.find((item) => `custom:${item.id}` === key);
    if (key.startsWith('custom:') && !filter) return;
    void browserRuntime
      .runPromise(
        updateSettings(
          filter
            ? {
                field: 'patchTextFilter',
                id: filter.id,
                value: { threshold: input.valueAsNumber / 100 },
              }
            : {
                field: 'threshold',
                category: key as CategoryKey,
                value: input.valueAsNumber / 100,
              },
        ),
      )
      .catch((error: unknown) => {
        post.errors.push(`Settings: ${message(error)}`);
        renderPostAtUiBoundary(post);
      });
  });
  return input;
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
    restoreBinding(article, binding);
    applyCard(article, binding.post, false);
  }
  bindings.clear();
  removeGlobalStyle();
}
