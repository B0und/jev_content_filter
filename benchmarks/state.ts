import { Effect, Fiber, type ManagedRuntime, Semaphore } from 'effect';
import { initialBenchmarkState, type BenchmarkState } from './model';
import {
  BenchmarkStorage,
  benchmarkRuntime,
  loadBenchmarkState,
  saveBenchmarkState,
} from './storage';

export interface BenchmarkSnapshot {
  state: BenchmarkState;
  storageReady: boolean;
  storageError: string;
}

export function createBenchmarkState(
  runtime: ManagedRuntime.ManagedRuntime<BenchmarkStorage, never> = benchmarkRuntime,
) {
  const subscribers = new Set<() => void>();
  const writes = Semaphore.makeUnsafe(1);
  let revision = 0;
  let snapshot: BenchmarkSnapshot = {
    state: initialBenchmarkState(),
    storageReady: false,
    storageError: '',
  };

  function publish(changes: Partial<BenchmarkSnapshot>) {
    snapshot = { ...snapshot, ...changes };
    for (const listener of subscribers) listener();
  }

  function start() {
    if (snapshot.storageReady) return () => {};
    const fiber = runtime.runFork(
      loadBenchmarkState.pipe(
        Effect.match({
          onSuccess: (state) => publish({ state, storageReady: true, storageError: '' }),
          onFailure: (error) => publish({ storageReady: false, storageError: error.message }),
        }),
      ),
    );
    return () => {
      runtime.runFork(Fiber.interrupt(fiber));
    };
  }

  function update(edit: (state: BenchmarkState) => BenchmarkState) {
    if (!snapshot.storageReady) return;
    const state = edit(snapshot.state);
    if (state === snapshot.state) return;
    const submittedRevision = ++revision;
    publish({ state });
    runtime.runFork(
      writes.withPermits(1)(
        saveBenchmarkState(state).pipe(
          Effect.match({
            onSuccess: () => {
              if (submittedRevision === revision) publish({ storageError: '' });
            },
            onFailure: (error) => {
              if (submittedRevision === revision) publish({ storageError: error.message });
            },
          }),
        ),
      ),
    );
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    start,
    update,
  };
}

export const benchmarkState = createBenchmarkState();
