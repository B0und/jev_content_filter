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

export const SELECTED_MODELS: Record<ModelKind, ModelDescriptor> = {
  image: {
    id: 'nsfwjs/mobilenet_v2',
    revision: 'd55a54c51f14380670064cc129b2ea51029c5e46',
    title: 'NSFWJS MobileNetV2',
    description:
      '2.7 MB model download. Retained after a 25-image comparison; preserves separate image categories.',
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
