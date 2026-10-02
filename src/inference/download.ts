/**
 * Declared body size, or 0 when the header cannot describe what `arrayBuffer`
 * returns. A content-encoded transfer (gzip, br, …) reports the encoded size
 * while `fetch` decodes the body, so those responses are never compared.
 */
function decodedContentLength(headers: Headers): number {
  const encoding = headers.get('content-encoding');
  if (encoding && encoding !== 'identity') return 0;
  return Number(headers.get('content-length')) || 0;
}

export async function downloadModelFile(
  url: string,
  onProgress: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  // CacheStorage rejects extension-scheme requests in Chromium. Bundled model
  // assets are already durable on disk, so fetch them directly.
  if (url.startsWith('chrome-extension:')) {
    const response = await fetch(url, {
      credentials: 'omit',
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok)
      throw new Error(
        `Model download failed (${response.status}). Check your connection and retry.`,
      );
    const buffer = await response.arrayBuffer();
    onProgress(buffer.byteLength, buffer.byteLength);
    return buffer;
  }
  const cache = await caches.open('jev-local-models');
  const cached = await cache.match(url);
  if (cached) {
    const buffer = await cached.arrayBuffer();
    const cachedTotal = decodedContentLength(cached.headers);
    if (cachedTotal === 0 || buffer.byteLength === cachedTotal) {
      onProgress(buffer.byteLength, buffer.byteLength);
      return buffer;
    }
    // A truncated prior write must not pin a broken model: refetch instead.
    await cache.delete(url);
  }
  const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(180_000) });
  if (!response.ok)
    throw new Error(`Model download failed (${response.status}). Check your connection and retry.`);
  if (!response.body) throw new Error('Model download returned no data. Retry the download.');
  const total = decodedContentLength(response.headers);
  let loaded = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        loaded += chunk.byteLength;
        onProgress(loaded, total);
        controller.enqueue(chunk);
      },
    }),
  );
  // Read fully before caching: a short identity body must fail closed and stay
  // uncached so Retry fetches again instead of replaying the incomplete file.
  const buffer = await new Response(body).arrayBuffer();
  if (total > 0 && buffer.byteLength !== total) {
    throw new Error(
      `Model download was incomplete (${buffer.byteLength} of ${total} bytes). Retry the download.`,
    );
  }
  await cache.put(
    url,
    new Response(buffer, {
      headers: {
        'content-type': response.headers.get('content-type') ?? 'application/octet-stream',
        'content-length': String(buffer.byteLength),
      },
    }),
  );
  onProgress(buffer.byteLength, buffer.byteLength);
  return buffer;
}
