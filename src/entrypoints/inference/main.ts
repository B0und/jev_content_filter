import { Effect, Layer, ManagedRuntime } from 'effect';
import * as Schema from 'effect/Schema';
import { browser } from 'wxt/browser';
import { BrowserError, browserEffect } from '../../shared/browser';
import {
  InferenceRequestSchema,
  InferenceReplySchema,
  ModelStatusesSchema,
  initialModelStatuses,
  type InferenceRequest,
  type InferenceReply,
} from '../../shared/inference';

const WorkerReplySchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('result'), id: Schema.Int, reply: InferenceReplySchema }),
  Schema.Struct({ type: Schema.Literal('status'), models: ModelStatusesSchema }),
]);
const runtime = ManagedRuntime.make(Layer.empty);
const pending = new Map<
  number,
  { resolve: (reply: InferenceReply) => void; reject: (error: Error) => void }
>();
const worker = new Worker(new URL('../../inference/worker.ts', import.meta.url), {
  type: 'module',
});
let nextId = 0;
let workerFailure: Error | undefined;
let statuses = initialModelStatuses();
let persistScheduled = false;
const persistStatus = () => {
  if (persistScheduled) return;
  persistScheduled = true;
  runtime.runFork(
    Effect.sleep(200).pipe(
      Effect.andThen(
        browserEffect('publish local model status', () => {
          persistScheduled = false;
          return browser.runtime.sendMessage({ type: 'local-model-status', models: statuses });
        }),
      ),
      Effect.ignore,
    ),
  );
};
worker.onmessage = (event: MessageEvent<unknown>) => {
  if (!Schema.is(WorkerReplySchema)(event.data)) return;
  if (event.data.type === 'status') {
    statuses = event.data.models;
    persistStatus();
  } else {
    const reply = pending.get(event.data.id);
    pending.delete(event.data.id);
    reply?.resolve(event.data.reply);
  }
};
worker.onerror = (event) => {
  const error = new Error(
    event.message || 'Local inference worker stopped. Reload the extension to retry.',
  );
  workerFailure = error;
  for (const request of pending.values()) request.reject(error);
  pending.clear();
  for (const kind of ['image', 'aiText'] as const)
    statuses[kind] = { ...statuses[kind], state: 'error', error: error.message };
  persistStatus();
};
const run = Effect.fn('InferenceWorker.run')(function* (request: InferenceRequest) {
  if (workerFailure)
    return yield* new BrowserError({ operation: 'run local inference', cause: workerFailure });
  const id = ++nextId;
  return yield* Effect.tryPromise({
    try: (signal) =>
      new Promise<InferenceReply>((resolve, reject) => {
        const onAbort = () => {
          pending.delete(id);
          reject(new Error('Local inference request cancelled.'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        pending.set(id, {
          resolve: (reply) => {
            cleanup();
            resolve(reply);
          },
          reject: (error) => {
            cleanup();
            reject(error);
          },
        });
        worker.postMessage({ id, request });
      }),
    catch: (cause) => new BrowserError({ operation: 'run local inference', cause }),
  });
});
browser.runtime.onMessage.addListener((request: unknown, sender, sendResponse) => {
  if (sender.id !== browser.runtime.id || sender.tab || !Schema.is(InferenceRequestSchema)(request))
    return undefined;
  runtime.runFork(
    run(request).pipe(
      Effect.match({
        onSuccess: sendResponse,
        onFailure: (error) => sendResponse({ ok: false, error: error.message }),
      }),
    ),
  );
  return true;
});
window.addEventListener(
  'pagehide',
  () => {
    worker.terminate();
    for (const request of pending.values())
      request.reject(new Error('Local inference document closed.'));
    pending.clear();
    void runtime.dispose();
  },
  { once: true },
);
