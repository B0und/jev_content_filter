import { Effect } from 'effect';
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { loadLog, loadScanErrors } from '../../src/history/log';
import { loadStatus, updateSettings } from '../../src/filtering/settings';
import { defaultSettings, type BlockedEntry } from '../../src/filtering/types';

beforeEach(() => fakeBrowser.reset());

describe('stored data validation', () => {
  it('preserves readable legacy blocked rows while omitting malformed rows', async () => {
    const entry: BlockedEntry = {
      tweetId: 'valid',
      author: '@author',
      snippet: 'blocked content',
      surface: 'Text',
      ts: 1,
      reasons: [{ key: 'custom:preset-1', score: 0.9 }],
    };
    await fakeBrowser.storage.local.set({
      blockedLog: [
        null,
        entry,
        { ...entry, tweetId: 'unknown-category', reasons: [{ key: 'unknownCategory', score: 0.9 }] },
        { ...entry, tweetId: 'invalid', reasons: [{ key: 'unknown', score: 0.9 }] },
      ],
    });
    expect(await Effect.runPromise(loadLog())).toEqual([entry]);
  });

  it('preserves legacy scan errors and post-linked errors without admitting malformed rows', async () => {
    const legacy = { ts: 1, message: 'legacy failure' };
    const linked = { ts: 2, message: 'linked failure', tweetId: 'post', handle: 'author' };
    await fakeBrowser.storage.local.set({ scanErrors: [legacy, { ts: 3 }, linked] });
    expect(await Effect.runPromise(loadScanErrors())).toEqual([legacy, linked]);
  });

  it.each(['not an array', { tweetId: 'post' }])(
    'treats non-array logs as empty instead of crashing a reader',
    async (invalid) => {
      await fakeBrowser.storage.local.set({ blockedLog: invalid, scanErrors: invalid });
      expect(await Effect.runPromise(loadLog())).toEqual([]);
      expect(await Effect.runPromise(loadScanErrors())).toEqual([]);
    },
  );

  it('rejects malformed status fields rather than publishing an invalid status', async () => {
    await fakeBrowser.storage.local.set({
      filterStatus: { state: 'failing', updatedAt: 'yesterday' },
    });
    expect(await Effect.runPromise(loadStatus())).toEqual({ state: 'ok', updatedAt: 0 });
    const valid = { state: 'failing', updatedAt: 1, reason: 'HTTP 401' };
    await fakeBrowser.storage.local.set({ filterStatus: valid });
    expect(await Effect.runPromise(loadStatus())).toEqual(valid);
  });

  it('rejects a successful write reply whose settings payload is invalid', async () => {
    fakeBrowser.runtime.onMessage.addListener((_request, _sender, respond) => {
      respond({ ok: true, settings: { ...defaultSettings(), thresholds: {} } });
      return true;
    });
    const result = await Effect.runPromise(
      Effect.result(updateSettings({ field: 'masterEnabled', value: false })),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure')
      expect(result.failure.message).toBe('update settings: Invalid settings response.');
  });
});
