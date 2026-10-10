import { Effect, Layer, ManagedRuntime, Semaphore } from 'effect';
import * as Schema from 'effect/Schema';
import { browser } from 'wxt/browser';
import { browserEffect, browserRuntime, BrowserError } from '../../platform/browser';
import {
  applySettingsChange,
  loadSettings,
  loadStatus,
  updateSettings,
  deleteTextFilter,
} from '../../filtering/settings';
import { TabReportSchema } from '../../filtering/schemas';
import type {
  FilterStatus,
  Settings,
  SettingsChange,
  TabReport,
  TextFilter,
} from '../../filtering/types';
import {
  MODEL_STATUS_KEY,
  ModelStatusesSchema,
  InferenceReplySchema,
  initialModelStatuses,
  type ModelStatuses,
  type ModelKind,
} from '../../inference/contracts';

export interface PopupSnapshot {
  settings: Settings | null;
  loadFailed: boolean;
  status: FilterStatus | null;
  report: TabReport | null;
  missingScript: boolean;
  error: string;
  saving: boolean;
  models: ModelStatuses;
}

export interface PopupState {
  getSnapshot: () => PopupSnapshot;
  subscribe: (listener: () => void) => () => void;
  start: () => () => void;
  update: (change: SettingsChange, editorId?: string) => Promise<boolean>;
  dismissEditorError: (id: string) => void;
  deleteTextFilter: (id: string) => Promise<TextFilter | undefined>;
  openLogs: () => void;
  openWorkspace: () => void;
  retryModel: (kind: ModelKind) => void;
}

export interface PopupStateDependencies {
  loadSettings: Effect.Effect<Settings, BrowserError>;
  loadStatus: Effect.Effect<FilterStatus, BrowserError>;
  loadModels: Effect.Effect<ModelStatuses, BrowserError>;
  retryModel: (kind: ModelKind) => Effect.Effect<unknown, BrowserError>;
  updateSettings: (change: SettingsChange) => Effect.Effect<Settings, BrowserError>;
  deleteTextFilter: (
    id: string,
  ) => Effect.Effect<{ settings: Settings; filter: TextFilter | undefined }, BrowserError>;
  findActiveTab: Effect.Effect<number | undefined, BrowserError>;
  loadTabReport: (tabId: number) => Effect.Effect<unknown, BrowserError>;
  subscribeStorage: (listener: (area: string, keys: ReadonlySet<string>) => void) => () => void;
  openLogs: Effect.Effect<unknown, BrowserError>;
  openWorkspace: Effect.Effect<unknown, BrowserError>;
}

type OptimisticEdit = {
  readonly change: SettingsChange;
  phase: 'saving' | 'confirmed';
  readonly editorId: string | undefined;
  abandoned?: boolean;
};

/** Reconcile independent view edits with worker-owned settings and report reads. */
export function createPopupState(dependencies: PopupStateDependencies): PopupState {
  const subscribers = new Set<() => void>();
  const optimisticEdits: OptimisticEdit[] = [];
  const saveErrors = new Map<string, { message: string }>();
  const settingsReadLock = Semaphore.makeUnsafe(1);
  const statusReadLock = Semaphore.makeUnsafe(1);
  const modelReadLock = Semaphore.makeUnsafe(1);
  const reportReadLock = Semaphore.makeUnsafe(1);
  // Confirmed settings are the latest completed storage read. Edits stay layered
  // over that base until a read started after their worker acknowledgement lands.
  let confirmedSettings: Settings | null = null;

  let snapshot: PopupSnapshot = {
    settings: null,
    loadFailed: false,
    status: null,
    report: null,
    missingScript: false,
    error: '',
    saving: false,
    models: initialModelStatuses(),
  };

  let viewScopeDisposer: (() => void) | undefined;
  let refreshSettingsWhileMounted: (() => void) | undefined;

  function currentSettings(): Settings | null {
    if (!confirmedSettings) return null;

    return optimisticEdits.reduce(
      (settings, edit) => applySettingsChange(settings, edit.change),
      confirmedSettings,
    );
  }

  function publish(changes: Partial<PopupSnapshot> = {}): void {
    snapshot = {
      ...snapshot,
      ...changes,
      settings: currentSettings(),
      saving: optimisticEdits.some((edit) => edit.phase === 'saving'),
    };

    for (const subscriber of subscribers) subscriber();
  }

  const refreshSettings = settingsReadLock
    .withPermits(1)(
      Effect.gen(function* () {
        const reconciledEdits = optimisticEdits.filter((edit) => edit.phase === 'confirmed');
        const settings = yield* dependencies.loadSettings;
        yield* Effect.sync(() => {
          confirmedSettings = settings;

          for (const edit of reconciledEdits) {
            const index = optimisticEdits.indexOf(edit);

            if (index >= 0) optimisticEdits.splice(index, 1);
          }

          publish({ loadFailed: false });
        });
      }),
    )
    .pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          if (!confirmedSettings) publish({ loadFailed: true });
        }),
      ),
    );

  const refreshStatus = statusReadLock.withPermits(1)(
    Effect.gen(function* () {
      const status = yield* dependencies.loadStatus;
      yield* Effect.sync(() => publish({ status }));
    }).pipe(Effect.ignore),
  );

  const refreshModels = modelReadLock
    .withPermits(1)(
      Effect.gen(function* () {
        const models = yield* dependencies.loadModels;
        yield* Effect.sync(() => publish({ models }));
      }),
    )
    .pipe(Effect.ignore);

  /** Scope subscriptions and polling to the mounted popup or workspace. */
  function start(): () => void {
    if (viewScopeDisposer) return viewScopeDisposer;

    const runtime = ManagedRuntime.make(Layer.empty);
    let activeTabId: number | undefined;
    let probeFailures = 0;

    const failProbe = () => {
      probeFailures++;

      if (probeFailures >= 2) publish({ report: null, missingScript: true });
    };

    /** Probe the selected feed, distinguishing absent tabs from transient script failures. */
    const refreshReport = (tabId: number | undefined) => {
      if (tabId === undefined)
        return Effect.sync(() => publish({ report: null, missingScript: true }));

      return reportReadLock.withPermits(1)(
        dependencies.loadTabReport(tabId).pipe(
          Effect.tap((value) =>
            Effect.sync(() => {
              if (!Schema.is(TabReportSchema)(value)) {
                failProbe();

                return;
              }

              probeFailures = 0;
              publish({ report: value, missingScript: false });
            }),
          ),
          Effect.catch(() => Effect.sync(failProbe)),
        ),
      );
    };

    const listener = (area: string, keys: ReadonlySet<string>) => {
      if (area !== 'local') return;

      if (keys.has('settings')) runtime.runFork(refreshSettings);

      if (keys.has('filterStatus')) runtime.runFork(refreshStatus);

      if (keys.has(MODEL_STATUS_KEY)) runtime.runFork(refreshModels);

      if (keys.size === 1 && keys.has(MODEL_STATUS_KEY)) return;
      runtime.runFork(refreshReport(activeTabId));
    };

    const program = Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => dependencies.subscribeStorage(listener)),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
      yield* Effect.forkScoped(refreshSettings);
      yield* Effect.forkScoped(refreshStatus);
      yield* Effect.forkScoped(refreshModels);
      activeTabId = yield* dependencies.findActiveTab.pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            publish({ error: String(cause) });

            return undefined;
          }),
        ),
      );
      yield* refreshReport(activeTabId);

      return yield* Effect.forever(
        Effect.sleep(1500).pipe(Effect.andThen(refreshReport(activeTabId))),
      );
    });

    const stop = () => {
      if (viewScopeDisposer !== stop) return;
      viewScopeDisposer = undefined;
      refreshSettingsWhileMounted = undefined;
      void runtime.dispose();
    };

    viewScopeDisposer = stop;
    refreshSettingsWhileMounted = () => runtime.runFork(refreshSettings);
    runtime.runFork(Effect.scoped(program));

    return stop;
  }

  function editKey(change: SettingsChange): string {
    switch (change.field) {
      case 'authorException':
        return `authorException:${change.handle.toLowerCase()}:${change.category}`;
      case 'skipFollowed':
        return 'skipFollowed';
      case 'textFilter':
        return `textFilter:${change.value.id}`;
      case 'deleteTextFilter':
      case 'patchTextFilter':
        return `textFilter:${change.id}`;
      case 'providerKey':
        return `providerKey:${change.provider}`;
      case 'enabled':
      case 'threshold':
        return `${change.field}:${change.category}`;
      default:
        return change.field;
    }
  }

  function saveError(key: string, cause: unknown): void {
    const error = `Could not save settings: ${String(cause)}`;
    saveErrors.set(key, { message: error });
    publish({ error });
  }

  /** Project edits immediately, then reconcile success or failure with authoritative storage. */
  function update(
    change: SettingsChange,
    editorId?: string,
    operation = dependencies.updateSettings(change),
  ): Promise<boolean> {
    if (!confirmedSettings) return Promise.resolve(false);
    const key = editorId ? `editor:${editorId}` : editKey(change);
    const retriedError = saveErrors.get(key);

    try {
      applySettingsChange(currentSettings() ?? confirmedSettings, change);
    } catch (cause) {
      saveError(key, cause);

      return Promise.resolve(false);
    }

    const edit: OptimisticEdit = { change, phase: 'saving', editorId };
    optimisticEdits.push(edit);
    publish();

    // The background owns read-modify-write and receives every edit immediately;
    // view disposal only stops the refresh used to reconcile this optimistic projection.
    return browserRuntime.runPromise(
      operation.pipe(
        Effect.match({
          onSuccess: () => {
            edit.phase = 'confirmed';

            if (saveErrors.get(key) === retriedError) saveErrors.delete(key);
            const remainingError = [...saveErrors.values()].at(-1)?.message;

            if (remainingError) publish({ error: remainingError });
            else if (retriedError && snapshot.error === retriedError.message)
              publish({ error: '' });
            else publish();
            refreshSettingsWhileMounted?.();

            return true;
          },
          onFailure: (cause) => {
            const index = optimisticEdits.indexOf(edit);

            if (index >= 0) optimisticEdits.splice(index, 1);

            if (edit.abandoned) publish();
            else saveError(key, cause);
            refreshSettingsWhileMounted?.();

            return false;
          },
        }),
      ),
    );
  }

  /** Keep optimistic deletion while using the worker's authoritative removed value for Undo. */
  async function removeFilter(id: string): Promise<TextFilter | undefined> {
    let filter: TextFilter | undefined;

    const saved = await update(
      { field: 'deleteTextFilter', id },
      undefined,
      dependencies.deleteTextFilter(id).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            filter = result.filter;
          }),
        ),
        Effect.map((result) => result.settings),
      ),
    );

    return saved ? filter : undefined;
  }

  function dismissEditorError(id: string): void {
    for (const edit of optimisticEdits) {
      if (edit.editorId === id) edit.abandoned = true;
    }

    const key = `editor:${id}`;
    const dismissed = saveErrors.get(key);
    saveErrors.delete(key);

    if (dismissed && snapshot.error === dismissed.message)
      publish({ error: [...saveErrors.values()].at(-1)?.message ?? '' });
  }

  function openLogs(): void {
    browserRuntime.runFork(
      dependencies.openLogs.pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            publish({ error: `Could not open logs: ${String(cause)}` });
          }),
        ),
      ),
    );
  }

  /** Open a persistent editor and expose navigation failures through the shared status. */
  function openWorkspace(): void {
    browserRuntime.runFork(
      dependencies.openWorkspace.pipe(
        Effect.catch((cause) =>
          Effect.sync(() => publish({ error: `Could not open workspace: ${String(cause)}` })),
        ),
      ),
    );
  }

  function retryModel(kind: ModelKind): void {
    publish({
      models: {
        ...snapshot.models,
        [kind]: { ...snapshot.models[kind], state: 'loading', loaded: 0, error: '' },
      },
    });
    browserRuntime.runFork(
      dependencies.retryModel(kind).pipe(
        Effect.catch((cause) =>
          Effect.sync(() =>
            publish({
              models: {
                ...snapshot.models,
                [kind]: { ...snapshot.models[kind], state: 'error', error: String(cause) },
              },
            }),
          ),
        ),
      ),
    );
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      subscribers.add(listener);

      return () => subscribers.delete(listener);
    },
    start,
    update,
    dismissEditorError,
    deleteTextFilter: removeFilter,
    openLogs,
    openWorkspace,
    retryModel,
  };
}

const browserDependencies: PopupStateDependencies = {
  loadSettings: loadSettings(),
  loadStatus: loadStatus(),
  loadModels: browserEffect('read local model status', () =>
    browser.storage.local.get(MODEL_STATUS_KEY),
  ).pipe(
    Effect.map((stored) =>
      Schema.is(ModelStatusesSchema)(stored[MODEL_STATUS_KEY])
        ? stored[MODEL_STATUS_KEY]
        : initialModelStatuses(),
    ),
  ),
  retryModel: (kind) =>
    browserEffect('retry local model download', () =>
      browser.runtime.sendMessage({ type: 'load-model', kind }),
    ).pipe(
      Effect.flatMap((reply) =>
        Schema.decodeUnknownEffect(InferenceReplySchema)(reply).pipe(
          Effect.mapError(
            (cause) =>
              new BrowserError({ operation: 'decode model download acknowledgement', cause }),
          ),
        ),
      ),
      Effect.filterOrFail(
        (reply) => reply.ok,
        (reply) =>
          new BrowserError({
            operation: 'retry local model download',
            cause: reply.ok ? 'Model download was not acknowledged.' : reply.error,
          }),
      ),
    ),
  updateSettings,
  deleteTextFilter,
  findActiveTab: browserEffect('find active tab', async () => {
    const source = new URLSearchParams(location.search).get('tab');
    const tabId = source === null ? undefined : Number(source);

    if (tabId !== undefined && Schema.is(Schema.Int)(tabId) && tabId >= 0) return tabId;

    const tabs = await browser.tabs.query(
      location.pathname === '/options.html'
        ? { url: ['https://x.com/*', 'https://twitter.com/*'], currentWindow: true }
        : { active: true, currentWindow: true },
    );

    return tabs.find((tab) => tab.active)?.id ?? tabs[0]?.id;
  }),
  loadTabReport: (tabId) =>
    browserEffect('read tab report', () => browser.tabs.sendMessage(tabId, { type: 'get-report' })),
  subscribeStorage: (listener) => {
    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) =>
      listener(area, new Set(Object.keys(changes)));

    browser.storage.onChanged.addListener(onChanged);

    return () => browser.storage.onChanged.removeListener(onChanged);
  },
  openWorkspace: Effect.gen(function* () {
    const tabs = yield* browserEffect('find workspace source tab', () =>
      browser.tabs.query({ active: true, currentWindow: true }),
    );

    const url = new URL(browser.runtime.getURL('/options.html'));

    if (tabs[0]?.id !== undefined) url.searchParams.set('tab', String(tabs[0].id));
    yield* browserEffect('open filter workspace', () => browser.tabs.create({ url: url.href }));
  }),
  openLogs: browserEffect('open logs', () =>
    browser.tabs.create({ url: browser.runtime.getURL('/logs.html') }),
  ),
};

export const popupState = createPopupState(browserDependencies);
