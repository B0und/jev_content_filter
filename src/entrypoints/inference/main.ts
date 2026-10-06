import { Effect, Layer, ManagedRuntime } from 'effect';
import * as Schema from 'effect/Schema';
import { browser } from 'wxt/browser';
import { BrowserError, browserEffect } from '../../platform/browser';
import {
  InferenceRequestSchema,
  InferenceReplySchema,
  OcrReplyCodec,
  OcrError,
  encodeOcrReply,
  ModelStatusesSchema,
  initialModelStatuses,
  type InferenceRequest,
} from '../../inference/contracts';
import { createWorkerSupervisor } from './worker-supervisor';

const WorkerReplySchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('result'), id: Schema.Int, reply: Schema.Unknown }),
  Schema.Struct({ type: Schema.Literal('ocr-result'), id: Schema.Int, reply: Schema.Unknown }),
  Schema.Struct({ type: Schema.Literal('status'), models: ModelStatusesSchema }),
]);
const runtime = ManagedRuntime.make(Layer.empty);
const pending = new Map<
  number,
  { resolve: (reply: unknown) => void; reject: (error: Error) => void }
>();
let nextId = 0;
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
const supervisor = createWorkerSupervisor({
  start: (handlers) => {
    const instance = new Worker(new URL('../../inference/worker.ts', import.meta.url), {
      type: 'module',
    });
    instance.onmessage = handlers.onMessage;
    instance.onerror = handlers.onError;
    return {
      postMessage: (message) => instance.postMessage(message),
      terminate: () => instance.terminate(),
    };
  },
  onMessage: (event) => {
    if (!Schema.is(WorkerReplySchema)(event.data)) return;
    if (event.data.type === 'status') {
      statuses = event.data.models;
      persistStatus();
      return;
    }
    const reply = pending.get(event.data.id);
    pending.delete(event.data.id);
    reply?.resolve(event.data.reply);
    supervisor.complete(event.data.id);
  },
  // A crashed graph (WASM abort, failed worker setup) must not disable local
  // filtering for the session: the supervisor drops the worker and the next
  // request starts a replacement.
  onFailure: (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    for (const kind of ['image', 'aiText'] as const)
      statuses[kind] = { ...statuses[kind], state: 'error', error: error.message };
    persistStatus();
  },
});
const runRaw = Effect.fn('InferenceWorker.runRaw')(function* (request: InferenceRequest) {
  const id = ++nextId;
  return yield* Effect.tryPromise({
    try: (signal) =>
      new Promise<unknown>((resolve, reject) => {
        const onAbort = () => {
          pending.delete(id);
          supervisor.cancel(id);
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
        const admissionError = supervisor.send({ id, request });
        if (admissionError) {
          pending.delete(id);
          cleanup();
          reject(admissionError);
        }
      }),
    catch: (cause) => new BrowserError({ operation: 'run local inference', cause }),
  });
});
const run = Effect.fn('InferenceWorker.run')(function* (request: InferenceRequest) {
  const raw = yield* runRaw(request);
  return yield* Schema.decodeUnknownEffect(InferenceReplySchema)(raw).pipe(
    Effect.mapError((cause) => new BrowserError({ operation: 'decode inference result', cause })),
  );
});
const runOcr = Effect.fn('InferenceWorker.runOcr')(function* (request: InferenceRequest) {
  const raw = yield* runRaw(request);
  const result = yield* Schema.decodeUnknownEffect(OcrReplyCodec)(raw).pipe(
    Effect.mapError((cause) => new OcrError({ message: cause.message })),
  );
  return yield* Effect.fromResult(result);
});
browser.runtime.onMessage.addListener((request: unknown, sender, sendResponse) => {
  if (sender.id !== browser.runtime.id || sender.tab || !Schema.is(InferenceRequestSchema)(request))
    return undefined;
  if (request.operation === 'ocr') {
    runtime.runFork(
      encodeOcrReply(runOcr(request)).pipe(
        Effect.tap((reply) => Effect.sync(() => sendResponse(reply))),
      ),
    );
    return true;
  }
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
    supervisor.terminate();
    for (const request of pending.values())
      request.reject(new Error('Local inference document closed.'));
    pending.clear();
    void runtime.dispose();
  },
  { once: true },
);
