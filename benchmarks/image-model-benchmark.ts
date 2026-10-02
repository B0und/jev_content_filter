import { pipeline, env as transformersEnv } from '@huggingface/transformers';
import * as ort from 'onnxruntime-web/wasm';
import * as tf from '@tensorflow/tfjs';
import { load as loadNsfwCore } from 'nsfwjs/core';
import { MobileNetV2Model } from 'nsfwjs/models/mobilenet_v2';
import { ANIME_RATING_MODEL, SELECTED_MODELS } from '../src/shared/model-catalog';
import { loadImageModel } from '../src/inference/image';

const FIXTURES_URL = '/image-model-fixtures.json';
const SMALL_MODEL_URL = '/__benchmark_model/mobilenetv4.onnx';
const SMALL_MODEL_LABELS = ['drawings', 'hentai', 'neutral', 'porn', 'sexy'] as const;
const IMAGE_SIZE = 224;
const RESIZE_EDGE = Math.round(IMAGE_SIZE / 0.875);
const IMAGE_MEAN = [0.485, 0.456, 0.406] as const;
const IMAGE_STD = [0.229, 0.224, 0.225] as const;
const NSFWJS_CLASSES = ['drawings', 'hentai', 'neutral', 'porn', 'sexy'] as const;
const NSFWJS_MODEL_BYTES = 3_600_073;

interface FixtureCase {
  id: string;
  title: string;
  labels: { sexualContent: 'yes' | 'no' };
  category: string;
  assetFile: string;
}

interface FixtureManifest {
  corpusId: string;
  split: { name: string; seed: string; method: string };
  cases: FixtureCase[];
  selectionRule: {
    revision: string;
    expectedFilenames: string[];
    labelKey: string;
    labelValue: string;
    sortKey: string;
    count: number;
  };
}

type PredictionCase = {
  caseId: string;
  score: number | null;
  rawScores: Record<string, number> | null;
  prediction: 'yes' | 'no' | null;
  correct: boolean | null;
  latencyMs: number | null;
  error?: string;
};

type ModelRun = {
  id: string;
  name: string;
  revision: string;
  artifactBytes: number;
  quantization: string;
  runtime: string;
  loadingMs: number | null;
  warmupMs: number | null;
  predictions: PredictionCase[];
  error?: string;
  preprocessing?: string;
};

function setResult(state: 'running' | 'done' | 'failed', value: unknown) {
  const element = document.querySelector<HTMLPreElement>('#result');
  if (!element) throw new Error('Missing result element');
  element.dataset.state = state;
  element.textContent = JSON.stringify(value);
}

async function waitForFrame(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  requestAnimationFrame(() => resolve());
  await promise;
}

async function loadImage(caseId: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.decoding = 'async';
  image.src = `/__benchmark_asset/${encodeURIComponent(caseId)}`;
  await image.decode();
  return image;
}
function canvasInput(image: HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create the Transformers.js input canvas');
  context.drawImage(image, 0, 0);
  return canvas;
}

function sexualScoreFromFiveClass(scores: Record<string, number>): number {
  const porn = scores.porn;
  if (typeof porn !== 'number') throw new Error("Model omitted required 'porn' label");
  const hentai = scores.hentai;
  if (typeof hentai !== 'number') throw new Error("Model omitted required 'hentai' label");
  const sexy = scores.sexy;
  if (typeof sexy !== 'number') throw new Error("Model omitted required 'sexy' label");
  return porn + hentai + sexy;
}

function summarizePredictions(
  cases: FixtureCase[],
  raw: Array<{
    caseId: string;
    score: number;
    rawScores: Record<string, number>;
    latencyMs: number;
  }>,
): PredictionCase[] {
  return cases.map((item) => {
    const prediction = raw.find((candidate) => candidate.caseId === item.id);
    if (!prediction) {
      return {
        caseId: item.id,
        score: null,
        rawScores: null,
        prediction: null,
        correct: null,
        latencyMs: null,
        error: 'No prediction returned',
      };
    }
    const label = prediction.score >= 0.5 ? 'yes' : 'no';
    return {
      caseId: item.id,
      score: prediction.score,
      rawScores: prediction.rawScores,
      prediction: label,
      correct: label === item.labels.sexualContent,
      latencyMs: prediction.latencyMs,
    };
  });
}

function firstCase(cases: FixtureCase[]): FixtureCase {
  const item = cases[0];
  if (!item) throw new Error('Image benchmark requires at least one fixture case.');
  return item;
}

function cubicWeight(x: number): number {
  const distance = Math.abs(x);
  if (distance < 1) return (1.5 * distance - 2.5) * distance * distance + 1;
  if (distance < 2) return ((-0.5 * distance + 2.5) * distance - 4) * distance + 2;
  return 0;
}

function axisWeights(sourceLength: number, targetLength: number) {
  const scale = sourceLength / targetLength;
  const filterScale = Math.max(1, scale);
  const support = 2 * filterScale;
  return Array.from({ length: targetLength }, (_, outputIndex) => {
    const center = (outputIndex + 0.5) * scale;
    const first = Math.max(0, Math.ceil(center - support - 0.5));
    const last = Math.min(sourceLength - 1, Math.floor(center + support - 0.5));
    const samples: Array<{ index: number; weight: number }> = [];
    let total = 0;
    for (let sourceIndex = first; sourceIndex <= last; sourceIndex += 1) {
      const weight = cubicWeight((sourceIndex + 0.5 - center) / filterScale);
      if (weight === 0) continue;
      samples.push({ index: sourceIndex, weight });
      total += weight;
    }
    return samples.map(({ index, weight }) => ({ index, weight: weight / total }));
  });
}

function resizeBicubic(
  rgb: Uint8ClampedArray,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
) {
  const horizontalWeights = axisWeights(sourceWidth, width);
  const verticalWeights = axisWeights(sourceHeight, height);
  const horizontal = new Float32Array(width * sourceHeight * 3);
  const output = new Float32Array(width * height * 3);

  for (let y = 0; y < sourceHeight; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const targetOffset = (y * width + x) * 3;
      for (const { index, weight } of horizontalWeights[x]!) {
        const sourceOffset = (y * sourceWidth + index) * 4;
        horizontal[targetOffset] = horizontal[targetOffset]! + rgb[sourceOffset]! * weight;
        horizontal[targetOffset + 1] =
          horizontal[targetOffset + 1]! + rgb[sourceOffset + 1]! * weight;
        horizontal[targetOffset + 2] =
          horizontal[targetOffset + 2]! + rgb[sourceOffset + 2]! * weight;
      }
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const targetOffset = (y * width + x) * 3;
      for (const { index, weight } of verticalWeights[y]!) {
        const sourceOffset = (index * width + x) * 3;
        output[targetOffset] = output[targetOffset]! + horizontal[sourceOffset]! * weight;
        output[targetOffset + 1] =
          output[targetOffset + 1]! + horizontal[sourceOffset + 1]! * weight;
        output[targetOffset + 2] =
          output[targetOffset + 2]! + horizontal[sourceOffset + 2]! * weight;
      }
    }
  }
  return output;
}

function prepareMobileNetV4Input(image: HTMLImageElement): ort.Tensor {
  const shortSide = Math.min(image.naturalWidth, image.naturalHeight);
  const scale = RESIZE_EDGE / shortSide;
  const width = Math.max(IMAGE_SIZE, Math.round(image.naturalWidth * scale));
  const height = Math.max(IMAGE_SIZE, Math.round(image.naturalHeight * scale));
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = image.naturalWidth;
  sourceCanvas.height = image.naturalHeight;
  const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
  if (!sourceContext) throw new Error('Could not create source canvas context');
  sourceContext.drawImage(image, 0, 0);
  const sourcePixels = sourceContext.getImageData(
    0,
    0,
    image.naturalWidth,
    image.naturalHeight,
  ).data;
  const resized = resizeBicubic(
    sourcePixels,
    image.naturalWidth,
    image.naturalHeight,
    width,
    height,
  );
  const left = Math.floor((width - IMAGE_SIZE) / 2);
  const top = Math.floor((height - IMAGE_SIZE) / 2);
  const planar = new Float32Array(3 * IMAGE_SIZE * IMAGE_SIZE);

  for (let y = 0; y < IMAGE_SIZE; y += 1) {
    for (let x = 0; x < IMAGE_SIZE; x += 1) {
      const sourceOffset = ((y + top) * width + x + left) * 3;
      const targetOffset = y * IMAGE_SIZE + x;
      for (let channel = 0; channel < 3; channel += 1) {
        const value = resized[sourceOffset + channel]! / 255;
        planar[channel * IMAGE_SIZE * IMAGE_SIZE + targetOffset] =
          (value - IMAGE_MEAN[channel]!) / IMAGE_STD[channel]!;
      }
    }
  }
  return new ort.Tensor('float32', planar, [3, IMAGE_SIZE, IMAGE_SIZE]);
}

function softmax(values: ArrayLike<number>): Record<string, number> {
  const maximum = Math.max(...Array.from(values));
  const exponents = Array.from(values, (value) => Math.exp(value - maximum));
  const denominator = exponents.reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(
    SMALL_MODEL_LABELS.map((label, index) => [label, exponents[index]! / denominator]),
  );
}

async function runNsfwjs(
  cases: FixtureCase[],
  images: Map<string, HTMLImageElement>,
): Promise<ModelRun> {
  const start = performance.now();
  const model = await loadNsfwCore('MobileNetV2', {
    size: 224,
    modelDefinitions: [MobileNetV2Model],
  });
  const loadingMs = performance.now() - start;

  const predictOne = async (item: FixtureCase) => {
    const tensor = tf.browser.fromPixels(images.get(item.id)!, 3);
    try {
      const predictions = await model.classify(tensor);
      const scores = Object.fromEntries(
        predictions.map(({ className, probability }) => [
          className.toLowerCase() === 'drawing' ? 'drawings' : className.toLowerCase(),
          probability,
        ]),
      );
      for (const className of NSFWJS_CLASSES) {
        if (typeof scores[className] !== 'number') throw new Error(`NSFWJS omitted '${className}'`);
      }
      return scores;
    } finally {
      tensor.dispose();
    }
  };

  const warmupStart = performance.now();
  await predictOne(firstCase(cases));
  const warmupMs = performance.now() - warmupStart;
  const raw = [];
  for (const item of cases) {
    const started = performance.now();
    const scores = await predictOne(item);
    const latencyMs = performance.now() - started;
    raw.push({
      caseId: item.id,
      score: sexualScoreFromFiveClass(scores),
      rawScores: scores,
      latencyMs,
    });
    await waitForFrame();
  }
  model.dispose();
  return {
    id: 'nsfwjs-mobilenet-v2',
    name: 'NSFWJS MobileNetV2 baseline',
    revision: 'nsfwjs package modelDefinitions.MobileNetV2',
    artifactBytes: NSFWJS_MODEL_BYTES,
    quantization: 'float32 TensorFlow.js graph model, bundled package assets',
    runtime: `TensorFlow.js ${tf.version.tfjs} / ${tf.getBackend()}`,
    loadingMs,
    warmupMs,
    predictions: summarizePredictions(cases, raw),
    preprocessing:
      'NSFWJS MobileNetV2 default input size 224; TensorFlow.js browser backend selected by tf.ready().',
  };
}

async function runMobileNetV4(
  cases: FixtureCase[],
  images: Map<string, HTMLImageElement>,
): Promise<ModelRun> {
  const start = performance.now();
  const response = await fetch(SMALL_MODEL_URL);
  if (!response.ok)
    throw new Error(`Could not load local MobileNetV4 ONNX: HTTP ${response.status}`);
  const modelBytes = await response.arrayBuffer();
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = '/__benchmark_onnxruntime/';
  const session = await ort.InferenceSession.create(modelBytes, { executionProviders: ['wasm'] });
  const loadingMs = performance.now() - start;
  const inputName = session.inputNames[0];
  if (!inputName) throw new Error('ONNX model omitted an input name.');
  const outputName = session.outputNames[0];
  if (!outputName) throw new Error('ONNX model omitted an output name.');

  const predictOne = async (item: FixtureCase) => {
    const input = prepareMobileNetV4Input(images.get(item.id)!);
    const result = await session.run({ [inputName]: input });
    const output = result[outputName];
    if (!output) throw new Error(`ONNX model omitted output '${outputName}'`);
    const values = Array.from(output.data as ArrayLike<number>);
    if (values.length !== SMALL_MODEL_LABELS.length) {
      throw new Error(`Expected five class logits, received ${values.length}`);
    }
    return softmax(values);
  };

  const warmupStart = performance.now();
  await predictOne(firstCase(cases));
  const warmupMs = performance.now() - warmupStart;
  const raw = [];
  for (const item of cases) {
    const started = performance.now();
    const scores = await predictOne(item);
    const latencyMs = performance.now() - started;
    raw.push({
      caseId: item.id,
      score: sexualScoreFromFiveClass(scores),
      rawScores: scores,
      latencyMs,
    });
    await waitForFrame();
  }
  await session.release();
  return {
    id: 'taufiqdp-mobilenetv4-conv-small',
    name: 'MobileNetV4 Conv Small NSFW classifier',
    revision: '504317ad62086f357c9c5f70cf983726ff47efdb',
    artifactBytes: 9_974_311,
    quantization: 'unquantized ONNX float32',
    runtime: `ONNX Runtime Web ${ort.env.versions.web} / WASM / 1 thread`,
    loadingMs,
    warmupMs,
    predictions: summarizePredictions(cases, raw),
    preprocessing:
      'RGB; timm input_size 224; resize shorter side to round(224 / 0.875) = 256, center-crop 224, bicubic resampling; scale [0,1], then normalize by mean [0.485, 0.456, 0.406] and std [0.229, 0.224, 0.225].',
  };
}

async function runTransformersJs(
  cases: FixtureCase[],
  images: Map<string, HTMLImageElement>,
): Promise<ModelRun> {
  const start = performance.now();
  const classifier = await pipeline(
    'image-classification',
    'onnx-community/nsfw_image_detection-ONNX',
    {
      revision: '1ceb3c7fe1e9f3f2507e6df577437f23a9149fd5',
      dtype: 'q4',
    },
  );
  const loadingMs = performance.now() - start;

  const predictOne = async (item: FixtureCase) => {
    const scores = Object.fromEntries(
      (await classifier(canvasInput(images.get(item.id)!), { top_k: null })).map(
        ({ label, score }) => [label.toLowerCase(), score],
      ),
    );
    if (typeof scores.nsfw !== 'number' || typeof scores.normal !== 'number') {
      throw new Error('Expected `normal` and `nsfw` output labels');
    }
    return scores;
  };

  const warmupStart = performance.now();
  await predictOne(firstCase(cases));
  const warmupMs = performance.now() - warmupStart;
  const raw = [];
  for (const item of cases) {
    const started = performance.now();
    const scores = await predictOne(item);
    const latencyMs = performance.now() - started;
    raw.push({ caseId: item.id, score: scores.nsfw!, rawScores: scores, latencyMs });
    await waitForFrame();
  }
  await classifier.dispose();
  return {
    id: 'onnx-community-falconsai-nsfw-q4',
    name: 'Falconsai NSFW image detector (q4 ONNX)',
    revision: '1ceb3c7fe1e9f3f2507e6df577437f23a9149fd5',
    artifactBytes: 56_757_898,
    quantization: 'q4 ONNX',
    runtime: `Transformers.js ${transformersEnv.version} / ONNX Runtime Web WASM`,
    loadingMs,
    warmupMs,
    predictions: summarizePredictions(cases, raw),
    preprocessing:
      'Transformers.js ViT processor from the pinned repository config; RGB 224x224, scale by 1/255, normalize mean/std [0.5, 0.5, 0.5].',
  };
}

type FourImageScores = {
  porn: number;
  hentai: number;
  sexy: number;
  drawings: number;
};

type RawFourImageScores = {
  porn?: number;
  hentai?: number;
  sexy?: number;
  drawings?: number;
};

function readFourImageScores(scores: RawFourImageScores): FourImageScores {
  if (
    typeof scores.porn !== 'number' ||
    typeof scores.hentai !== 'number' ||
    typeof scores.sexy !== 'number' ||
    typeof scores.drawings !== 'number'
  ) {
    throw new Error('The deferred image adapter omitted a category score.');
  }
  return {
    porn: scores.porn,
    hentai: scores.hentai,
    sexy: scores.sexy,
    drawings: scores.drawings,
  };
}

async function runStaticNsfwjs(
  cases: FixtureCase[],
  images: Map<string, HTMLImageElement>,
): Promise<ModelRun> {
  const selected = SELECTED_MODELS.image;
  const loadStart = performance.now();
  let progressBytes = 0;
  let progressTotal = 0;
  const classify = await loadImageModel((loaded, total) => {
    progressBytes = loaded;
    progressTotal = total;
  });
  if (
    progressBytes !== selected.downloadBytes ||
    progressTotal !== selected.downloadBytes + ANIME_RATING_MODEL.downloadBytes
  ) {
    throw new Error(
      'The deferred image adapter did not report completion for its pinned model files.',
    );
  }
  const loadingMs = performance.now() - loadStart;

  const predictOne = async (item: FixtureCase) => {
    const image = images.get(item.id);
    if (!image) throw new Error(`Missing loaded image '${item.id}'.`);
    const dataUrl = canvasInput(image).toDataURL('image/png');
    const started = performance.now();
    const result = await classify(dataUrl);
    if (result.warning) throw new Error(result.warning);
    const scores = readFourImageScores(result.scores);
    return {
      score: scores.porn + scores.hentai + scores.sexy,
      rawScores: scores,
      latencyMs: performance.now() - started,
    };
  };

  const warmupStart = performance.now();
  await predictOne(firstCase(cases));
  const warmupMs = performance.now() - warmupStart;
  const raw = [];
  for (const item of cases) {
    const result = await predictOne(item);
    raw.push({ caseId: item.id, ...result });
    await waitForFrame();
  }
  return {
    id: 'nsfwjs-mobilenet-v2-static',
    name: 'NSFWJS MobileNetV2 (pinned static weights; deferred fetch)',
    revision: selected.revision,
    artifactBytes: selected.downloadBytes,
    quantization: 'float32 TensorFlow.js layers weights',
    runtime: `NSFWJS core + TensorFlow.js ${tf.version.tfjs} / ${tf.getBackend()}`,
    loadingMs,
    warmupMs,
    predictions: summarizePredictions(cases, raw),
    preprocessing:
      'NSFWJS core classify(data URL): RGB pixels, divide by 255, bilinear resize with alignCorners=true to 224x224; return Drawing/Hentai/Porn/Sexy categories.',
  };
}

function failureMetadataForRunner(
  runner:
    | typeof runNsfwjs
    | typeof runMobileNetV4
    | typeof runTransformersJs
    | typeof runStaticNsfwjs,
) {
  if (runner === runNsfwjs) {
    return {
      id: 'nsfwjs-mobilenet-v2',
      name: 'NSFWJS MobileNetV2 baseline',
      revision: 'nsfwjs package modelDefinitions.MobileNetV2',
      artifactBytes: NSFWJS_MODEL_BYTES,
      quantization: 'float32 TensorFlow.js graph model',
    };
  }
  if (runner === runMobileNetV4) {
    return {
      id: 'taufiqdp-mobilenetv4-conv-small',
      name: 'MobileNetV4 Conv Small NSFW classifier',
      revision: '504317ad62086f357c9c5f70cf983726ff47efdb',
      artifactBytes: 9_974_311,
      quantization: 'unquantized ONNX float32',
    };
  }
  if (runner === runTransformersJs) {
    return {
      id: 'onnx-community-falconsai-nsfw-q4',
      name: 'Falconsai NSFW image detector (q4 ONNX)',
      revision: '1ceb3c7fe1e9f3f2507e6df577437f23a9149fd5',
      artifactBytes: 56_757_898,
      quantization: 'q4 ONNX',
    };
  }
  if (runner === runStaticNsfwjs) {
    return {
      id: 'nsfwjs-mobilenet-v2-static',
      name: 'NSFWJS MobileNetV2 (pinned static weights; deferred fetch)',
      revision: SELECTED_MODELS.image.revision,
      artifactBytes: SELECTED_MODELS.image.downloadBytes,
      quantization: 'float32 TensorFlow.js layers weights',
    };
  }
  throw new Error('Unknown image benchmark runner');
}

async function main() {
  const manifestResponse = await fetch(FIXTURES_URL);
  if (!manifestResponse.ok)
    throw new Error(`Fixture manifest returned HTTP ${manifestResponse.status}`);
  const manifest = (await manifestResponse.json()) as FixtureManifest;
  const decoded = await Promise.all(
    manifest.cases.map(async (item) => [item.id, await loadImage(item.id)] as const),
  );
  const images = new Map(decoded);
  await tf.ready();
  const environment = {
    browser: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    crossOriginIsolated: window.crossOriginIsolated,
    tfjsVersion: tf.version.tfjs,
    tfjsBackend: tf.getBackend(),
    transformersJsVersion: transformersEnv.version,
    onnxRuntimeWebVersion: ort.env.versions.web,
    wasmThreads: 1,
    caseCount: manifest.cases.length,
  };
  const models: ModelRun[] = [];
  for (const runner of [runNsfwjs, runMobileNetV4, runTransformersJs, runStaticNsfwjs]) {
    try {
      models.push(await runner(manifest.cases, images));
    } catch (error) {
      const errorMessage =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      models.push({
        ...failureMetadataForRunner(runner),
        runtime: 'Chromium browser inference',
        loadingMs: null,
        warmupMs: null,
        predictions: manifest.cases.map((item) => ({
          caseId: item.id,
          score: null,
          rawScores: null,
          prediction: null,
          correct: null,
          latencyMs: null,
          error: errorMessage,
        })),
        error: errorMessage,
      });
    }
  }
  setResult('done', {
    corpusId: manifest.corpusId,
    split: manifest.split,
    environment,
    models,
  });
}

main().catch((error) =>
  setResult('failed', {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  }),
);
