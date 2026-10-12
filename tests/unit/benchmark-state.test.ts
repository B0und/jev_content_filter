import { Effect, Layer, ManagedRuntime } from 'effect';
import { expect, it } from 'vitest';
import { initialBenchmarkState } from '../../benchmarks/model';
import { createBenchmarkState } from '../../benchmarks/state';
import { BenchmarkStorage, BenchmarkStorageError } from '../../benchmarks/storage';

it('rejects edits after failed hydration, then saves the recovered dataset after retry', async () => {
  let stored = initialBenchmarkState();
  const firstCase = stored.cases[0];

  if (!firstCase) throw new Error('Initial benchmark case is missing.');
  stored.cases = [{ ...firstCase, id: 'saved-case', title: 'Saved custom dataset' }];
  let reads = 0;
  const saved = Promise.withResolvers<void>();

  const runtime = ManagedRuntime.make(
    Layer.succeed(BenchmarkStorage, {
      load: Effect.suspend(() => {
        reads++;

        return reads === 1
          ? Effect.fail(new BenchmarkStorageError({ cause: 'Storage unavailable' }))
          : Effect.succeed(stored);
      }),
      save: (state) =>
        Effect.sync(() => {
          stored = state;
          saved.resolve();
        }),
    }),
  );

  const state = createBenchmarkState(runtime);
  const failed = Promise.withResolvers<void>();
  const loaded = Promise.withResolvers<void>();

  const unsubscribe = state.subscribe(() => {
    if (state.getSnapshot().storageError) failed.resolve();

    if (state.getSnapshot().storageReady) loaded.resolve();
  });

  let stop = state.start();

  try {
    await failed.promise;
    expect(state.getSnapshot().storageReady).toBe(false);
    let editAccepted = false;
    state.update((current) => {
      editAccepted = true;

      return { ...current, cases: [] };
    });
    expect(editAccepted).toBe(false);
    stop();
    stop = state.start();
    await loaded.promise;
    expect(state.getSnapshot().state.cases[0]?.title).toBe('Saved custom dataset');
    expect(state.getSnapshot().storageError).toBe('');
    state.update((current) => ({
      ...current,
      thresholds: { ...current.thresholds, contentMatch: 0.73 },
    }));
    await saved.promise;
    expect(stored.cases[0]?.id).toBe('saved-case');
    expect(stored.thresholds.contentMatch).toBe(0.73);
  } finally {
    stop();
    unsubscribe();
    await runtime.dispose();
  }
});
