import type { ModelStatuses } from '../inference/contracts';

export type CategoryKey = 'porn' | 'hentai' | 'sexy' | 'drawings' | 'aiGenerated';
export type ScoreKey = CategoryKey | `custom:${string}`;
export interface TextFilter {
  id: string;
  name: string;
  instructions: string;
  enabled: boolean;
  threshold: number;
}
export const SEXUAL_TEXT_FILTER_ID = 'sexual-text';
export const DEFAULT_TEXT_FILTER: TextFilter = {
  id: SEXUAL_TEXT_FILTER_ID,
  name: 'Sexual text',
  instructions:
    'Explicit sexual content, lewd innuendo, heavily implied sexual content, or engagement bait designed to arouse.',
  enabled: true,
  threshold: 0.65,
};
/** Only active questions affect decisions; labels and cutoffs are application policy. */
export function textDecisionSignature(filters: TextFilter[]): string {
  return JSON.stringify(
    filters
      .filter((filter) => filter.enabled)
      .map(({ id, instructions }) => ({ id, instructions }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}
export function textFilterKey(id: string): `custom:${string}` {
  return `custom:${id}`;
}
export function scoreLabel(key: ScoreKey, filters: TextFilter[] = []): string {
  if (key.startsWith('custom:'))
    return filters.find((filter) => textFilterKey(filter.id) === key)?.name ?? 'Custom text filter';
  return CATEGORY_LABELS[key as CategoryKey];
}
export type TextProvider = 'vercel' | 'typesafe' | 'openrouter';
export const TEXT_PROVIDER_LABELS: Record<TextProvider, string> = {
  vercel: 'Vercel AI Gateway',
  typesafe: 'TypeSafe AI',
  openrouter: 'OpenRouter',
};
export const TEXT_PROVIDERS: TextProvider[] = ['vercel', 'typesafe', 'openrouter'];
export function isTextProvider(value: unknown): value is TextProvider {
  return TEXT_PROVIDERS.some((provider) => provider === value);
}

export interface Settings {
  textFilters: TextFilter[];
  masterEnabled: boolean;
  /** Provider that evaluates the text questions. */
  textProvider: TextProvider;
  /** Credentials never move between providers. */
  providerKeys: Record<TextProvider, string>;
  /** Incremented when active custom questions, the selected provider, or its credential changes. */
  textConfigRevision: number;
  enabled: Record<CategoryKey, boolean>;
  /** Probability cutoff, 0..1. Lower blocks more. */
  thresholds: Record<CategoryKey, number>;
}

export type SettingsChange =
  | { field: 'textFilter'; value: TextFilter }
  | { field: 'deleteTextFilter'; id: string }
  | { field: 'masterEnabled'; value: boolean }
  | { field: 'textProvider'; value: TextProvider }
  | { field: 'providerKey'; provider: TextProvider; value: string }
  | { field: 'enabled'; category: CategoryKey; value: boolean }
  | { field: 'threshold'; category: CategoryKey; value: number };
export interface FilterStatus {
  state: 'ok' | 'failing';
  reason?: string;
  updatedAt: number;
}
export interface BlockedEntry {
  tweetId: string;
  /** @handle, for linking back to the post. Absent in older entries. */
  handle?: string;
  target?: 'post' | 'preview';
  author: string;
  snippet: string;
  surface: string;
  ts: number;
  reasons: Array<{ key: ScoreKey; label?: string; score: number }>;
}
export interface TabReport {
  /** Currently attached posts; pending and error fields use the same live scope. */
  analyzed: number;
  blocked: number;
  /** Unique posts analyzed or blocked during this document's lifetime. */
  pageAnalyzed: number;
  pageBlocked: number;
  pending: number;
  failed: number;
  /** Posts waiting for an automatic retry. */
  retrying: number;
  lastScannedAt: number;
  errors: string[];
}
export type BgRequest =
  | { type: 'jev'; tweetId: string; text: string; provider: TextProvider; revision: number }
  | { type: 'update-settings'; change: SettingsChange }
  | { type: 'classify-image'; url: string }
  | { type: 'classify-ai'; text: string }
  | { type: 'load-model'; kind: 'image' | 'aiText' }
  | { type: 'local-model-status'; models: ModelStatuses }
  | { type: 'get-status' }
  | { type: 'log-blocked'; entry: BlockedEntry }
  | { type: 'log-error'; message: string; tweetId: string; handle?: string }
  | { type: 'clear-log' }
  | { type: 'clear-errors' }
  | { type: 'open-logs'; errors: boolean }
  | { type: 'tab-stats'; blocked: number };
export type JevReply =
  | {
      ok: true;
      custom: Record<string, number>;
      provider: TextProvider;
      revision: number;
    }
  | { ok: false; error: string; stale?: boolean };
export type SettingsReply = { ok: true; settings: Settings } | { ok: false; error: string };
export const STORAGE_KEYS = {
  settings: 'settings',
  log: 'blockedLog',
  status: 'filterStatus',
  overrides: 'postOverrides',
  scanErrors: 'scanErrors',
  scores: 'scoreCache',
} as const;
export const LOG_LIMIT = 1000;
export const CATEGORY_LABELS: Record<CategoryKey, string> = {
  porn: 'Porn',
  hentai: 'Hentai',
  sexy: 'Suggestive images',
  drawings: 'Drawings / anime',
  aiGenerated: 'AI-written text',
};
export const CATEGORY_KEYS: CategoryKey[] = ['porn', 'hentai', 'sexy', 'drawings', 'aiGenerated'];
export const IMAGE_KEYS: CategoryKey[] = ['porn', 'hentai', 'sexy', 'drawings'];
export const TEXT_KEYS: CategoryKey[] = ['aiGenerated'];
export function defaultSettings(): Settings {
  return {
    textFilters: [{ ...DEFAULT_TEXT_FILTER }],
    masterEnabled: true,
    textProvider: 'vercel',
    providerKeys: { vercel: '', typesafe: '', openrouter: '' },
    textConfigRevision: 0,
    enabled: {
      porn: true,
      hentai: true,
      sexy: true,
      drawings: true,
      aiGenerated: true,
    },
    thresholds: {
      porn: 0.6,
      hentai: 0.6,
      sexy: 0.65,
      drawings: 0.7,
      aiGenerated: 0.65,
    },
  };
}

/** Badge text: 0-999 as-is, then 1k/2k… and 1M/2M…, capped to four characters. */
export function formatCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) {
    const k = Math.floor(count / 1000);
    return k > 999 ? '999k' : `${k}k`;
  }
  const m = Math.floor(count / 1_000_000);
  return m > 999 ? '999M' : `${m}M`;
}
