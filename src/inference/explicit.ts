import * as ort from 'onnxruntime-web/wasm';
import { downloadModelFile } from './download';
import { EXPLICIT_IMAGE_MODEL } from './model-catalog';

const SIZE = 384;

/** Match Marqo's short-edge resize and center crop, with white-composited RGB. */
export function explicitImageInput(bitmap: ImageBitmap): ort.Tensor {
  const scale = SIZE / Math.min(bitmap.width, bitmap.height);
  const width = Math.floor(bitmap.width * scale);
  const height = Math.floor(bitmap.height * scale);
  const canvas = new OffscreenCanvas(SIZE, SIZE);
  const context = canvas.getContext('2d', { willReadFrequently: true });

  if (!context) throw new Error('Explicit image preprocessing is unavailable.');
  context.fillStyle = 'white';
  context.fillRect(0, 0, SIZE, SIZE);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  // Crop from virtual resized coordinates; never allocate an unbounded panorama canvas.
  const scaleX = width / bitmap.width;
  const scaleY = height / bitmap.height;
  context.drawImage(
    bitmap,
    Math.round((width - SIZE) / 2) / scaleX,
    Math.round((height - SIZE) / 2) / scaleY,
    SIZE / scaleX,
    SIZE / scaleY,
    0,
    0,
    SIZE,
    SIZE,
  );
  const pixels = context.getImageData(0, 0, SIZE, SIZE).data;
  const plane = SIZE * SIZE;
  const data = new Float32Array(plane * 3);

  for (let index = 0; index < plane; index += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      data[channel * plane + index] = pixels[index * 4 + channel]! / 127.5 - 1;
    }
  }

  return new ort.Tensor('float32', data, [1, 3, SIZE, SIZE]);
}

/** Load the pinned, locally exported independent NSFW classifier. */
export async function loadExplicitImageModel(
  onProgress: (loaded: number) => void,
): Promise<ort.InferenceSession> {
  const url = new URL('/models/marqo-nsfw.onnx', self.location.href).href;
  const bytes = await downloadModelFile(url, onProgress);

  if (bytes.byteLength !== EXPLICIT_IMAGE_MODEL.downloadBytes)
    throw new Error('The explicit image verification model is incomplete.');

  return ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
}

/** Preserve the reference NSFW/SFW label order and apply stable softmax to logits. */
export async function explicitImageScore(
  model: ort.InferenceSession,
  bitmap: ImageBitmap,
): Promise<number> {
  const input = model.inputNames[0];
  const output = model.outputNames[0];

  if (!input || !output) throw new Error('Explicit image model metadata is missing.');
  const result = await model.run({ [input]: explicitImageInput(bitmap) });
  const values = result[output]?.data;

  if (!values || values.length !== 2) throw new Error('Explicit image model output is invalid.');
  const nsfw = Number(values[0]);
  const sfw = Number(values[1]);

  if (!Number.isFinite(nsfw) || !Number.isFinite(sfw))
    throw new Error('Explicit image model returned non-finite logits.');
  const max = Math.max(nsfw, sfw);

  return Math.exp(nsfw - max) / (Math.exp(nsfw - max) + Math.exp(sfw - max));
}
