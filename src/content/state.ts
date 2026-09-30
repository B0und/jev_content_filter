// Shared runtime state and policy for the content filter. Everything the
// lifecycle, classification, and UI modules agree on lives here so no module
// reaches into another's internals.
import {
  CATEGORY_KEYS,
  defaultSettings,
  type CategoryKey,
  type Settings,
  type TabReport,
} from '../shared/types';

export interface Post {
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
  /** Whether the post (not its link preview) has been reported to the block log. */
  logged: boolean;
  /** Whether the blocked link preview has been reported to the block log. */
  previewLogged: boolean;
  recorded: Set<string>;
  retryCount: number;
  /** Non-null while an Effect retry fiber is scheduled. */
  retryAt: number | null;
}

export interface Binding {
  post: Post;
  host: HTMLElement;
  root: ShadowRoot;
  button: HTMLButtonElement;
  /** Serialized last-render state; skips identical DOM writes. */
  renderState?: string;
}

export const posts = new Map<string, Post>();
export const bindings = new Map<HTMLElement, Binding>();
// Keep only identities so totals survive detached-post eviction without retaining scores or DOM.
const pageAnalyzed = new Set<string>();
const pageBlocked = new Set<string>();
/** Article bindings grouped by post, so attachment checks don't scan the feed. */
let articlesByPost = new WeakMap<Post, Set<HTMLElement>>();
export function trackBinding(article: HTMLElement, binding: Binding): void {
  bindings.set(article, binding);
  let articles = articlesByPost.get(binding.post);
  if (!articles) {
    articles = new Set();
    articlesByPost.set(binding.post, articles);
  }
  articles.add(article);
}

export function untrackBinding(article: HTMLElement): Binding | undefined {
  const binding = bindings.get(article);
  if (!binding) return undefined;
  bindings.delete(article);
  const articles = articlesByPost.get(binding.post);
  articles?.delete(article);
  if (articles?.size === 0) articlesByPost.delete(binding.post);
  return binding;
}

export function clearBindingIndex(): void {
  articlesByPost = new WeakMap();
}

export const overrides = new Map<string, 'allow'>();
/** Replaced wholesale whenever settings are loaded; readers always see the latest. */
export const settings: { current: Settings } = { current: defaultSettings() };

/**
 * Post the URL addresses directly — its status permalink, or the detail view X
 * opens over the timeline. Read from the live path at render time, so a
 * same-document navigation needs no listener of its own: X mutates the DOM
 * when the route changes, and every mutation triggers a render pass.
 */
export function openedPostId(): string {
  return /\/status\/(\d+)/.exec(location.pathname)?.[1] ?? '';
}

export function newPost(
  id: string,
  handle: string,
  text: string,
  urls: string[],
  previewUrl: string,
  previewText: string,
): Post {
  return {
    id,
    handle,
    author: '',
    text,
    urls,
    previewUrl,
    previewText,
    version: 0,
    partErrors: { text: [], images: [], preview: [] },
    scores: {},
    previewScores: {},
    errors: [],
    pending: false,
    textDone: false,
    imagesDone: false,
    previewDone: false,
    scannedAt: 0,
    logged: false,
    previewLogged: false,
    recorded: new Set(),
    retryCount: 0,
    retryAt: null,
  };
}

/** Every enabled category the post itself scored at or above its threshold. */
export function hits(post: Post): Array<{ key: CategoryKey; score: number }> {
  return CATEGORY_KEYS.flatMap((key) => {
    const score = post.scores[key];
    return settings.current.enabled[key] &&
      score !== undefined &&
      score >= settings.current.thresholds[key]
      ? [{ key, score }]
      : [];
  });
}

/** Same as {@link hits} but against link-preview scores only. */
export function previewHits(post: Post): Array<{ key: CategoryKey; score: number }> {
  return CATEGORY_KEYS.flatMap((key) => {
    const score = post.previewScores[key];
    return settings.current.enabled[key] &&
      score !== undefined &&
      score >= settings.current.thresholds[key]
      ? [{ key, score }]
      : [];
  });
}

export function blocked(post: Post): boolean {
  if (!settings.current.masterEnabled || post.id === openedPostId()) return false;
  if (overrides.has(post.id)) return false;
  return hits(post).length > 0;
}

export function previewBlocked(post: Post): boolean {
  // Fail open: only hide the preview when its own scan finished cleanly.
  if (
    !settings.current.masterEnabled ||
    post.id === openedPostId() ||
    overrides.has(post.id) ||
    post.partErrors.preview.length
  )
    return false;
  return previewHits(post).length > 0;
}

export function stateOf(post: Post): string {
  if (!settings.current.masterEnabled) return 'Paused';
  if (post.pending) return 'Scanning';
  if (post.id === openedPostId()) return 'Opened post';
  if (blocked(post)) return 'Blocked';
  if (overrides.get(post.id) === 'allow') return 'Allowed by you';
  if (post.errors.length > 0)
    return post.retryAt !== null ? 'Retry scheduled' : 'Not fully checked';
  if (post.scannedAt) return 'Allowed';
  return 'Not scanned';
}

export function isAttached(post: Post): boolean {
  if (posts.get(post.id) !== post) return false;
  for (const article of articlesByPost.get(post) ?? []) if (article.isConnected) return true;
  return false;
}

export function recordPageStats(post: Post): void {
  if (!pageAnalyzed.has(post.id)) {
    for (const key of CATEGORY_KEYS) {
      if (post.scores[key] !== undefined || post.previewScores[key] !== undefined) {
        pageAnalyzed.add(post.id);
        break;
      }
    }
  }
  if (!pageBlocked.has(post.id) && (blocked(post) || previewBlocked(post)))
    pageBlocked.add(post.id);
}

export function resetPageStats(): void {
  pageAnalyzed.clear();
  pageBlocked.clear();
}

export function report(): TabReport {
  // Live scan statistics use connected bindings; cumulative totals do not.
  // Reading isConnected avoids stale attachment counters before observer delivery.
  const attached = new Set<Post>();
  for (const [article, binding] of bindings)
    if (article.isConnected && posts.get(binding.post.id) === binding.post)
      attached.add(binding.post);

  let analyzed = 0,
    blockedCount = 0,
    pending = 0,
    failed = 0,
    retrying = 0,
    lastScannedAt = 0;
  const errors = new Set<string>();
  for (const post of attached) {
    if (Object.keys(post.scores).length > 0 || Object.keys(post.previewScores).length > 0)
      analyzed++;
    if (blocked(post) || previewBlocked(post)) blockedCount++;
    if (post.pending) pending++;
    if (post.errors.length > 0) failed++;
    if (post.retryAt !== null) retrying++;
    lastScannedAt = Math.max(lastScannedAt, post.scannedAt);
    for (const error of post.errors) errors.add(error);
  }
  return {
    analyzed,
    blocked: blockedCount,
    pageAnalyzed: pageAnalyzed.size,
    pageBlocked: pageBlocked.size,
    pending,
    failed,
    retrying,
    lastScannedAt,
    errors: [...errors].slice(-5),
  };
}
