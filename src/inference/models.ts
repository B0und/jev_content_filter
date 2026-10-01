import { env } from '@huggingface/transformers';
import { loadImageModel } from './image';
import { loadAiTextModel } from './ai-text';
import { initialModelStatuses, type ModelKind, type ModelStatuses } from '../shared/inference';
import type { CategoryKey } from '../shared/types';

export interface LocalModels {
  load(kind: ModelKind): Promise<void>;
  classifyImage(dataUrl: string): Promise<Partial<Record<CategoryKey, number>>>;
  classifyAiText(text: string): Promise<{ aiGenerated: number }>;
}

export function createLocalModels(onStatus: (status: ModelStatuses) => void): LocalModels {
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  env.useWasmCache = false;
  const wasm = env.backends.onnx.wasm;
  if (!wasm) throw new Error('WebAssembly inference is unavailable in this browser.');
  wasm.numThreads = 1;
  wasm.proxy = false;
  wasm.wasmPaths = {
    mjs: new URL('/ort/ort-wasm-simd-threaded.mjs', self.location.href).href,
    wasm: new URL('/ort/ort-wasm-simd-threaded.wasm', self.location.href).href,
  };
  const statuses = initialModelStatuses();
  const lastProgress: Record<ModelKind, number> = { image: 0, aiText: 0 };
  const update = (kind: ModelKind, state: 'loading' | 'ready' | 'error', error = '') => {
    statuses[kind] = {
      ...statuses[kind],
      state,
      error,
      loaded: state === 'loading' ? 0 : statuses[kind].loaded,
    };
    onStatus(statuses);
  };
  const progress = (kind: ModelKind) => (loaded: number, total: number) => {
    if (!Number.isFinite(loaded) || !Number.isFinite(total) || loaded < 0 || total < 0) return;
    statuses[kind] = { ...statuses[kind], loaded, total };
    const now = performance.now();
    if (now - lastProgress[kind] < 100 && loaded !== total) return;
    lastProgress[kind] = now;
    onStatus(statuses);
  };
  let image: Awaited<ReturnType<typeof loadImageModel>> | undefined;
  let aiText: Awaited<ReturnType<typeof loadAiTextModel>> | undefined;
  let imageLoading: Promise<Awaited<ReturnType<typeof loadImageModel>>> | undefined;
  let aiLoading: Promise<Awaited<ReturnType<typeof loadAiTextModel>>> | undefined;
  const getImage = async () => {
    if (image) return image;
    if (!imageLoading) {
      update('image', 'loading');
      imageLoading = loadImageModel(progress('image'))
        .then((classifier) => {
          image = classifier;
          update('image', 'ready');
          return classifier;
        })
        .catch((error: unknown) => {
          update('image', 'error', error instanceof Error ? error.message : String(error));
          throw error;
        })
        .finally(() => {
          imageLoading = undefined;
        });
    }
    return imageLoading;
  };
  const getAiText = async () => {
    if (aiText) return aiText;
    if (!aiLoading) {
      update('aiText', 'loading');
      aiLoading = loadAiTextModel(progress('aiText'))
        .then((classifier) => {
          aiText = classifier;
          update('aiText', 'ready');
          return classifier;
        })
        .catch((error: unknown) => {
          update('aiText', 'error', error instanceof Error ? error.message : String(error));
          throw error;
        })
        .finally(() => {
          aiLoading = undefined;
        });
    }
    return aiLoading;
  };
  return {
    async load(kind) {
      if (kind === 'image') await getImage();
      else await getAiText();
      update(kind, 'ready');
    },
    async classifyImage(dataUrl) {
      return (await getImage())(dataUrl);
    },
    async classifyAiText(text) {
      return (await getAiText())(text);
    },
  };
}
