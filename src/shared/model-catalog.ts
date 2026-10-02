import type { ModelKind } from './inference';

interface ModelDescriptor {
  readonly id: string;
  readonly revision: string;
  readonly title: string;
  readonly description: string;
  readonly baseUrl: string;
  readonly sourceUrl: string;
  readonly downloadBytes: number;
  readonly files: readonly string[];
}

export const ANIME_RATING_MODEL = {
  id: 'deepghs/anime_dbrating/mobilenetv3_large_100_v0_ls0.2',
  revision: '7af21db648acdeb74f5c334abda9dd7403407b3c',
  title: 'Anime DBRating MobileNetV3',
  description:
    '16.8 MB ONNX model with general, sensitive, questionable, and explicit anime ratings.',
  baseUrl:
    'https://huggingface.co/deepghs/anime_dbrating/resolve/7af21db648acdeb74f5c334abda9dd7403407b3c/mobilenetv3_large_100_v0_ls0.2',
  sourceUrl:
    'https://huggingface.co/deepghs/anime_dbrating/tree/7af21db648acdeb74f5c334abda9dd7403407b3c/mobilenetv3_large_100_v0_ls0.2',
  downloadBytes: 16_832_684,
  file: 'model.onnx',
  labels: ['general', 'sensitive', 'questionable', 'explicit'] as const,
};

export const SELECTED_MODELS: Record<ModelKind, ModelDescriptor> = {
  image: {
    id: 'nsfwjs/mobilenet_v2',
    revision: 'd55a54c51f14380670064cc129b2ea51029c5e46',
    title: 'NSFWJS + Anime DBRating',
    description:
      '19.6 MB of image weights: a 2.7 MB cached NSFWJS download and 16.8 MB of bundled Anime DBRating weights. Anime sensitivity uses a separate rating model.',
    baseUrl:
      'https://raw.githubusercontent.com/infinitered/nsfwjs/d55a54c51f14380670064cc129b2ea51029c5e46/models/mobilenet_v2',
    sourceUrl:
      'https://github.com/infinitered/nsfwjs/tree/d55a54c51f14380670064cc129b2ea51029c5e46/models/mobilenet_v2',
    downloadBytes: 2_748_406,
    files: ['model.json', 'group1-shard1of1'],
  },
  aiText: {
    id: 'onnx-community/e5-small-lora-ai-generated-detector-ONNX',
    revision: '02919a911bb647ceac84de99afb00ea2da8c2725',
    title: 'E5-small · q8',
    description:
      '34.9 MB model download. Selected on 120 short English posts; AI scores are uncalibrated.',
    baseUrl:
      'https://huggingface.co/onnx-community/e5-small-lora-ai-generated-detector-ONNX/resolve/02919a911bb647ceac84de99afb00ea2da8c2725',
    sourceUrl:
      'https://huggingface.co/onnx-community/e5-small-lora-ai-generated-detector-ONNX/tree/02919a911bb647ceac84de99afb00ea2da8c2725',
    downloadBytes: 34_870_945,
    files: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'],
  },
};

/** Version the whole image pipeline, including routing and score aggregation. */
export const IMAGE_PIPELINE_REVISION = `${SELECTED_MODELS.image.id}:${SELECTED_MODELS.image.revision}:${ANIME_RATING_MODEL.id}:${ANIME_RATING_MODEL.revision}:routing-v1`;
