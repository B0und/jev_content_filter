// Blocked-tweet log and scan-error log: FIFO capped, read, clear over storage.local.
import { Clock, Effect } from 'effect';
import * as Schema from 'effect/Schema';
import { browserEffect, type BrowserError } from './browser';
import { browser } from 'wxt/browser';
import { LOG_LIMIT, STORAGE_KEYS, type BlockedEntry } from './types';
import { BlockedEntrySchema, ScanErrorEntrySchema } from './schemas';

const isBlockedEntry = Schema.is(BlockedEntrySchema);
const isScanErrorEntry = Schema.is(ScanErrorEntrySchema);

export const loadLog = Effect.fn('loadLog')(function* (): Effect.fn.Return<
  BlockedEntry[],
  BrowserError
> {
  const stored = yield* browserEffect('load blocked log', () =>
    browser.storage.local.get(STORAGE_KEYS.log),
  );
  const value: unknown = stored[STORAGE_KEYS.log];
  if (!Array.isArray(value)) return [];
  const entries: unknown[] = value;
  return entries.filter(isBlockedEntry);
});

export const appendBlocked = Effect.fn('appendBlocked')(function* (entry: BlockedEntry) {
  const log = yield* loadLog();
  // One entry per tweet id, most recent first.
  const filtered = log.filter((e) => e.tweetId !== entry.tweetId);
  const next = [entry, ...filtered].slice(0, LOG_LIMIT);
  yield* browserEffect('append blocked log', () =>
    browser.storage.local.set({ [STORAGE_KEYS.log]: next }),
  );
});

export const clearLog = Effect.gen(function* () {
  const cleared = yield* loadLog();
  yield* browserEffect('clear blocked log', () =>
    browser.storage.local.set({ [STORAGE_KEYS.log]: [] }),
  );
  return cleared;
});

export interface ScanErrorEntry {
  ts: number;
  message: string;
  /** Post the error happened on, when known: links the row back to it. */
  tweetId?: string;
  handle?: string;
}

const SCAN_ERROR_LIMIT = 50;

export const loadScanErrors = Effect.fn('loadScanErrors')(function* (): Effect.fn.Return<
  ScanErrorEntry[],
  BrowserError
> {
  const stored = yield* browserEffect('load scan errors', () =>
    browser.storage.local.get(STORAGE_KEYS.scanErrors),
  );
  const value: unknown = stored[STORAGE_KEYS.scanErrors];
  if (!Array.isArray(value)) return [];
  const entries: unknown[] = value;
  return entries.filter(isScanErrorEntry);
});

/**
 * Dedupe by tweet id + message: the same failure on different posts stays
 * visible on each post's row, while a repeated failure for the same post
 * updates its timestamp. Entries without a tweet id (legacy records) still
 * dedupe on message alone.
 */
export const appendScanError = Effect.fn('appendScanError')(function* (
  message: string,
  tweet?: { tweetId: string; handle?: string },
) {
  const entry: ScanErrorEntry = { ts: yield* Clock.currentTimeMillis, message };
  if (tweet?.tweetId !== undefined) entry.tweetId = tweet.tweetId;
  if (tweet?.handle !== undefined) entry.handle = tweet.handle;
  const list = yield* loadScanErrors();
  const next = [
    entry,
    ...list.filter((e) => !(e.message === message && e.tweetId === entry.tweetId)),
  ].slice(0, SCAN_ERROR_LIMIT);
  yield* browserEffect('append scan error', () =>
    browser.storage.local.set({ [STORAGE_KEYS.scanErrors]: next }),
  );
});

export const clearScanErrors = Effect.gen(function* () {
  const cleared = yield* loadScanErrors();
  yield* browserEffect('clear scan errors', () =>
    browser.storage.local.set({ [STORAGE_KEYS.scanErrors]: [] }),
  );
  return cleared;
});
