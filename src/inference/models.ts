import { env } from '@huggingface/transformers';
import { loadImageModel, type ImageClassification } from './image';
import { loadAiTextModel } from './ai-text';
import { initialModelStatuses, type ModelKind, type ModelStatuses } from './contracts';

export interface LocalModels {
  load(kind: ModelKind): Promise<void>;
  classifyImage(dataUrl: string): Promise<ImageClassification>;
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

  const update = (kind: ModelKind, state: 'idle' | 'loading' | 'ready' | 'error', error = '') => {
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

          return classifier;
        })
        .catch((cause: unknown) => {
          update('image', 'error', cause instanceof Error ? cause.message : String(cause));
          throw cause;
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
        .catch((cause: unknown) => {
          update('aiText', 'error', cause instanceof Error ? cause.message : String(cause));
          throw cause;
        })
        .finally(() => {
          aiLoading = undefined;
        });
    }

    return aiLoading;
  };

  return {
    async load(kind) {
      update(kind, 'loading');

      try {
        if (kind === 'image') await (await getImage()).warmup();
        else await getAiText();
        update(kind, 'ready');
      } catch (error) {
        update(kind, 'error', error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
    async classifyImage(dataUrl) {
      const classifier = await getImage();
      const result = await classifier(dataUrl);

      if (result.warning) update('image', 'error', result.warning);
      else if (classifier.isReady()) update('image', 'ready');
      else if (statuses.image.state !== 'error') update('image', 'idle');

      return result;
    },
    async classifyAiText(text) {
      return (await getAiText())(text);
    },
  };
}
