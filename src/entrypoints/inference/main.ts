import { Effect, Layer, ManagedRuntime } from 'effect';
import * as Schema from 'effect/Schema';
import { browser } from 'wxt/browser';
import { BrowserError, browserEffect } from '../../platform/browser';
import {
  InferenceRequestSchema,
  OcrReplyCodec,
  OcrError,
  encodeOcrReply,
  ModelStatusesSchema,
  initialModelStatuses,
  type InferenceRequest,
} from '../../inference/contracts';
import { createWorkerSupervisor } from './worker-supervisor';
import { createPendingReplies, type InferenceResultEnvelope } from './pending-replies';

const WorkerStatusSchema = Schema.Struct({
  type: Schema.Literal('status'),
  models: ModelStatusesSchema,
});

const runtime = ManagedRuntime.make(Layer.empty);

const pending = createPendingReplies();

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
    if (Schema.is(WorkerStatusSchema)(event.data)) {
      statuses = event.data.models;
      persistStatus();

      return;
    }

    const id = pending.settle(event);

    if (id !== null) supervisor.complete(id);
  },
  // A crashed graph (WASM abort, failed worker setup) must not disable local
  // filtering for the session: the supervisor drops the worker and the next
  // request starts a replacement.
  onFailure: (error) => {
    pending.failAll(error);

    for (const kind of ['image', 'aiText'] as const)
      statuses[kind] = { ...statuses[kind], state: 'error', error: error.message };
    persistStatus();
  },
});

/** Submit supervised work, correlating its reply and cancelling queued work on interruption. */
const runRaw = Effect.fn('InferenceWorker.runRaw')(function* (request: InferenceRequest) {
  const id = ++nextId;

  return yield* Effect.tryPromise({
    try: (signal) =>
      new Promise<InferenceResultEnvelope>((resolve, reject) => {
        const onAbort = () => {
          pending.cancel(id);
          supervisor.cancel(id);
          reject(new Error('Local inference request cancelled.'));
        };

        signal.addEventListener('abort', onAbort, { once: true });
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        pending.add(id, {
          expected: request.operation === 'ocr' ? 'ocr-result' : 'result',
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
          pending.cancel(id);
          cleanup();
          reject(admissionError);
        }
      }),
    catch: (cause) => new BrowserError({ operation: 'run local inference', cause }),
  });
});

/** Validate a classifier reply before returning it across the browser message boundary. */
const run = Effect.fn('InferenceWorker.run')(function* (request: InferenceRequest) {
  const raw = yield* runRaw(request);

  if (raw.type !== 'result')
    return yield* new BrowserError({
      operation: 'decode inference result',
      cause: 'Unexpected OCR reply.',
    });

  return raw.reply;
});

/** Decode an OCR Result and restore its success or OcrError channel. */
const runOcr = Effect.fn('InferenceWorker.runOcr')(function* (request: InferenceRequest) {
  const raw = yield* runRaw(request);

  if (raw.type !== 'ocr-result')
    return yield* new OcrError({ message: 'Unexpected classifier reply.' });

  const result = yield* Schema.decodeEffect(OcrReplyCodec)(raw.reply).pipe(
    Effect.mapError((cause) => new OcrError({ message: cause.message })),
  );

  return yield* Effect.fromResult(result);
});

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This boundary validates untrusted data before exposing domain values.
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

    pending.failAll(new Error('Local inference document closed.'));
    void runtime.dispose();
  },
  { once: true },
);
