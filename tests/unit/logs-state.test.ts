import { Effect } from 'effect';
import { BrowserError, browserEffect } from '../../src/platform/browser';
import { describe, expect, it } from 'vitest';
import { STORAGE_KEYS, type BlockedEntry, type FilterStatus } from '../../src/filtering/types';
import type { ScanErrorEntry } from '../../src/history/log';
import type { ClearReply } from '../../src/filtering/schemas';
import {
  createLogsState,
  type LogsState,
  type LogsStateDependencies,
  type ClearAction,
} from '../../src/entrypoints/logs/state';

interface Deferred<A> {
  promise: Promise<A>;
  resolve(value: A | PromiseLike<A>): void;
  reject(cause?: unknown): void;
}

function deferred<A>(): Deferred<A> {
  return Promise.withResolvers<A>();
}

function whenSnapshot(state: LogsState, predicate: () => boolean): Promise<void> {
  if (predicate()) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  let unsubscribe = () => {};

  unsubscribe = state.subscribe(() => {
    if (!predicate()) return;
    unsubscribe();
    resolve();
  });

  return promise;
}

const blockedEntry: BlockedEntry = {
  tweetId: 'post-1',
  author: 'Example',
  snippet: 'a sample post',
  surface: 'timeline',
  ts: 1,
  reasons: [{ key: 'porn', score: 0.99 }],
};

const scanError: ScanErrorEntry = { ts: 2, message: 'image scan failed' };

function clearReply(type: ClearAction): ClearReply {
  return type === 'clear-log'
    ? { ok: true, type, cleared: [blockedEntry] }
    : { ok: true, type, cleared: [scanError] };
}

function logsDependencies(overrides: Partial<LogsStateDependencies> = {}): LogsStateDependencies {
  return {
    loadLog: Effect.succeed([blockedEntry]),
    loadScanErrors: Effect.succeed([scanError]),
    loadStatus: Effect.succeed<FilterStatus>({ state: 'ok', updatedAt: 0 }),
    loadOverrides: () => Effect.succeed({}),
    subscribeStorage: () => () => {},
    unblock: () => Effect.void,
    clear: (type) => Effect.succeed(clearReply(type)),
    ...overrides,
  };
}

describe('logs state', () => {
  it('finishes an unblock after view disposal and stops showing it as pending', async () => {
    let persistedAllow = false;
    const writeStarted = deferred<void>();
    const writeResult = deferred<void>();

    const state = createLogsState(
      logsDependencies({
        unblock: () =>
          browserEffect('test unblock', () => {
            writeStarted.resolve();

            return writeResult.promise.then(() => {
              persistedAllow = true;
            });
          }),
        loadOverrides: () =>
          Effect.sync(() =>
            persistedAllow ? { [`${STORAGE_KEYS.overrides}:post-1`]: 'allow' } : {},
          ),
      }),
    );

    const stop = state.start();
    await whenSnapshot(state, () => state.getSnapshot().log.length === 1);

    state.unblock('post-1');
    expect(state.getSnapshot().unblocking.has('post-1')).toBe(true);
    await writeStarted.promise;
    stop();
    writeResult.resolve();
    await whenSnapshot(
      state,
      () =>
        state.getSnapshot().unblocked.has('post-1') &&
        !state.getSnapshot().unblocking.has('post-1'),
    );

    expect(state.getSnapshot().unblocked.has('post-1')).toBe(true);
    expect(state.getSnapshot().unblocking.has('post-1')).toBe(false);
    const previousSnapshot = state.getSnapshot();
    const remountedRefresh = whenSnapshot(state, () => state.getSnapshot() !== previousSnapshot);
    const restart = state.start();
    await remountedRefresh;
    expect(state.getSnapshot().unblocked.has('post-1')).toBe(true);
    restart();
  });

  it('submits unblock and clear writes during a scoped read and preserves a newer post', async () => {
    let storedLog: BlockedEntry[] = [blockedEntry];
    let holdNextRead = false;
    let persistedOverride: 'allow' | undefined;

    let notifyStorage:
      | ((area: string, changes: Readonly<Record<string, { newValue?: unknown }>>) => void)
      | undefined;

    const readHeld = deferred<void>();
    const delayedRead = deferred<BlockedEntry[]>();
    const persistedClear = deferred<void>();
    const persistedUnblock = deferred<void>();
    const newerEntry = { ...blockedEntry, tweetId: 'post-2', snippet: 'newer post' };

    const state = createLogsState(
      logsDependencies({
        loadLog: Effect.suspend(() => {
          if (!holdNextRead) return Effect.succeed(storedLog);
          holdNextRead = false;
          readHeld.resolve();

          return browserEffect('held test log read', () => delayedRead.promise);
        }),
        loadOverrides: (keys) =>
          Effect.sync(() => {
            const stored: Record<string, 'allow' | undefined> = {};

            if (persistedOverride === 'allow') {
              for (const key of keys) stored[key] = 'allow';
            }

            return stored;
          }),
        subscribeStorage: (listener) => {
          notifyStorage = listener;

          return () => {
            notifyStorage = undefined;
          };
        },
        unblock: () =>
          Effect.sync(() => {
            persistedOverride = 'allow';
            persistedUnblock.resolve();
          }),
        clear: () =>
          Effect.sync(() => {
            storedLog = [];
            persistedClear.resolve();

            return clearReply('clear-log');
          }),
      }),
    );

    const stop = state.start();
    await whenSnapshot(state, () => state.getSnapshot().log.length === 1);

    holdNextRead = true;
    const storageListener = notifyStorage;

    if (!storageListener) {
      throw new BrowserError({ operation: 'test setup', cause: 'Missing storage listener' });
    }

    storageListener('local', { [STORAGE_KEYS.log]: { newValue: storedLog } });
    await readHeld.promise;
    state.unblock('post-1');
    state.clear('clear-log');
    await Promise.all([persistedClear.promise, persistedUnblock.promise]);
    expect(storedLog).toEqual([]);
    expect(persistedOverride).toBe('allow');

    storedLog = [newerEntry];

    const latestLogLoaded = whenSnapshot(
      state,
      () =>
        state.getSnapshot().busyAction === null && state.getSnapshot().log[0]?.tweetId === 'post-2',
    );

    delayedRead.resolve([blockedEntry]);
    await latestLogLoaded;

    expect(state.getSnapshot().log).toEqual([newerEntry]);
    stop();
  });

  it('clears the transient unblock state and shows a failed write', async () => {
    const writeStarted = deferred<void>();
    const writeResult = deferred<void>();

    const state = createLogsState(
      logsDependencies({
        unblock: () =>
          browserEffect('test unblock', () => {
            writeStarted.resolve();

            return writeResult.promise;
          }),
      }),
    );

    const stop = state.start();
    await whenSnapshot(state, () => state.getSnapshot().log.length === 1);

    state.unblock('post-1');
    await writeStarted.promise;
    writeResult.reject('storage unavailable');
    await whenSnapshot(
      state,
      () =>
        !state.getSnapshot().unblocking.has('post-1') &&
        state.getSnapshot().actionError.includes('storage unavailable'),
    );

    expect(state.getSnapshot().unblocked.has('post-1')).toBe(false);
    expect(state.getSnapshot().actionError).toContain('Could not unblock this post');
    stop();
  });

  it('preserves visible errors and reports a rejected clear operation', async () => {
    const state = createLogsState(
      logsDependencies({
        clear: () =>
          Effect.fail(
            new BrowserError({
              operation: 'test clear errors',
              cause: 'background did not confirm the clear',
            }),
          ),
      }),
    );

    const stop = state.start();
    await whenSnapshot(state, () => state.getSnapshot().errors.length === 1);

    state.clear('clear-errors');
    await whenSnapshot(
      state,
      () => state.getSnapshot().busyAction === null && state.getSnapshot().actionError !== '',
    );

    expect(state.getSnapshot().errors).toEqual([{ ...scanError, source: 'Scan' }]);
    expect(state.getSnapshot().actionError).toContain('Could not clear scan errors');
    stop();
  });

  it.each(['clear-log', 'clear-errors'] as const)(
    'removes confirmed %s rows when the following storage read fails',
    async (action) => {
      let cleared = false;

      const state = createLogsState(
        logsDependencies({
          loadLog: Effect.suspend(() =>
            cleared
              ? Effect.fail(
                  new BrowserError({ operation: 'read log', cause: 'storage unavailable' }),
                )
              : Effect.succeed([blockedEntry]),
          ),
          loadStatus: Effect.succeed<FilterStatus>({
            state: 'failing',
            reason: 'text provider unavailable',
            updatedAt: 3,
          }),
          clear: (type) =>
            Effect.sync(() => {
              cleared = true;

              return clearReply(type);
            }),
        }),
      );

      const stop = state.start();

      try {
        await whenSnapshot(state, () => state.getSnapshot().errors.length === 2);
        const before = state.getSnapshot();
        state.clear(action);
        await whenSnapshot(state, () => state.getSnapshot().busyAction === null);
        const after = state.getSnapshot();
        expect(after.log).toEqual(action === 'clear-log' ? [] : before.log);
        expect(after.errors).toEqual(
          action === 'clear-errors'
            ? [{ source: 'Text API', ts: 3, message: 'text provider unavailable' }]
            : before.errors,
        );
        expect(after.actionError).toBe('');
        expect(after.loadError).toContain('storage unavailable');
      } finally {
        stop();
      }
    },
  );

  it.each(['clear-log', 'clear-errors'] as const)(
    'retains rows added after %s when acknowledgement is delayed and refresh fails',
    async (action) => {
      let storedLog = [blockedEntry];
      let storedErrors = [scanError];
      let failReads = false;
      let notifyStorage: Parameters<LogsStateDependencies['subscribeStorage']>[0] | undefined;
      const submitted = deferred<void>();
      const acknowledgement = deferred<void>();
      const newerPost = { ...blockedEntry, snippet: 'new content after clear' };
      const newerError = { ...scanError, handle: 'new-handle-after-clear' };

      const state = createLogsState(
        logsDependencies({
          loadLog: Effect.suspend(() =>
            failReads
              ? Effect.fail(
                  new BrowserError({ operation: 'read log', cause: 'storage unavailable' }),
                )
              : Effect.succeed(storedLog),
          ),
          loadScanErrors: Effect.sync(() => storedErrors),
          subscribeStorage: (listener) => {
            notifyStorage = listener;

            return () => {
              notifyStorage = undefined;
            };
          },
          clear: () =>
            browserEffect('delayed clear acknowledgement', () => {
              const reply: ClearReply =
                action === 'clear-log'
                  ? { ok: true, type: action, cleared: storedLog }
                  : { ok: true, type: action, cleared: storedErrors };

              if (action === 'clear-log') storedLog = [];
              else storedErrors = [];
              submitted.resolve();

              return acknowledgement.promise.then(() => reply);
            }),
        }),
      );

      const stop = state.start();

      try {
        await whenSnapshot(state, () => state.getSnapshot().log.length === 1);
        state.clear(action);
        await submitted.promise;
        storedLog = [newerPost];
        storedErrors = [newerError];

        if (!notifyStorage) throw new Error('Missing storage listener');
        notifyStorage('local', {
          [STORAGE_KEYS.log]: { newValue: storedLog },
          [STORAGE_KEYS.scanErrors]: { newValue: storedErrors },
        });
        await whenSnapshot(state, () => state.getSnapshot().log[0]?.snippet === newerPost.snippet);
        failReads = true;
        acknowledgement.resolve();
        await whenSnapshot(state, () => state.getSnapshot().busyAction === null);
        expect(state.getSnapshot().log).toEqual([newerPost]);
        expect(state.getSnapshot().errors).toEqual([{ ...newerError, source: 'Scan' }]);
        expect(state.getSnapshot().loadError).toContain('storage unavailable');
      } finally {
        stop();
      }
    },
  );

  it('finishes a clear after view disposal and retains text-provider errors', async () => {
    const clearStarted = deferred<void>();
    const clearResult = deferred<void>();
    let scanErrors: ScanErrorEntry[] = [scanError];

    const failingStatus: FilterStatus = {
      state: 'failing',
      reason: 'text provider unavailable',
      updatedAt: 3,
    };

    const state = createLogsState(
      logsDependencies({
        loadScanErrors: Effect.sync(() => scanErrors),
        loadStatus: Effect.succeed(failingStatus),
        clear: () =>
          browserEffect('test clear errors', () => {
            clearStarted.resolve();

            return clearResult.promise.then(() => {
              scanErrors = [];

              return clearReply('clear-errors');
            });
          }),
      }),
    );

    const stop = state.start();
    await whenSnapshot(state, () => state.getSnapshot().errors.length === 2);

    state.clear('clear-errors');
    expect(state.getSnapshot().busyAction).toBe('clear-errors');
    await clearStarted.promise;
    stop();
    clearResult.resolve();
    await whenSnapshot(
      state,
      () => state.getSnapshot().busyAction === null && state.getSnapshot().errors.length === 1,
    );

    expect(state.getSnapshot().errors[0]?.source).toBe('Text API');
    expect(state.getSnapshot().errors[0]?.message).toBe('text provider unavailable');
  });

  it('accepts an external allow override for the affected post', async () => {
    let notifyStorage:
      | ((area: string, changes: Readonly<Record<string, { newValue?: unknown }>>) => void)
      | undefined;

    const state = createLogsState(
      logsDependencies({
        subscribeStorage: (listener) => {
          notifyStorage = listener;

          return () => {
            notifyStorage = undefined;
          };
        },
      }),
    );

    const stop = state.start();
    await whenSnapshot(state, () => state.getSnapshot().log.length === 1);

    const storageListener = notifyStorage;

    if (!storageListener) {
      throw new BrowserError({ operation: 'test setup', cause: 'Missing storage listener' });
    }

    storageListener('local', {
      [`${STORAGE_KEYS.overrides}:post-1`]: { newValue: 'allow' },
    });
    await whenSnapshot(state, () => state.getSnapshot().unblocked.has('post-1'));

    expect(state.getSnapshot().unblocking.has('post-1')).toBe(false);
    stop();
  });

  it('does not restore an override removed before unblock acknowledgement', async () => {
    const key = `${STORAGE_KEYS.overrides}:post-1`;
    let persistedOverride: 'allow' | undefined;

    let notifyStorage:
      | ((area: string, changes: Readonly<Record<string, { newValue?: unknown }>>) => void)
      | undefined;

    const writeStarted = deferred<void>();
    const writeResult = deferred<void>();

    const state = createLogsState(
      logsDependencies({
        loadOverrides: () =>
          Effect.sync(() => (persistedOverride === undefined ? {} : { [key]: persistedOverride })),
        subscribeStorage: (listener) => {
          notifyStorage = listener;

          return () => {
            notifyStorage = undefined;
          };
        },
        unblock: () =>
          browserEffect('test unblock', () => {
            persistedOverride = 'allow';
            writeStarted.resolve();

            return writeResult.promise;
          }),
      }),
    );

    const stop = state.start();
    await whenSnapshot(state, () => state.getSnapshot().log.length === 1);

    state.unblock('post-1');
    await writeStarted.promise;
    const storageListener = notifyStorage;

    if (!storageListener) {
      throw new BrowserError({ operation: 'test setup', cause: 'Missing storage listener' });
    }

    storageListener('local', { [key]: { newValue: 'allow' } });
    await whenSnapshot(
      state,
      () =>
        state.getSnapshot().unblocked.has('post-1') && state.getSnapshot().unblocking.has('post-1'),
    );

    persistedOverride = undefined;

    const observedRemoval = whenSnapshot(
      state,
      () =>
        !state.getSnapshot().unblocked.has('post-1') &&
        state.getSnapshot().unblocking.has('post-1'),
    );

    storageListener('local', { [key]: { newValue: undefined } });
    await observedRemoval;

    writeResult.resolve();
    await whenSnapshot(
      state,
      () =>
        !state.getSnapshot().unblocked.has('post-1') &&
        !state.getSnapshot().unblocking.has('post-1'),
    );
    expect(state.getSnapshot().unblocked.has('post-1')).toBe(false);
    expect(state.getSnapshot().unblocking.has('post-1')).toBe(false);
    stop();
  });

  it('cancels a log read when the view scope is disposed', async () => {
    const readStarted = deferred<void>();
    const readAborted = deferred<void>();

    const state = createLogsState(
      logsDependencies({
        loadLog: browserEffect('test cancelled log read', (signal) => {
          readStarted.resolve();
          const read = deferred<BlockedEntry[]>();
          signal.addEventListener(
            'abort',
            () => {
              readAborted.resolve();
              read.reject('read cancelled');
            },
            { once: true },
          );

          return read.promise;
        }),
      }),
    );

    const stop = state.start();
    await readStarted.promise;

    stop();
    await readAborted.promise;
    expect(state.getSnapshot().log).toEqual([]);
  });
});
