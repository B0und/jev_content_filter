import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';

let worker: Worker | undefined;
const MAX_SOURCE_PIXELS = 4096 * 4096;
const MAX_OCR_EDGE = 2048;

// Called by the serialized, supervised inference worker. Its termination also
// releases this child worker. Every executable and language asset is packaged.
export async function extractImageText(dataUrl: string): Promise<string> {
  const response = await fetch(dataUrl);
  if (!response.ok) throw new Error(`Image text decoding failed (${response.status}).`);
  const bitmap = await createImageBitmap(await response.blob());
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
    if (!worker) {
      const base = new URL('/ocr/', self.location.href).href;
      worker = await createWorker(['eng', 'rus'], OEM.LSTM_ONLY, {
        workerPath: `${base}worker.min.js`,
        corePath: base,
        langPath: `${base}data`,
        workerBlobURL: false,
        cacheMethod: 'none',
        // Tesseract rejects the active job itself; avoid its default unhandled throw.
        errorHandler: () => {},
      });
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
    }
    const { data } = await worker.recognize(image);
    return data.text.trim();
  } catch (error) {
    const failed = worker;
    worker = undefined;
    await failed?.terminate();
    throw error;
  }
}
