export async function downloadModelFile(
  url: string,
  onProgress: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  const cache = await caches.open('jev-local-models');
  const cached = await cache.match(url);
  if (cached) {
    const buffer = await cached.arrayBuffer();
    onProgress(buffer.byteLength, buffer.byteLength);
    return buffer;
  }
  const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(180_000) });
  if (!response.ok)
    throw new Error(`Model download failed (${response.status}). Check your connection and retry.`);
  if (!response.body) throw new Error('Model download returned no data. Retry the download.');
  const total = Number(response.headers.get('content-length')) || 0;
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
  const tracked = new Response(body, { headers: response.headers });
  const stored = cache.put(url, tracked.clone());
  const buffer = await tracked.arrayBuffer();
  await stored;
  onProgress(buffer.byteLength, buffer.byteLength);
  return buffer;
}
