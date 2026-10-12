import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadImageModel } from '../../src/inference/image';

const mocks = {
  create: vi.fn(),
  run: vi.fn(),
  release: vi.fn(),
  classify: vi.fn(),
  explicit: vi.fn(),
  loadExplicit: vi.fn(),
};

const loaders = {
  nsfw: async () => ({ classify: mocks.classify }),
  anime: mocks.create,
  explicit: mocks.loadExplicit,
  explicitScore: mocks.explicit,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.explicit.mockResolvedValue(0.99);
  mocks.loadExplicit.mockResolvedValue({ release: vi.fn().mockResolvedValue(undefined) });
  mocks.create.mockResolvedValue({
    inputNames: ['input'],
    outputNames: ['output'],
    run: mocks.run,
    release: mocks.release,
  });
  mocks.run.mockResolvedValue({ output: { data: new Float32Array([0.05, 0.8, 0.1, 0.05]) } });
  mocks.release.mockResolvedValue(undefined);
  mocks.classify.mockResolvedValue([
    { className: 'Drawing', probability: 0.95 },
    { className: 'Porn', probability: 0.01 },
    { className: 'Hentai', probability: 0.01 },
    { className: 'Sexy', probability: 0.03 },
  ]);
  vi.stubGlobal('self', { location: { href: 'chrome-extension://test/worker.js' } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Blob(['image']))),
  );
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn().mockResolvedValue({ width: 2, height: 2, close: vi.fn() }),
  );
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return {
          fillStyle: '',
          globalCompositeOperation: '',
          fillRect() {},
          drawImage() {},
          getImageData: () => ({ data: new Uint8ClampedArray(384 * 384 * 4) }),
        };
      }
    },
  );
});

afterEach(() => vi.unstubAllGlobals());

it('keeps NSFWJS scores after anime loading fails and retries the load', async () => {
  mocks.create.mockRejectedValueOnce(new Error('model unavailable'));
  const classify = await loadImageModel(() => {}, loaders);
  const degraded = await classify('data:image/png;base64,AA==');
  expect(degraded.scores).toMatchObject({ porn: 0.01, drawings: 0.95, sexy: 0.03 });
  expect(degraded.warning).toContain('model unavailable');
  const recovered = await classify('data:image/png;base64,AA==');
  expect(recovered.warning).toBeUndefined();
  expect(recovered.scores.sexy).toBeCloseTo(0.15);
  expect(mocks.create).toHaveBeenCalledTimes(2);
});

it('keeps NSFWJS scores after anime inference fails and recreates the session', async () => {
  mocks.run.mockRejectedValueOnce(new Error('WASM failure'));
  const classify = await loadImageModel(() => {}, loaders);
  const degraded = await classify('data:image/png;base64,AA==');
  expect(degraded.scores.sexy).toBe(0.03);
  expect(degraded.warning).toContain('WASM failure');
  expect(mocks.release).toHaveBeenCalledOnce();
  expect((await classify('data:image/png;base64,AA==')).warning).toBeUndefined();
  expect(mocks.create).toHaveBeenCalledTimes(2);
});

it('explicit warmup retries the anime model without classifying another image', async () => {
  mocks.create.mockRejectedValueOnce(new Error('model unavailable'));
  const classify = await loadImageModel(() => {}, loaders);
  await expect(classify.warmup()).rejects.toThrow('model unavailable');
  await expect(classify.warmup()).resolves.toBeUndefined();
  expect(mocks.create).toHaveBeenCalledTimes(2);
  expect(mocks.classify).not.toHaveBeenCalled();
});

it('completes photo classification without loading an unavailable anime model', async () => {
  mocks.create.mockRejectedValue(new Error('model unavailable'));
  mocks.classify.mockResolvedValue([
    { className: 'Drawing', probability: 0.01 },
    { className: 'Porn', probability: 0.01 },
    { className: 'Hentai', probability: 0.01 },
    { className: 'Sexy', probability: 0.03 },
  ]);
  const classify = await loadImageModel(() => {}, loaders);
  expect(await classify('data:image/png;base64,AA==')).toEqual({
    scores: { drawings: 0.01, porn: 0.01, hentai: 0, sexy: 0.03 },
  });
  expect(mocks.create).not.toHaveBeenCalled();
  expect(classify.isReady()).toBe(false);
});

it('verifies a high Hentai false positive even when Drawing is low', async () => {
  mocks.classify.mockResolvedValue([
    { className: 'Drawing', probability: 0.01 },
    { className: 'Porn', probability: 0.01 },
    { className: 'Hentai', probability: 0.97 },
    { className: 'Sexy', probability: 0.01 },
  ]);
  mocks.run.mockResolvedValue({ output: { data: new Float32Array([0.9, 0.08, 0.015, 0.005]) } });
  const classify = await loadImageModel(() => {}, loaders);
  const result = await classify('data:image/png;base64,AA==');
  expect(mocks.run).toHaveBeenCalledOnce();
  expect(result.scores.hentai).toBeCloseTo(0.005);
  expect(result.scores.sexy).toBeLessThan(0.1);
});

it('independent explicit evidence catches drawn content mislabeled as safe Drawing', async () => {
  mocks.run.mockResolvedValue({ output: { data: new Float32Array([0.01, 0.02, 0.02, 0.95]) } });
  const classify = await loadImageModel(() => {}, loaders);
  expect((await classify('data:image/png;base64,AA==')).scores.hentai).toBeCloseTo(0.95);
});

it('an unavailable verifier never presents raw Hentai as a verified score', async () => {
  mocks.classify.mockResolvedValue([
    { className: 'Drawing', probability: 0.01 },
    { className: 'Porn', probability: 0.01 },
    { className: 'Hentai', probability: 0.97 },
    { className: 'Sexy', probability: 0.01 },
  ]);
  mocks.create.mockRejectedValue(new Error('model unavailable'));
  const classify = await loadImageModel(() => {}, loaders);
  const result = await classify('data:image/png;base64,AA==');
  expect(result.scores.hentai).toBeUndefined();
  expect(result.warning).toContain('model unavailable');
});

it('requires independent NSFW agreement before a photo can block as Porn', async () => {
  mocks.classify.mockResolvedValue([
    { className: 'Drawing', probability: 0.005 },
    { className: 'Porn', probability: 0.683 },
    { className: 'Hentai', probability: 0.001 },
    { className: 'Sexy', probability: 0.017 },
  ]);
  mocks.explicit.mockResolvedValueOnce(0.077).mockResolvedValueOnce(0.95);
  const classify = await loadImageModel(() => {}, loaders);
  expect((await classify('data:image/png;base64,AA==')).scores.porn).toBeCloseTo(0.077);
  expect((await classify('data:image/png;base64,AA==')).scores.porn).toBeCloseTo(0.683);
});

it('omits an unverified Porn score, preserves other categories and retries verification', async () => {
  mocks.explicit.mockRejectedValueOnce(new Error('verification failed'));
  const classify = await loadImageModel(() => {}, loaders);
  const failed = await classify('data:image/png;base64,AA==');
  expect(failed.scores.porn).toBeUndefined();
  expect(failed.scores.drawings).toBe(0.95);
  expect(failed.warning).toContain('verification failed');
  const recovered = await classify('data:image/png;base64,AA==');
  expect(recovered.scores.porn).toBe(0.01);
  expect(recovered.warning).toBeUndefined();
  expect(mocks.loadExplicit).toHaveBeenCalledTimes(2);
});
