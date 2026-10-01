import * as tf from '@tensorflow/tfjs';
import { NSFWJS } from 'nsfwjs/core';
import { SELECTED_MODELS } from '../shared/model-catalog';
import { IMAGE_KEYS, type CategoryKey } from '../shared/types';
import { downloadModelFile } from './download';

const MODEL_SIZE = 224;
const MODEL_JSON_FILE = 'model.json';
// Bound canvas and tensor copies without changing NSFWJS's resize semantics.
const MAX_IMAGE_PIXELS = 4096 * 4096;
const MODEL_LABEL_TO_CATEGORY: Partial<Record<string, CategoryKey>> = {
  Drawing: 'drawings',
  Hentai: 'hentai',
  Porn: 'porn',
  Sexy: 'sexy',
};

function releaseMemoryHandlerAfterLoad(handler: tf.io.IOHandler): tf.io.IOHandler {
  let pendingHandler: tf.io.IOHandler | undefined = handler;
  return {
    async load() {
      const currentHandler = pendingHandler;
      pendingHandler = undefined;
      if (!currentHandler?.load) throw new Error('The in-memory image model could not be loaded.');
      return currentHandler.load();
    },
  };
}

async function loadNsfwModel(onProgress: (loaded: number, total: number) => void): Promise<NSFWJS> {
  const selected = SELECTED_MODELS.image;
  const files = new Map<string, ArrayBuffer>();
  let loadedBytes = 0;
  for (const file of selected.files) {
    const url = new URL(file, `${selected.baseUrl}/`).href;
    const data = await downloadModelFile(url, (loaded) => {
      onProgress(loadedBytes + loaded, selected.downloadBytes);
    });
    loadedBytes += data.byteLength;
    files.set(file, data);
  }
  if (loadedBytes !== selected.downloadBytes) {
    throw new Error(
      `The image model download was incomplete (${loadedBytes} of ${selected.downloadBytes} bytes).`,
    );
  }

  const modelJsonBytes = files.get(MODEL_JSON_FILE);
  if (!modelJsonBytes) throw new Error('The image model manifest was not downloaded.');
  const modelJson: tf.io.ModelJSON = JSON.parse(new TextDecoder().decode(modelJsonBytes));
  const weightPaths = modelJson.weightsManifest.flatMap((group) => group.paths);
  const selectedWeightFiles = selected.files.filter((file) => file !== MODEL_JSON_FILE);
  if (
    weightPaths.length !== selectedWeightFiles.length ||
    weightPaths.some((file, index) => file !== selectedWeightFiles[index])
  ) {
    throw new Error('The image model manifest does not match its pinned weight files.');
  }

  const weightData = weightPaths.map((file) => {
    const data = files.get(file);
    if (!data) throw new Error(`The image model weight file '${file}' was not downloaded.`);
    return data;
  });
  const modelArtifacts: tf.io.ModelArtifacts = {
    modelTopology: modelJson.modelTopology,
    weightSpecs: modelJson.weightsManifest.flatMap((group) => group.weights),
    weightData,
  };
  const memoryHandler = tf.io.fromMemory(modelArtifacts);
  const model = new NSFWJS(releaseMemoryHandlerAfterLoad(memoryHandler), {
    size: MODEL_SIZE,
  });
  await tf.ready();
  await model.load();
  files.clear();
  return model;
}

export async function loadImageModel(
  onProgress: (loaded: number, total: number) => void,
): Promise<(dataUrl: string) => Promise<Partial<Record<CategoryKey, number>>>> {
  const model = await loadNsfwModel(onProgress);
  const canvas = new OffscreenCanvas(1, 1);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Image decoding is unavailable in this browser.');
  return async (dataUrl) => {
    const response = await fetch(dataUrl);
    if (!response.ok) throw new Error(`Image decoding failed (${response.status}).`);
    const bitmap = await createImageBitmap(await response.blob());
    try {
      if (bitmap.width * bitmap.height > MAX_IMAGE_PIXELS) {
        throw new Error(`Image exceeds the ${MAX_IMAGE_PIXELS}-pixel local inference budget.`);
      }
      if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
      if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
      context.globalCompositeOperation = 'copy';
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const predictions = await model.classify(pixels);
      const scores: Partial<Record<CategoryKey, number>> = {};
      for (const prediction of predictions) {
        const category = MODEL_LABEL_TO_CATEGORY[prediction.className];
        if (category) scores[category] = prediction.probability;
      }
      for (const key of IMAGE_KEYS) {
        if (typeof scores[key] !== 'number' || !Number.isFinite(scores[key])) {
          throw new Error(`The image model omitted its '${key}' score.`);
        }
      }
      return scores;
    } finally {
      bitmap.close();
    }
  };
}
