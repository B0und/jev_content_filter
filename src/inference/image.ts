import * as tf from '@tensorflow/tfjs';
import * as ort from 'onnxruntime-web/wasm';
import { NSFWJS } from 'nsfwjs/core';
import { ANIME_RATING_MODEL, SELECTED_MODELS } from '../shared/model-catalog';
import { IMAGE_KEYS, type CategoryKey } from '../shared/types';
import { downloadModelFile } from './download';

const MODEL_SIZE = 224;
const ANIME_SIZE = 384;
const MODEL_JSON_FILE = 'model.json';
// Bound canvas and tensor copies without changing NSFWJS's resize semantics.
const MAX_IMAGE_PIXELS = 4096 * 4096;
const MODEL_LABEL_TO_CATEGORY: Partial<Record<string, CategoryKey>> = {
  Drawing: 'drawings',
  Hentai: 'hentai',
  Porn: 'porn',
  Sexy: 'sexy',
};

export interface ImageClassification {
  scores: Partial<Record<CategoryKey, number>>;
  warning?: string;
}

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

async function loadAnimeRatingModel(
  onProgress: (loaded: number, total: number) => void,
): Promise<ort.InferenceSession> {
  // The pinned ONNX artifact is shipped with the extension. This avoids
  // relying on Hugging Face's redirect/CDN CORS behavior at runtime.
  const url = new URL('/models/anime-dbrating.onnx', self.location.href).href;
  const data = await downloadModelFile(url, (loaded) =>
    onProgress(
      SELECTED_MODELS.image.downloadBytes + loaded,
      SELECTED_MODELS.image.downloadBytes + ANIME_RATING_MODEL.downloadBytes,
    ),
  );
  if (data.byteLength !== ANIME_RATING_MODEL.downloadBytes) {
    throw new Error(
      `The anime rating model download was incomplete (${data.byteLength} of ${ANIME_RATING_MODEL.downloadBytes} bytes).`,
    );
  }
  return ort.InferenceSession.create(data, { executionProviders: ['wasm'] });
}

function animeInput(bitmap: ImageBitmap): ort.Tensor {
  const canvas = new OffscreenCanvas(ANIME_SIZE, ANIME_SIZE);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Anime image preprocessing is unavailable.');
  context.fillStyle = 'white';
  context.fillRect(0, 0, ANIME_SIZE, ANIME_SIZE);
  context.drawImage(bitmap, 0, 0, ANIME_SIZE, ANIME_SIZE);
  const pixels = context.getImageData(0, 0, ANIME_SIZE, ANIME_SIZE).data;
  const plane = ANIME_SIZE * ANIME_SIZE;
  const data = new Float32Array(plane * 3);
  for (let index = 0; index < plane; index += 1) {
    const offset = index * 4;
    data[index] = (pixels[offset]! / 255) * 2 - 1;
    data[plane + index] = (pixels[offset + 1]! / 255) * 2 - 1;
    data[plane * 2 + index] = (pixels[offset + 2]! / 255) * 2 - 1;
  }
  return new ort.Tensor('float32', data, [1, 3, ANIME_SIZE, ANIME_SIZE]);
}

export async function loadImageModel(
  onProgress: (loaded: number, total: number) => void,
): Promise<(dataUrl: string) => Promise<ImageClassification>> {
  const model = await loadNsfwModel((loaded) =>
    onProgress(loaded, SELECTED_MODELS.image.downloadBytes + ANIME_RATING_MODEL.downloadBytes),
  );
  let animeModel: ort.InferenceSession | undefined;
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
      if (scores.drawings! < 0.5) return { scores };
      try {
        animeModel ??= await loadAnimeRatingModel(onProgress);
        const inputName = animeModel.inputNames[0];
        const outputName = animeModel.outputNames[0];
        if (!inputName || !outputName)
          throw new Error('The anime rating model omitted input or output metadata.');
        const animeResult = await animeModel.run({ [inputName]: animeInput(bitmap) });
        const animeValues = animeResult[outputName]?.data;
        if (!animeValues || animeValues.length !== 4)
          throw new Error('The anime rating model returned an unexpected output.');
        const values = Array.from(animeValues, Number);
        if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1))
          throw new Error('The anime rating model returned invalid probabilities.');
        if (scores.drawings! >= 0.5) {
          scores.sexy = Math.max(
            scores.sexy!,
            Math.min(1, Number(animeValues[1]) + Number(animeValues[2]) + Number(animeValues[3])),
          );
        }
        return { scores };
      } catch (error) {
        const failed = animeModel;
        animeModel = undefined;
        await failed?.release().catch(() => {});
        return {
          scores,
          warning: `Anime sensitivity check failed: ${error instanceof Error ? error.message : String(error)}. Retry to complete it.`,
        };
      }
    } finally {
      bitmap.close();
    }
  };
}
