import { Effect, Layer, ManagedRuntime } from 'effect';
import * as Schema from 'effect/Schema';

export class BrowserError extends Schema.TaggedError<BrowserError>()('BrowserError', {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `${this.operation}: ${String(this.cause)}`;
  }
}

export const browserEffect = <A>(
  operation: string,
  thunk: (signal: AbortSignal) => PromiseLike<A>,
): Effect.Effect<A, BrowserError> =>
  Effect.tryPromise({
    try: thunk,
    catch: (cause) => new BrowserError({ operation, cause }),
  });

export const browserRuntime = ManagedRuntime.make(Layer.empty);
