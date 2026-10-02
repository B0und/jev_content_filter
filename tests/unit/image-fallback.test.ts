import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ANIME_RATING_MODEL, SELECTED_MODELS } from '../../src/shared/model-catalog';
import { loadImageModel } from '../../src/inference/image';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  run: vi.fn(),
  release: vi.fn(),
  classify: vi.fn(),
}));
vi.mock('onnxruntime-web/wasm', () => ({
  InferenceSession: { create: mocks.create },
  Tensor: class {
    constructor(..._args: unknown[]) {}
  },
}));
vi.mock('@tensorflow/tfjs', () => ({ io: { fromMemory: vi.fn() }, ready: vi.fn() }));
vi.mock('nsfwjs/core', () => ({
  NSFWJS: class {
    load = vi.fn();
    classify = mocks.classify;
  },
}));
vi.mock('../../src/inference/download', () => ({
  downloadModelFile: async (url: string) => {
    if (url.endsWith('.onnx')) return new ArrayBuffer(ANIME_RATING_MODEL.downloadBytes);
    const json = new TextEncoder().encode(
      JSON.stringify({
        modelTopology: {},
        weightsManifest: [{ paths: ['group1-shard1of1'], weights: [] }],
      }),
    );
    return url.endsWith('model.json')
      ? json.buffer
      : new ArrayBuffer(SELECTED_MODELS.image.downloadBytes - json.byteLength);
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
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
  const classify = await loadImageModel(() => {});
  const degraded = await classify('data:image/png;base64,AA==');
  expect(degraded.scores).toMatchObject({ porn: 0.01, drawings: 0.95, sexy: 0.03 });
  expect(degraded.warning).toContain('model unavailable');
  const recovered = await classify('data:image/png;base64,AA==');
  expect(recovered.warning).toBeUndefined();
  expect(recovered.scores.sexy).toBeCloseTo(0.95);
  expect(mocks.create).toHaveBeenCalledTimes(2);
});

it('keeps NSFWJS scores after anime inference fails and recreates the session', async () => {
  mocks.run.mockRejectedValueOnce(new Error('WASM failure'));
  const classify = await loadImageModel(() => {});
  const degraded = await classify('data:image/png;base64,AA==');
  expect(degraded.scores.sexy).toBe(0.03);
  expect(degraded.warning).toContain('WASM failure');
  expect(mocks.release).toHaveBeenCalledOnce();
  expect((await classify('data:image/png;base64,AA==')).warning).toBeUndefined();
  expect(mocks.create).toHaveBeenCalledTimes(2);
});

it('explicit warmup retries the anime model without classifying another image', async () => {
  mocks.create.mockRejectedValueOnce(new Error('model unavailable'));
  const classify = await loadImageModel(() => {});
  await expect(classify.warmup()).rejects.toThrow('model unavailable');
  await expect(classify.warmup()).resolves.toBeUndefined();
  expect(mocks.create).toHaveBeenCalledTimes(2);
  expect(mocks.classify).not.toHaveBeenCalled();
});
