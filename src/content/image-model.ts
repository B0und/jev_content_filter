import { load as loadNsfwCore, type NSFWJS } from 'nsfwjs/core';
import { MobileNetV2Model } from 'nsfwjs/models/mobilenet_v2';
import { browser as tfBrowser, type Tensor3D } from '@tensorflow/tfjs';

export interface ImageClassifier {
  classify(bitmap: ImageBitmap): Promise<Array<{ className: string; probability: number }>>;
}

declare global {
  var jevImageClassifier: ImageClassifier | undefined;
}

let modelPromise: Promise<NSFWJS> | null = null;

export const imageClassifier: ImageClassifier = {
  async classify(bitmap) {
    modelPromise ??= loadNsfwCore('MobileNetV2', {
      size: 224,
      modelDefinitions: [MobileNetV2Model],
    }).catch((error) => {
      modelPromise = null;
      throw error;
    });
    const model = await modelPromise;
    let pixels: Tensor3D | undefined;
    try {
      pixels = tfBrowser.fromPixels(bitmap, 3);
      return await model.classify(pixels);
    } finally {
      pixels?.dispose();
    }
  },
};
