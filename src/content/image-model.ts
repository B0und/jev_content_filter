import { Effect } from 'effect';
import { load as loadNsfwCore } from 'nsfwjs/core';
import type { NSFWJS } from 'nsfwjs/core';
import { MobileNetV2Model } from 'nsfwjs/models/mobilenet_v2';
import { browser as tfBrowser } from '@tensorflow/tfjs';
import { BrowserError, browserEffect } from '../shared/browser';

export interface ImageClassifier {
  classify(
    bitmap: ImageBitmap,
  ): Effect.Effect<Array<{ className: string; probability: number }>, BrowserError>;
}

declare global {
  var jevImageClassifier: ImageClassifier | undefined;
}

let model: NSFWJS | undefined;

const loadModel = Effect.suspend(() => {
  if (model) return Effect.succeed(model);
  return browserEffect('load NSFWJS model', () =>
    loadNsfwCore('MobileNetV2', {
      size: 224,
      modelDefinitions: [MobileNetV2Model],
    }),
  ).pipe(Effect.tap((loaded) => Effect.sync(() => (model = loaded))));
});

export const imageClassifier: ImageClassifier = {
  classify(bitmap) {
    return Effect.gen(function* () {
      const loaded = yield* loadModel;
      const pixels = yield* Effect.try({
        try: () => tfBrowser.fromPixels(bitmap, 3),
        catch: (cause) => new BrowserError({ operation: 'prepare image pixels', cause }),
      });
      return yield* Effect.acquireUseRelease(
        Effect.succeed(pixels),
        (tensor) =>
          // NSFWJS exposes no cancellation signal. Keep its global inference
          // serialized until the native Promise settles; interruption then
          // prevents the cancelled scan from consuming its result.
          Effect.uninterruptible(
            browserEffect('classify image locally', () => loaded.classify(tensor)),
          ),
        (tensor) => Effect.sync(() => tensor.dispose()),
      );
    });
  },
};
