// Include language data, engine, and preprocessing changes in OCR cache identity.
export const OCR_PIPELINE_REVISION = 'tesseract-7-eng-rus-best-int-v1';

/** Read text from a larger media variant while retaining the canonical cache identity. */
export function ocrImageUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.hostname === 'pbs.twimg.com' && parsed.pathname.startsWith('/media/'))
    parsed.searchParams.set('name', 'large');
  return parsed.href;
}
