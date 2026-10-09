import * as tf from '@tensorflow/tfjs';
import * as ort from 'onnxruntime-web/wasm';
import { NSFWJS } from 'nsfwjs/core';
import { explicitImageScore, loadExplicitImageModel } from './explicit';
import { ANIME_RATING_MODEL, EXPLICIT_IMAGE_MODEL, SELECTED_MODELS } from './model-catalog';
import { IMAGE_KEYS, type CategoryKey } from '../filtering/types';
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

export interface ImageClassifier {
  (dataUrl: string): Promise<ImageClassification>;
  warmup(): Promise<void>;
  isReady(): boolean;
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

/** Load local image classifiers and retain lazy independent rating verification. */
export async function loadImageModel(
  onProgress: (loaded: number, total: number) => void,
): Promise<ImageClassifier> {
  const total =
    SELECTED_MODELS.image.downloadBytes +
    ANIME_RATING_MODEL.downloadBytes +
    EXPLICIT_IMAGE_MODEL.downloadBytes;
  const model = await loadNsfwModel((loaded) => onProgress(loaded, total));
  let explicitLoaded = 0;
  let animeLoaded = 0;
  let explicitModel: ort.InferenceSession | undefined;
  let animeModel: ort.InferenceSession | undefined;
  const loadExplicit = async () => {
    explicitModel ??= await loadExplicitImageModel((loaded) => {
      explicitLoaded = loaded;
      onProgress(SELECTED_MODELS.image.downloadBytes + animeLoaded + explicitLoaded, total);
    });
  };
  const warmup = async () => {
    animeModel ??= await loadAnimeRatingModel((loaded) => {
      animeLoaded = loaded - SELECTED_MODELS.image.downloadBytes;
      onProgress(SELECTED_MODELS.image.downloadBytes + animeLoaded + explicitLoaded, total);
    });
    await loadExplicit();
  };
  const canvas = new OffscreenCanvas(1, 1);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Image decoding is unavailable in this browser.');
  /** Decode one image and verify plausible drawn content before reporting Hentai. */
  const classify = async (dataUrl: string): Promise<ImageClassification> => {
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
      let warning: string | undefined;
      try {
        await loadExplicit();
        if (!explicitModel) throw new Error('The explicit verification model is unavailable.');
        // Agreement preserves Porn semantics; binary NSFW alone also includes drawings.
        scores.porn = Math.min(scores.porn!, await explicitImageScore(explicitModel, bitmap));
      } catch (error) {
        const failed = explicitModel;
        explicitModel = undefined;
        await failed?.release().catch(() => {});
        delete scores.porn;
        warning = `Porn verification failed: ${error instanceof Error ? error.message : String(error)}. Retry to complete it.`;
      }
      const drawnEvidence = Math.min(1, scores.drawings! + scores.hentai!);
      // A high Hentai candidate must not bypass independent verification.
      if (drawnEvidence < 0.2) {
        scores.hentai = 0;
        return { scores, ...(warning ? { warning } : {}) };
      }
      try {
        await warmup();
        if (!animeModel) throw new Error('The anime rating model is unavailable.');
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
        // Agreement scores are conservative policy, not calibrated probabilities.
        scores.hentai = Math.min(drawnEvidence, values[3]!);
        // Danbooru rates general/sensitive as SFW; reserve this boundary for q/e.
        scores.sexy = Math.max(scores.sexy!, Math.min(drawnEvidence, values[2]! + values[3]!));
        return { scores, ...(warning ? { warning } : {}) };
      } catch (error) {
        const failed = animeModel;
        animeModel = undefined;
        await failed?.release().catch(() => {});
        delete scores.hentai;
        return {
          scores,
          warning: `${warning ? warning + ' ' : ''}Anime sensitivity check failed: ${error instanceof Error ? error.message : String(error)}. Retry to complete it.`,
        };
      }
    } finally {
      bitmap.close();
    }
  };
  return Object.assign(classify, {
    warmup,
    isReady: () => animeModel !== undefined && explicitModel !== undefined,
  });
}
