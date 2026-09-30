import { Effect, Layer, ManagedRuntime, Semaphore } from 'effect';
import * as Schema from 'effect/Schema';
import { browser } from 'wxt/browser';
import { BrowserError, browserEffect, browserRuntime } from '../../shared/browser';
import { loadLog, loadScanErrors, type ScanErrorEntry } from '../../shared/log';
import { loadStatus } from '../../shared/settings';
import { STORAGE_KEYS, type BlockedEntry, type FilterStatus } from '../../shared/types';

export type ClearAction = 'clear-log' | 'clear-errors';
export type ErrorRow = ScanErrorEntry & { source: 'Scan' | 'Text API' };

export interface LogsSnapshot {
  log: BlockedEntry[];
  errors: ErrorRow[];
  unblocked: ReadonlySet<string>;
  unblocking: ReadonlySet<string>;
  loadError: string;
  actionError: string;
  busyAction: ClearAction | null;
}

export interface LogsState {
  getSnapshot: () => LogsSnapshot;
  subscribe: (listener: () => void) => () => void;
  start: () => () => void;
  unblock: (tweetId: string) => void;
  clear: (type: ClearAction) => void;
}

export interface LogsStateDependencies {
  loadLog: Effect.Effect<BlockedEntry[], BrowserError>;
  loadScanErrors: Effect.Effect<ScanErrorEntry[], BrowserError>;
  loadStatus: Effect.Effect<FilterStatus, BrowserError>;
  loadOverrides: (keys: readonly string[]) => Effect.Effect<Record<string, unknown>, BrowserError>;
  subscribeStorage: (
    listener: (area: string, changes: Readonly<Record<string, { newValue?: unknown }>>) => void,
  ) => () => void;
  unblock: (tweetId: string) => Effect.Effect<void, BrowserError>;
  clear: (type: ClearAction) => Effect.Effect<void, BrowserError>;
}

interface OverrideState {
  allowed: boolean;
  saving: boolean;
}

const OVERRIDES_PREFIX = `${STORAGE_KEYS.overrides}:`;
const LOG_STORAGE_KEYS: Record<string, true> = {
  [STORAGE_KEYS.log]: true,
  [STORAGE_KEYS.scanErrors]: true,
  [STORAGE_KEYS.status]: true,
};
const ClearSuccessSchema = Schema.Struct({ ok: Schema.Literal(true) });

export function createLogsState(dependencies: LogsStateDependencies): LogsState {
  const subscribers = new Set<() => void>();
  // Each post tracks observed allowance and its single active write.
  const overrides = new Map<string, OverrideState>();
  // A single gate serializes storage snapshots, action acknowledgements, and override notifications.
  const storageLock = Semaphore.makeUnsafe(1);
  let snapshot: LogsSnapshot = {
    log: [],
    errors: [],
    unblocked: new Set(),
    unblocking: new Set(),
    loadError: '',
    actionError: '',
    busyAction: null,
  };
  let viewScopeDisposer: (() => void) | undefined;

  function publish(changes: Partial<LogsSnapshot> = {}): void {
    const unblocked = new Set<string>();
    const unblocking = new Set<string>();
    for (const [tweetId, state] of overrides) {
      if (state.allowed) unblocked.add(tweetId);
      if (state.saving) unblocking.add(tweetId);
    }
    snapshot = { ...snapshot, ...changes, unblocked, unblocking };
    for (const subscriber of subscribers) subscriber();
  }

  const refresh = storageLock
    .withPermits(1)(
      Effect.gen(function* () {
        const log = yield* dependencies.loadLog;
        const scanErrors = yield* dependencies.loadScanErrors;
        const status = yield* dependencies.loadStatus;
        const rows: ErrorRow[] = scanErrors.map((entry) => ({ ...entry, source: 'Scan' }));
        if (status.state === 'failing' && status.reason)
          rows.unshift({ ts: status.updatedAt, message: status.reason, source: 'Text API' });
        const overrideKeys = [
          ...new Set(log.map((entry) => `${OVERRIDES_PREFIX}${entry.tweetId}`)),
        ];
        const storedOverrides = yield* dependencies.loadOverrides(overrideKeys);
        const allowed = new Set(
          Object.entries(storedOverrides)
            .filter(([, value]) => value === 'allow')
            .map(([key]) => key.slice(OVERRIDES_PREFIX.length)),
        );
        yield* Effect.sync(() => {
          for (const entry of log) {
            const current = overrides.get(entry.tweetId);
            overrides.set(entry.tweetId, {
              allowed: allowed.has(entry.tweetId),
              saving: current?.saving ?? false,
            });
          }
          publish({ log, errors: rows, loadError: '' });
        });
      }),
    )
    .pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          publish({ loadError: `Could not load the log: ${String(cause)}` });
        }),
      ),
    );

  function reconcileOverride(tweetId: string): Effect.Effect<void, never> {
    const key = `${OVERRIDES_PREFIX}${tweetId}`;
    return storageLock.withPermits(1)(
      dependencies.loadOverrides([key]).pipe(
        Effect.match({
          onSuccess: (storedOverrides) => {
            overrides.set(tweetId, {
              allowed: storedOverrides[key] === 'allow',
              saving: false,
            });
            publish();
          },
          onFailure: (cause) => {
            const current = overrides.get(tweetId);
            overrides.set(tweetId, {
              allowed: current?.allowed ?? false,
              saving: false,
            });
            publish({ actionError: `Could not confirm the unblock status: ${String(cause)}` });
          },
        }),
      ),
    );
  }

  function start(): () => void {
    if (viewScopeDisposer) return viewScopeDisposer;

    const runtime = ManagedRuntime.make(Layer.empty);
    const listener = (area: string, changes: Readonly<Record<string, { newValue?: unknown }>>) => {
      if (area !== 'local') return;
      const keys = Object.keys(changes);
      if (keys.some((key) => Object.hasOwn(LOG_STORAGE_KEYS, key))) {
        runtime.runFork(refresh);
        return;
      }
      const overrideKeys = keys.filter((key) => key.startsWith(OVERRIDES_PREFIX));
      if (overrideKeys.length === 0) return;
      runtime.runFork(
        storageLock.withPermits(1)(
          Effect.sync(() => {
            for (const key of overrideKeys) {
              const tweetId = key.slice(OVERRIDES_PREFIX.length);
              const current = overrides.get(tweetId);
              overrides.set(tweetId, {
                allowed: changes[key]?.newValue === 'allow',
                saving: current?.saving ?? false,
              });
            }
            publish();
          }),
        ),
      );
    };

    const program = Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => dependencies.subscribeStorage(listener)),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
      yield* Effect.forkScoped(refresh);
      return yield* Effect.never;
    });

    const stop = () => {
      if (viewScopeDisposer !== stop) return;
      viewScopeDisposer = undefined;
      void runtime.dispose();
    };
    viewScopeDisposer = stop;
    runtime.runFork(Effect.scoped(program));
    return stop;
  }

  function unblock(tweetId: string): void {
    const current = overrides.get(tweetId);
    if (current?.allowed || current?.saving) return;
    overrides.set(tweetId, { allowed: false, saving: true });
    publish({ actionError: '' });

    browserRuntime.runFork(
      dependencies.unblock(tweetId).pipe(
        Effect.flatMap(() => reconcileOverride(tweetId)),
        Effect.catch((cause) =>
          reconcileOverride(tweetId).pipe(
            Effect.andThen(
              Effect.sync(() =>
                publish({ actionError: `Could not unblock this post: ${String(cause)}` }),
              ),
            ),
          ),
        ),
      ),
    );
  }

  function clear(type: ClearAction): void {
    if (snapshot.busyAction !== null) return;
    publish({ actionError: '', busyAction: type });

    browserRuntime.runFork(
      dependencies.clear(type).pipe(
        Effect.andThen(
          storageLock.withPermits(1)(
            Effect.sync(() =>
              publish(
                type === 'clear-log'
                  ? { log: [] }
                  : { errors: snapshot.errors.filter((row) => row.source === 'Text API') },
              ),
            ),
          ),
        ),
        Effect.andThen(refresh),
        Effect.andThen(Effect.sync(() => publish({ busyAction: null }))),
        Effect.catch((cause) => {
          const target = type === 'clear-log' ? 'the log' : 'scan errors';
          return Effect.sync(() =>
            publish({
              busyAction: null,
              actionError: `Could not clear ${target}: ${String(cause)}`,
            }),
          );
        }),
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
    unblock,
    clear,
  };
}

const browserDependencies: LogsStateDependencies = {
  loadLog: loadLog(),
  loadScanErrors: loadScanErrors(),
  loadStatus: loadStatus(),
  loadOverrides: (keys) =>
    keys.length === 0
      ? Effect.succeed({})
      : browserEffect('load allow overrides', () => browser.storage.local.get([...keys])),
  subscribeStorage: (listener) => {
    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) =>
      listener(area, changes);
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  },
  unblock: (tweetId) =>
    browserEffect('unblock post', () =>
      browser.storage.local.set({ [`${OVERRIDES_PREFIX}${tweetId}`]: 'allow' }),
    ),
  clear: (type) =>
    browserEffect(type, () => browser.runtime.sendMessage({ type })).pipe(
      Effect.flatMap((reply) =>
        Schema.is(ClearSuccessSchema)(reply)
          ? Effect.void
          : Effect.fail(
              new BrowserError({ operation: type, cause: 'background did not confirm the clear' }),
            ),
      ),
    ),
};

export const logsState = createLogsState(browserDependencies);
