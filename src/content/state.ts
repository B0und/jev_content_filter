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
  retryAt: number | null;
  /** Window timer id; cleared through clearTimeout. */
  retryTimer: number | undefined;
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
export const overrides = new Map<string, 'allow'>();
/** Replaced wholesale whenever settings are loaded; readers always see the latest. */
export const settings: { current: Settings } = { current: defaultSettings() };

/** Direct log links opt into review mode so the linked post stays visible. */
export const reviewMode = { current: false };

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
    retryTimer: undefined,
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
  if (!settings.current.masterEnabled || reviewMode.current) return false;
  if (overrides.has(post.id)) return false;
  return hits(post).length > 0;
}

export function previewBlocked(post: Post): boolean {
  // Fail open: only hide the preview when its own scan finished cleanly.
  if (
    !settings.current.masterEnabled ||
    reviewMode.current ||
    overrides.has(post.id) ||
    post.partErrors.preview.length
  )
    return false;
  return previewHits(post).length > 0;
}

export function stateOf(post: Post): string {
  if (!settings.current.masterEnabled) return 'Paused';
  if (post.pending) return 'Scanning';
  if (blocked(post)) return 'Blocked';
  if (overrides.get(post.id) === 'allow') return 'Allowed by you';
  if (post.errors.length > 0) return post.retryTimer ? 'Retry scheduled' : 'Not fully checked';
  if (post.scannedAt) return 'Allowed';
  return 'Not scanned';
}

export function isAttached(post: Post): boolean {
  for (const [article, binding] of bindings)
    if (binding.post === post && article.isConnected) return true;
  return false;
}

export function report(): TabReport {
  // Only posts actually on the page count — detached/recycled posts must
  // not inflate the badge or the logs-page numbers.
  const values = [...posts.values()].filter(isAttached);
  return {
    analyzed: values.filter(
      (post) => Object.keys(post.scores).length > 0 || Object.keys(post.previewScores).length > 0,
    ).length,
    blocked: values.filter((post) => blocked(post) || previewBlocked(post)).length,
    pending: values.filter((post) => post.pending).length,
    failed: values.filter((post) => post.errors.length > 0).length,
    retrying: values.filter((post) => !!post.retryTimer).length,
    lastScannedAt: values.reduce((last, post) => Math.max(last, post.scannedAt), 0),
    errors: [...new Set(values.flatMap((post) => post.errors))].slice(-5),
  };
}
