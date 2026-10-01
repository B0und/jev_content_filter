// Model downloads must fail closed on short bodies: a truncated file cached
// before validation would pin every later retry to an incomplete graph.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadModelFile } from '../../src/inference/download';

const MODEL_URL = 'https://example.test/model.onnx';

function payload(length: number): ArrayBuffer {
  return new Uint8Array(length).fill(7).buffer as ArrayBuffer;
}

function responseWithBody(declaredLength: number, body: ArrayBuffer): Response {
  return new Response(body, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(declaredLength),
    },
  });
}

function installCacheStub(initial?: Response) {
  const entries = new Map<string, Response>();
  if (initial) entries.set(MODEL_URL, initial);
  const cache = {
    match: async (url: string) => entries.get(url)?.clone(),
    put: async (url: string, response: Response) => void entries.set(url, response),
    delete: async (url: string) => entries.delete(url),
  };
  vi.stubGlobal('caches', { open: async () => cache });
  return entries;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('model downloads', () => {
  it('accepts an encoded transfer whose content-length describes the encoded size', async () => {
    // raw.githubusercontent.com serves model.json gzipped: the header reports
    // the compressed transfer while fetch decodes the body.
    const entries = installCacheStub();
    const fetchMock = vi.fn(
      async () =>
        new Response(payload(64), {
          headers: {
            'content-type': 'application/json',
            'content-encoding': 'gzip',
            'content-length': String(8),
          },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const buffer = await downloadModelFile(MODEL_URL, () => {});

    expect(buffer.byteLength).toBe(64);
    expect((await entries.get(MODEL_URL)?.arrayBuffer())?.byteLength).toBe(64);
  });

  it('fails closed on a short body and downloads it again on retry', async () => {
    const entries = installCacheStub();
    const fetchMock = vi.fn(async () => responseWithBody(64, payload(8)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(downloadModelFile(MODEL_URL, () => {})).rejects.toThrow(/incomplete/);
    expect(entries.size).toBe(0);

    fetchMock.mockResolvedValueOnce(responseWithBody(64, payload(64)));
    const buffer = await downloadModelFile(MODEL_URL, () => {});

    expect(buffer.byteLength).toBe(64);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const cached = entries.get(MODEL_URL);
    expect((await cached?.arrayBuffer())?.byteLength).toBe(64);
  });

  it('discards a truncated cached entry and refetches the file', async () => {
    const entries = installCacheStub(responseWithBody(64, payload(8)));
    const fetchMock = vi.fn(async () => responseWithBody(64, payload(64)));
    vi.stubGlobal('fetch', fetchMock);

    const buffer = await downloadModelFile(MODEL_URL, () => {});

    expect(buffer.byteLength).toBe(64);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await entries.get(MODEL_URL)?.arrayBuffer())?.byteLength).toBe(64);
  });

  it('reuses a complete cached entry without fetching', async () => {
    installCacheStub(responseWithBody(32, payload(32)));
    const fetchMock = vi.fn(async () => responseWithBody(32, payload(32)));
    vi.stubGlobal('fetch', fetchMock);

    const buffer = await downloadModelFile(MODEL_URL, () => {});

    expect(buffer.byteLength).toBe(32);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
