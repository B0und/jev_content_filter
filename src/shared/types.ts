// Shared types for content script <-> background <-> UI messaging and storage.

export type CategoryKey =
  | 'porn'
  | 'hentai'
  | 'sexy'
  | 'drawings'
  | 'sexualText'
  | 'aiGenerated';

export interface Settings {
  masterEnabled: boolean;
  gatewayKey: string;
  /** 0..100 sensitivity per category; higher = hides more (lower threshold). */
  sliders: Record<CategoryKey, number>;
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

/** Requests from content script to background. */
export type BgRequest =
  | { type: 'jev'; tweetId: string; author: string; text: string }
  | { type: 'fetch-image'; url: string }
  | { type: 'get-status' };

export type JevReply =
  | { ok: true; sexual: number; ai: number }
  | { ok: false; error: string };

export type ImageReply =
  | { ok: true; dataUrl: string }
  | { ok: false; error: string };

export const STORAGE_KEYS = {
  settings: 'settings',
  log: 'blockedLog',
  status: 'filterStatus',
} as const;

export const LOG_LIMIT = 1000;

export const CATEGORY_LABELS: Record<CategoryKey, string> = {
  porn: 'Porn (images)',
  hentai: 'Hentai (images)',
  sexy: 'Sexy (images)',
  drawings: 'Drawings (images)',
  sexualText: 'Sexual text',
  aiGenerated: 'AI-generated',
};

/** Maps a 0..100 sensitivity slider to a hide threshold (0.95 relaxed .. 0.45 ruthless). */
export function sliderToThreshold(v: number): number {
  return 0.95 - (Math.min(100, Math.max(0, v)) / 100) * 0.5;
}

export const DEFAULT_SLIDERS: Record<CategoryKey, number> = {
  porn: 70,
  hentai: 70,
  sexy: 60,
  drawings: 50,
  sexualText: 60,
  aiGenerated: 60,
};

export function defaultSettings(): Settings {
  return {
    masterEnabled: true,
    gatewayKey: '',
    sliders: { ...DEFAULT_SLIDERS },
  };
}
