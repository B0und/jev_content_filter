import { Effect } from 'effect';
import { BrowserError, browserEffect } from '../../src/shared/browser';
import { describe, expect, it } from 'vitest';
import {
  defaultSettings,
  type FilterStatus,
  type Settings,
  type SettingsChange,
} from '../../src/shared/types';
import {
  createPopupState,
  type PopupState,
  type PopupStateDependencies,
} from '../../src/entrypoints/popup/state';
import { initialModelStatuses } from '../../src/shared/inference';

interface Deferred<A> {
  promise: Promise<A>;
  resolve(value: A | PromiseLike<A>): void;
  reject(cause?: unknown): void;
}

function deferred<A>(): Deferred<A> {
  return Promise.withResolvers<A>();
}

function whenSnapshot(state: PopupState, predicate: () => boolean): Promise<void> {
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

function popupDependencies(
  overrides: Partial<PopupStateDependencies> = {},
): PopupStateDependencies {
  return {
    loadSettings: Effect.succeed(defaultSettings()),
    loadStatus: Effect.succeed<FilterStatus>({ state: 'ok', updatedAt: 0 }),
    loadModels: Effect.sync(initialModelStatuses),
    retryModel: () => Effect.void,
    updateSettings: () => Effect.succeed(defaultSettings()),
    findActiveTab: browserEffect('find active tab', async () => undefined),
    loadTabReport: () => Effect.void,
    subscribeStorage: () => () => {},
    openLogs: Effect.void,
    ...overrides,
  };
}

interface WriteRequest {
  change: SettingsChange;
  complete: Deferred<Settings>;
}

describe('popup settings state', () => {
  it('keeps overlapping optimistic edits visible through notifications and response reordering', async () => {
    let stored = defaultSettings();
    let reads = 0;
    let notifyStorage: ((area: string, keys: ReadonlySet<string>) => void) | undefined;
    const externalRead = deferred<void>();
    const requests: WriteRequest[] = [];
    const bothWritesStarted = deferred<void>();
    const state = createPopupState(
      popupDependencies({
        loadSettings: Effect.sync(() => {
          reads++;
          if (reads === 2) externalRead.resolve();
          return stored;
        }),
        subscribeStorage: (listener) => {
          notifyStorage = listener;
          return () => {
            notifyStorage = undefined;
          };
        },
        updateSettings: (change) =>
          browserEffect('test update settings', () => {
            const complete = deferred<Settings>();
            requests.push({ change, complete });
            if (requests.length === 2) bothWritesStarted.resolve();
            return complete.promise;
          }),
      }),
    );
    const stop = state.start();
    await whenSnapshot(state, () => state.getSnapshot().settings !== null);

    state.update({ field: 'masterEnabled', value: false });
    state.update({ field: 'threshold', category: 'porn', value: 0.61 });
    await bothWritesStarted.promise;
    stored = {
      ...stored,
      enabled: { ...stored.enabled, hentai: false },
    };
    const observedExternalRefresh = whenSnapshot(
      state,
      () => reads >= 2 && state.getSnapshot().saving,
    );
    const storageListener = notifyStorage;
    if (!storageListener) {
      throw new BrowserError({ operation: 'test setup', cause: 'Missing storage listener' });
    }
    storageListener('local', new Set(['settings']));
    await externalRead.promise;
    await observedExternalRefresh;

    const firstRequest = requests[0];
    const secondRequest = requests[1];
    if (!firstRequest || !secondRequest) {
      throw new BrowserError({ operation: 'test setup', cause: 'Missing settings writes' });
    }
    expect(state.getSnapshot().settings?.masterEnabled).toBe(false);
    expect(state.getSnapshot().settings?.thresholds.porn).toBe(0.61);
    expect(state.getSnapshot().settings?.enabled.hentai).toBe(false);
    expect(state.getSnapshot().saving).toBe(true);

    const afterBoth = {
      ...stored,
      masterEnabled: false,
      thresholds: { ...stored.thresholds, porn: 0.61 },
    };
    stored = afterBoth;
    secondRequest.complete.resolve(afterBoth);
    firstRequest.complete.resolve({ ...defaultSettings(), masterEnabled: false });
    await whenSnapshot(
      state,
      () =>
        !state.getSnapshot().saving &&
        state.getSnapshot().settings?.masterEnabled === false &&
        state.getSnapshot().settings?.thresholds.porn === 0.61,
    );

    expect(state.getSnapshot().settings?.masterEnabled).toBe(false);
    expect(state.getSnapshot().settings?.thresholds.porn).toBe(0.61);
    expect(state.getSnapshot().settings?.enabled.hentai).toBe(false);
    stop();
  });

  it('lets a dispatched setting write finish after view disposal', async () => {
    let stored = defaultSettings();
    const writeStarted = deferred<void>();
    const writeResult = deferred<Settings>();
    let reads = 0;
    const savedSettings = { ...stored, masterEnabled: false };
    const state = createPopupState(
      popupDependencies({
        loadSettings: Effect.sync(() => {
          reads++;
          return stored;
        }),
        updateSettings: () =>
          browserEffect('test update settings', () => {
            writeStarted.resolve();
            return writeResult.promise;
          }),
      }),
    );
    const stop = state.start();
    await whenSnapshot(state, () => state.getSnapshot().settings !== null);
    state.update({ field: 'masterEnabled', value: false });
    await writeStarted.promise;
    stop();
    stored = savedSettings;
    writeResult.resolve(savedSettings);

    await whenSnapshot(state, () => !state.getSnapshot().saving);
    expect(state.getSnapshot().settings?.masterEnabled).toBe(false);
    const restart = state.start();
    await whenSnapshot(state, () => reads >= 2);
    expect(state.getSnapshot().settings?.masterEnabled).toBe(false);
    restart();
  });

  it('rolls back a failed edit without hiding its error', async () => {
    const state = createPopupState(
      popupDependencies({
        updateSettings: () =>
          Effect.fail(
            new BrowserError({ operation: 'test update settings', cause: 'worker unavailable' }),
          ),
      }),
    );
    const stop = state.start();
    await whenSnapshot(state, () => state.getSnapshot().settings !== null);

    state.update({ field: 'masterEnabled', value: false });
    await whenSnapshot(
      state,
      () => !state.getSnapshot().saving && state.getSnapshot().error.includes('worker unavailable'),
    );

    expect(state.getSnapshot().settings?.masterEnabled).toBe(true);
    expect(state.getSnapshot().error).toContain('Could not save settings');
    stop();
  });

  it('cancels tab-report reads on view disposal without disturbing loaded settings', async () => {
    const reportStarted = deferred<void>();
    const reportAborted = deferred<void>();
    const state = createPopupState(
      popupDependencies({
        findActiveTab: Effect.succeed(42),
        loadTabReport: () =>
          browserEffect('test tab report', (signal) => {
            reportStarted.resolve();
            const read = deferred<unknown>();
            signal.addEventListener(
              'abort',
              () => {
                reportAborted.resolve();
                read.reject('read cancelled');
              },
              { once: true },
            );
            return read.promise;
          }),
      }),
    );
    const stop = state.start();
    await reportStarted.promise;
    await whenSnapshot(state, () => state.getSnapshot().settings !== null);

    stop();
    await reportAborted.promise;
    expect(state.getSnapshot().settings?.masterEnabled).toBe(true);
  });
});
