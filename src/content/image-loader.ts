// Runtime URL loading keeps the TensorFlow model out of the content-script IIFE.
import { Effect } from 'effect';
import { browser } from 'wxt/browser';
import { BrowserError, browserEffect } from '../shared/browser';
import type { ImageClassifier } from './image-model';

let classifier: ImageClassifier | undefined;

export const loadImageClassifier = Effect.fnUntraced(function* () {
  if (classifier) return classifier;
  yield* browserEffect('load image inference module', async () => {
    await import(/* @vite-ignore */ browser.runtime.getURL('/image-inference.js'));
  });
  const loaded = globalThis.jevImageClassifier;
  if (!loaded) {
    return yield* new BrowserError({
      operation: 'initialize image classifier',
      cause: new Error('Image classifier did not initialize.'),
    });
  }
  classifier = loaded;
  return loaded;
});
