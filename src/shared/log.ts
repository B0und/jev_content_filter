// Blocked-tweet log and scan-error log: FIFO capped, read, clear over storage.local.
import { browser } from 'wxt/browser';
import { LOG_LIMIT, STORAGE_KEYS, type BlockedEntry } from './types';

export async function loadLog(): Promise<BlockedEntry[]> {
  const stored = await browser.storage.local.get(STORAGE_KEYS.log);
  return (stored[STORAGE_KEYS.log] as BlockedEntry[] | undefined) ?? [];
}

export async function appendBlocked(entry: BlockedEntry): Promise<void> {
  const log = await loadLog();
  // One entry per tweet id, most recent first.
  const filtered = log.filter((e) => e.tweetId !== entry.tweetId);
  const next = [entry, ...filtered].slice(0, LOG_LIMIT);
  await browser.storage.local.set({ [STORAGE_KEYS.log]: next });
}

export async function clearLog(): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.log]: [] });
}

export interface ScanErrorEntry {
  ts: number;
  message: string;
  /** Post the error happened on, when known: links the row back to it. */
  tweetId?: string;
  handle?: string;
}

const SCAN_ERROR_LIMIT = 50;

export async function loadScanErrors(): Promise<ScanErrorEntry[]> {
  const stored = await browser.storage.local.get(STORAGE_KEYS.scanErrors);
  return (stored[STORAGE_KEYS.scanErrors] as ScanErrorEntry[] | undefined) ?? [];
}

/**
 * Dedupe by tweet id + message: the same failure on different posts stays
 * visible on each post's row, while a repeated failure for the same post
 * updates its timestamp. Entries without a tweet id (legacy records) still
 * dedupe on message alone.
 */
export async function appendScanError(
  message: string,
  tweet?: { tweetId: string; handle?: string },
): Promise<void> {
  const entry: ScanErrorEntry = { ts: Date.now(), message };
  if (tweet?.tweetId !== undefined) entry.tweetId = tweet.tweetId;
  if (tweet?.handle !== undefined) entry.handle = tweet.handle;
  const list = await loadScanErrors();
  const next = [
    entry,
    ...list.filter((e) => !(e.message === message && e.tweetId === entry.tweetId)),
  ].slice(0, SCAN_ERROR_LIMIT);
  await browser.storage.local.set({ [STORAGE_KEYS.scanErrors]: next });
}

export async function clearScanErrors(): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.scanErrors]: [] });
}
