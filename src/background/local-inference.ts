import { Effect, Semaphore } from 'effect';
import * as Schema from 'effect/Schema';
import { browser } from 'wxt/browser';
import { BrowserError, browserEffect } from '../platform/browser';
import {
  InferenceReplySchema,
  OcrReplyCodec,
  OcrError,
  type InferenceRequest,
  type InferenceReply,
  type ModelKind,
} from '../inference/contracts';

const documentLock = Semaphore.makeUnsafe(1);

const ensureDocument = documentLock.withPermits(1)(
  browserEffect('open local inference document', async () => {
    if (await browser.offscreen.hasDocument()) return;
    await browser.offscreen.createDocument({
      url: '/inference.html',
      reasons: ['WORKERS'],
      justification:
        'Run locally cached image and AI-text classifiers in one shared inference worker.',
    });
  }),
);

export const runLocalInference = Effect.fn('runLocalInference')(function* (
  request: InferenceRequest,
): Effect.fn.Return<InferenceReply, BrowserError> {
  yield* ensureDocument;

  const raw: unknown = yield* browserEffect('request local inference', () =>
    browser.runtime.sendMessage(request),
  );

  return yield* Schema.decodeUnknownEffect(InferenceReplySchema)(raw).pipe(
    Effect.mapError(
      (cause) => new BrowserError({ operation: 'decode local inference reply', cause }),
    ),
  );
});

export const warmLocalModels = Effect.fn('warmLocalModels')(function* (models: ModelKind[]) {
  if (!models.length) return;

  const reply = yield* runLocalInference({
    target: 'local-inference',
    operation: 'warmup',
    models,
  });

  if (!reply.ok)
    return yield* new BrowserError({ operation: 'load local models', cause: reply.error });
});

/** Request OCR through the offscreen document and restore its typed error channel. */
export const runLocalOcr = Effect.fn('runLocalOcr')(function* (dataUrl: string) {
  yield* ensureDocument;

  const raw: unknown = yield* browserEffect('request local OCR', () =>
    browser.runtime.sendMessage({ target: 'local-inference', operation: 'ocr', dataUrl }),
  );

  const result = yield* Schema.decodeUnknownEffect(OcrReplyCodec)(raw).pipe(
    Effect.mapError((cause) => new OcrError({ message: cause.message })),
  );

  return yield* Effect.fromResult(result);
});
