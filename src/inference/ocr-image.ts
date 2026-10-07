interface OcrRecognizer {
  recognize(image: Blob): Promise<{ data: { text: string; confidence: number } }>;
}

/** Retry uncertain text with bright lettering separated from its background. */
export async function recognizeOcrImage(
  worker: OcrRecognizer,
  image: Blob,
  onRetryFailure: () => Promise<void> = async () => {},
): Promise<string> {
  const { data } = await worker.recognize(image);
  if (data.confidence >= 80 || !data.text.trim()) return data.text.trim();
  try {
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
    const first = data.text.trim(),
      second = alternate.text.trim();
    // Preserve the complete first reading, including context and dim words that
    // thresholding can remove. Confidence only decides whether to add a reading.
    return alternate.confidence > data.confidence && second && second !== first
      ? `${first}\n\n${second}`
      : first;
  } catch {
    // A child worker may be unusable after a failed retry. Release it for the
    // next request, but never turn successful recognition into an extraction error.
    await onRetryFailure().catch(() => {});
    return data.text.trim();
  }
}
