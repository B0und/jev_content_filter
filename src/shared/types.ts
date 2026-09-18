export type CategoryKey = 'porn' | 'hentai' | 'sexy' | 'drawings' | 'sexualText' | 'aiGenerated';

export interface Settings {
  masterEnabled: boolean;
  gatewayKey: string;
  enabled: Record<CategoryKey, boolean>;
  /** Probability cutoff, 0..1. Lower blocks more. */
  thresholds: Record<CategoryKey, number>;
}
export interface FilterStatus {
  state: 'ok' | 'failing';
  reason?: string;
  updatedAt: number;
}
export interface BlockedEntry {
  tweetId: string;
  author: string;
  snippet: string;
  surface: string;
  ts: number;
  reasons: Array<{ key: CategoryKey; score: number }>;
}
export interface TabReport {
  analyzed: number;
  blocked: number;
  pending: number;
  failed: number;
  lastScannedAt: number;
  errors: string[];
  reviewing: boolean;
}
export type BgRequest =
  | { type: 'jev'; tweetId: string; author: string; text: string }
  | { type: 'fetch-image'; url: string }
  | { type: 'get-status' }
  | { type: 'log-blocked'; entry: BlockedEntry };
export type JevReply = { ok: true; sexual: number; ai: number } | { ok: false; error: string };
export type ImageReply = { ok: true; dataUrl: string } | { ok: false; error: string };
export const STORAGE_KEYS = {
  settings: 'settings', log: 'blockedLog', status: 'filterStatus', overrides: 'postOverrides',
} as const;
export const LOG_LIMIT = 1000;
export const CATEGORY_LABELS: Record<CategoryKey, string> = {
  porn: 'Porn', hentai: 'Hentai', sexy: 'Suggestive images', drawings: 'Drawings / anime',
  sexualText: 'Sexual text', aiGenerated: 'AI-written text',
};
export const CATEGORY_KEYS = Object.keys(CATEGORY_LABELS) as CategoryKey[];
export const IMAGE_KEYS: CategoryKey[] = ['porn', 'hentai', 'sexy', 'drawings'];
export function defaultSettings(): Settings {
  return {
    masterEnabled: true, gatewayKey: '',
    enabled: { porn: true, hentai: true, sexy: true, drawings: true, sexualText: true, aiGenerated: true },
    thresholds: { porn: 0.6, hentai: 0.6, sexy: 0.65, drawings: 0.7, sexualText: 0.65, aiGenerated: 0.65 },
  };
}
