import { browser } from 'wxt/browser';
import type { ImageClassifier } from './image-model';

let classifierPromise: Promise<ImageClassifier> | null = null;

export function loadImageClassifier(): Promise<ImageClassifier> {
  classifierPromise ??= (async () => {
    // A static import would inline TF/model weights into WXT's IIFE content bundle.
    // The runtime-selected extension URL loads the packaged script only on a cache miss.
    await import(/* @vite-ignore */ browser.runtime.getURL('/image-inference.js'));
    if (!globalThis.jevImageClassifier) throw new Error('Image classifier did not initialize.');
    return globalThis.jevImageClassifier;
  })().catch((error) => {
    classifierPromise = null;
    throw error;
  });
  return classifierPromise;
}
