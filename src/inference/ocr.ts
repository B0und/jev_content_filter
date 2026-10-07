import { Effect } from 'effect';
import { OcrError } from './contracts';
import { imageDimensionsFromData } from 'image-dimensions';
import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';
import { recognizeOcrImage } from './ocr-image';

let worker: Worker | undefined;
const MAX_SOURCE_PIXELS = 4096 * 4096;
const MAX_OCR_EDGE = 2048;
/**
 * Language codes are deliberately data-only configuration. The traineddata
 * files are fetched on first use and retained by Tesseract.js in IndexedDB,
 * so adding another language does not add megabytes to the extension package.
 */
export const OCR_LANGUAGES = ['eng', 'rus'];
const OCR_LANG_PATH =
  'https://raw.githubusercontent.com/naptha/tessdata/806cd9adc8c6e8abc11c782db1818c990576bebc/4.0.0_best_int';
let workerLanguages = '';

/** Validate and canonicalize language codes before they become remote paths. */
function normalizeLanguages(languages: ReadonlyArray<string>): string[] {
  const normalized = [
    ...new Set(languages.map((language) => language.trim()).filter(Boolean)),
  ].sort();
  if (!normalized.length || normalized.some((language) => !/^[A-Za-z0-9_]+$/.test(language)))
    throw new Error('OCR language codes must contain only letters, numbers, or underscores.');
  return normalized;
}

// Called by the serialized, supervised inference worker. Its termination also
// releases this child worker. Only the core executable is packaged; language
// data is downloaded and cached by Tesseract.js on first use.
/** Recognize text from one image using the requested, lazily downloaded languages. */
async function recognizeImage(dataUrl: string, languages: ReadonlyArray<string>): Promise<string> {
  const response = await fetch(dataUrl);
  if (!response.ok) throw new Error(`Image text decoding failed (${response.status}).`);
  const blob = await response.blob();
  const dimensions = imageDimensionsFromData(new Uint8Array(await blob.arrayBuffer()));
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0)
    throw new Error('Image dimensions could not be read before local OCR decoding.');
  if (dimensions.width * dimensions.height > MAX_SOURCE_PIXELS)
    throw new Error('Image exceeds the local OCR pixel budget.');
  const bitmap = await createImageBitmap(blob);
  let image: Blob;
  try {
    if (bitmap.width * bitmap.height > MAX_SOURCE_PIXELS)
      throw new Error('Image exceeds the local OCR pixel budget.');
    const scale = Math.min(2, MAX_OCR_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale)),
    );
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image text preprocessing is unavailable.');
    context.fillStyle = 'white';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    image = await canvas.convertToBlob({ type: 'image/png' });
  } finally {
    bitmap.close();
  }
  try {
    const normalizedLanguages = normalizeLanguages(languages);
    const languageKey = normalizedLanguages.join('+');
    if (!worker) {
      const base = new URL('/ocr/', self.location.href).href;
      worker = await createWorker(normalizedLanguages, OEM.LSTM_ONLY, {
        workerPath: `${base}worker.min.js`,
        // Chrome 116+ supports WASM SIMD. Packaging this one LSTM core keeps
        // the extension small while avoiding remote executable code.
        corePath: `${base}tesseract-core-simd-lstm.wasm.js`,
        langPath: OCR_LANG_PATH,
        workerBlobURL: false,
        cachePath: 'jev-content-filter/ocr',
        cacheMethod: 'write',
        gzip: true,
        // Tesseract rejects the active job itself; avoid its default unhandled throw.
        errorHandler: () => {},
      });
      workerLanguages = languageKey;
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
    } else if (workerLanguages !== languageKey) {
      await worker.reinitialize(languageKey, OEM.LSTM_ONLY);
      workerLanguages = languageKey;
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
    }
    const activeWorker = worker;
    return await recognizeOcrImage(activeWorker, image, async () => {
      worker = undefined;
      workerLanguages = '';
      await activeWorker.terminate();
    });
  } catch (error) {
    const failed = worker;
    worker = undefined;
    workerLanguages = '';
    await failed?.terminate();
    throw error;
  }
}

/** Return an Effect so OCR failures remain typed at every caller. */
export const extractImageText = Effect.fn('extractImageText')(
  (dataUrl: string, languages: ReadonlyArray<string> = OCR_LANGUAGES) =>
    Effect.tryPromise({
      try: () => recognizeImage(dataUrl, languages),
      catch: (cause) =>
        new OcrError({ message: cause instanceof Error ? cause.message : String(cause) }),
    }),
);
