// Include language data, engine, and preprocessing changes in OCR cache identity.
export const OCR_PIPELINE_REVISION =
  'tesseract-7-best-int-simd-remote-806cd9adc8c6e8abc11c782db1818c990576bebc-v3';

/** Read text from a larger media variant while retaining the canonical cache identity. */
export function ocrImageUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.hostname === 'pbs.twimg.com' && parsed.pathname.startsWith('/media/'))
    parsed.searchParams.set('name', 'large');
  return parsed.href;
}
