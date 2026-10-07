import type { Worker } from 'tesseract.js';

/** Retry uncertain text with bright lettering separated from its background. */
export async function recognizeOcrImage(
  worker: Pick<Worker, 'recognize'>,
  image: Blob,
): Promise<string> {
  const { data } = await worker.recognize(image);
  if (data.confidence >= 80 || !data.text.trim()) return data.text.trim();

  const bitmap = await createImageBitmap(image);
  let alternateImage: Blob;
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) return data.text.trim();
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const luminance =
        pixels.data[i]! * 0.299 + pixels.data[i + 1]! * 0.587 + pixels.data[i + 2]! * 0.114;
      const value = luminance > 230 ? 0 : 255;
      pixels.data[i] = value;
      pixels.data[i + 1] = value;
      pixels.data[i + 2] = value;
    }
    context.putImageData(pixels, 0, 0);
    alternateImage = await canvas.convertToBlob({ type: 'image/png' });
  } finally {
    bitmap.close();
  }
  const alternate = (await worker.recognize(alternateImage)).data;
  return (alternate.confidence > data.confidence ? alternate.text : data.text).trim();
}
