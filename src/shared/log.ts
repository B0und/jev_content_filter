// Blocked-tweet log: FIFO capped append, read, and clear over storage.local.
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
}

const SCAN_ERROR_LIMIT = 50;

export async function loadScanErrors(): Promise<ScanErrorEntry[]> {
  const stored = await browser.storage.local.get(STORAGE_KEYS.scanErrors);
  return (stored[STORAGE_KEYS.scanErrors] as ScanErrorEntry[] | undefined) ?? [];
}

/** Dedupe by message; most recent first. */
export async function appendScanError(message: string): Promise<void> {
  const list = await loadScanErrors();
  const next = [
    { ts: Date.now(), message },
    ...list.filter((e) => e.message !== message),
  ].slice(0, SCAN_ERROR_LIMIT);
  await browser.storage.local.set({ [STORAGE_KEYS.scanErrors]: next });
}

export async function clearScanErrors(): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.scanErrors]: [] });
}
