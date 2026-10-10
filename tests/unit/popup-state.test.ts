import { Effect } from 'effect';
import { BrowserError, browserEffect } from '../../src/platform/browser';
import { describe, expect, it } from 'vitest';
import {
  defaultSettings,
  type FilterStatus,
  type Settings,
  type SettingsChange,
} from '../../src/filtering/types';
import {
  createPopupState,
  type PopupState,
  type PopupStateDependencies,
} from '../../src/entrypoints/popup/state';
import { initialModelStatuses } from '../../src/inference/contracts';

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
    deleteTextFilter: () => Effect.succeed({ settings: defaultSettings(), filter: undefined }),
    findActiveTab: browserEffect('find active tab', async () => undefined),
    loadTabReport: () => Effect.void,
    subscribeStorage: () => () => {},
    openLogs: Effect.void,
    openWorkspace: Effect.void,
    ...overrides,
  };
}

interface WriteRequest {
  change: SettingsChange;
  complete: Deferred<Settings>;
}

describe('popup settings state', () => {
  it('reports an unavailable feed when no source tab exists', async () => {
    const state = createPopupState(popupDependencies());
    const stop = state.start();
    await whenSnapshot(state, () => state.getSnapshot().missingScript);
    expect(state.getSnapshot().report).toBeNull();
    stop();
  });

  it('exposes workspace navigation failures', async () => {
    const state = createPopupState(
      popupDependencies({
        openWorkspace: Effect.fail(
          new BrowserError({ operation: 'open workspace', cause: 'blocked' }),
        ),
      }),
    );

    state.openWorkspace();
    await whenSnapshot(state, () => Boolean(state.getSnapshot().error));
    expect(state.getSnapshot().error).toContain('Could not open workspace');
  });

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

    void state.update({ field: 'masterEnabled', value: false });
    void state.update({ field: 'threshold', category: 'porn', value: 0.61 });
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
    void state.update({ field: 'masterEnabled', value: false });
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

    void state.update({ field: 'masterEnabled', value: false });
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

it('reports the save outcome and clears a failed-save message after a successful retry', async () => {
  let fail = true;

  const state = createPopupState(
    popupDependencies({
      updateSettings: () =>
        fail
          ? Effect.fail(new BrowserError({ operation: 'test save', cause: 'storage unavailable' }))
          : Effect.succeed(defaultSettings()),
    }),
  );

  const stop = state.start();

  try {
    await whenSnapshot(state, () => state.getSnapshot().settings !== null);

    const filter = {
      id: 'draft',
      name: 'Gardening',
      instructions: 'garden',
      enabled: true,
      threshold: 0.72,
    };

    await expect(state.update({ field: 'textFilter', value: filter })).resolves.toBe(false);
    expect(state.getSnapshot().settings?.textFilters).toEqual(defaultSettings().textFilters);
    expect(state.getSnapshot().error).toContain('Could not save settings');
    fail = false;
    await expect(state.update({ field: 'textFilter', value: filter })).resolves.toBe(true);
    expect(state.getSnapshot().error).toBe('');
  } finally {
    stop();
  }
});

it('keeps another edits save error until that edit is successfully retried', async () => {
  const requests: WriteRequest[] = [];

  const state = createPopupState(
    popupDependencies({
      updateSettings: (change) =>
        browserEffect('test save', () => {
          const complete = deferred<Settings>();
          requests.push({ change, complete });

          return complete.promise;
        }),
    }),
  );

  const stop = state.start();

  try {
    await whenSnapshot(state, () => state.getSnapshot().settings !== null);
    const failed = state.update({ field: 'masterEnabled', value: false });

    const successful = state.update({
      field: 'textFilter',
      value: { ...defaultSettings().textFilters[0]!, threshold: 0.75 },
    });

    await whenSnapshot(state, () => requests.length === 2);
    requests[0]?.complete.reject('first write failed');
    await expect(failed).resolves.toBe(false);
    requests[1]?.complete.resolve(defaultSettings());
    await expect(successful).resolves.toBe(true);
    expect(state.getSnapshot().error).toContain('first write failed');
    const retry = state.update({ field: 'masterEnabled', value: false });
    await whenSnapshot(state, () => requests.length === 3);
    requests[2]?.complete.resolve(defaultSettings());
    await expect(retry).resolves.toBe(true);
    expect(state.getSnapshot().error).toBe('');
  } finally {
    stop();
  }
});

it('dismisses an abandoned filter error without clearing another failed edit', async () => {
  const state = createPopupState(
    popupDependencies({
      updateSettings: (change) =>
        Effect.fail(new BrowserError({ operation: 'test save', cause: change.field })),
    }),
  );

  const stop = state.start();

  try {
    await whenSnapshot(state, () => state.getSnapshot().settings !== null);
    await state.update({ field: 'masterEnabled', value: false });
    await state.update(
      {
        field: 'textFilter',
        value: {
          id: 'draft',
          name: 'Draft',
          instructions: 'garden',
          enabled: true,
          threshold: 0.65,
        },
      },
      'editor-draft',
    );
    expect(state.getSnapshot().error).toContain('textFilter');
    state.dismissEditorError('editor-draft');
    expect(state.getSnapshot().error).toContain('masterEnabled');
  } finally {
    stop();
  }
});

it('ignores a save error arriving after its editor closes', async () => {
  const complete = deferred<Settings>();

  const state = createPopupState(
    popupDependencies({
      updateSettings: () => browserEffect('test delayed save', () => complete.promise),
    }),
  );

  const stop = state.start();

  try {
    await whenSnapshot(state, () => state.getSnapshot().settings !== null);

    const saving = state.update(
      {
        field: 'textFilter',
        value: {
          id: 'late',
          name: 'Draft',
          instructions: 'garden',
          enabled: true,
          threshold: 0.65,
        },
      },
      'closed-editor',
    );

    state.dismissEditorError('closed-editor');
    complete.reject('late save failure');
    await expect(saving).resolves.toBe(false);
    expect(state.getSnapshot().error).toBe('');
    expect(state.getSnapshot().saving).toBe(false);
    expect(state.getSnapshot().settings?.textFilters).toEqual(defaultSettings().textFilters);
  } finally {
    stop();
  }
});
