import { Context, Effect, Layer, ManagedRuntime, Semaphore } from 'effect';
import * as Schema from 'effect/Schema';
import { normalizeBenchmarkState, type BenchmarkState } from './model';

export class BenchmarkStorageError extends Schema.TaggedError<BenchmarkStorageError>()(
  'BenchmarkStorageError',
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

export class BenchmarkStorage extends Context.Service<
  BenchmarkStorage,
  {
    readonly load: Effect.Effect<BenchmarkState, BenchmarkStorageError>;
    readonly save: (state: BenchmarkState) => Effect.Effect<void, BenchmarkStorageError>;
  }
>()('jev/benchmarks/BenchmarkStorage') {
  static readonly layer = Layer.effect(
    BenchmarkStorage,
    Effect.gen(function* () {
      const writes = yield* Semaphore.make(1);
      const request = Effect.fn('BenchmarkStorage.request')(function* (
        method: 'GET' | 'POST',
        state?: BenchmarkState,
      ) {
        const value = yield* Effect.tryPromise({
          try: async (signal) => {
            const init: RequestInit = { method, credentials: 'same-origin', signal };
            if (method === 'POST' && state) {
              init.headers = { 'Content-Type': 'application/json' };
              init.body = JSON.stringify(state);
            }
            const response = await fetch('/api/benchmark/state', init);
            if (!response.ok)
              throw new Error(`SQLite storage request failed (${response.status}).`);
            const payload: unknown = await response.json();
            return payload;
          },
          catch: (cause) => new BenchmarkStorageError({ cause }),
        });
        return normalizeBenchmarkState(value);
      });
      return BenchmarkStorage.of({
        load: request('GET'),
        save: (state) =>
          request('POST', state).pipe(Effect.asVoid, Semaphore.withPermits(writes, 1)),
      });
    }),
  );
}

export const benchmarkRuntime = ManagedRuntime.make(BenchmarkStorage.layer);

export const loadBenchmarkState = Effect.gen(function* () {
  return yield* (yield* BenchmarkStorage).load;
});

export const saveBenchmarkState = Effect.fn('saveBenchmarkState')(function* (
  state: BenchmarkState,
) {
  yield* (yield* BenchmarkStorage).save(state);
});
