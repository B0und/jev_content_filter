import * as Schema from 'effect/Schema';
import { pipeline } from '@huggingface/transformers';
import { SELECTED_MODELS } from './model-catalog';

const MAX_INPUT_TOKENS = 512;

const AI_LABEL_ID = 1;

export async function loadAiTextModel(
  onProgress: (loaded: number, total: number) => void,
): Promise<(text: string) => Promise<{ aiGenerated: number }>> {
  const selected = SELECTED_MODELS.aiText;

  const classifier = await pipeline('text-classification', selected.id, {
    revision: selected.revision,
    dtype: 'q8',
    progress_callback: (progress) => {
      if (
        'file' in progress &&
        Schema.is(Schema.String)(progress.file) &&
        progress.file.endsWith('.onnx') &&
        'loaded' in progress &&
        'total' in progress
      ) {
        onProgress(progress.loaded, progress.total);
      }
    },
  });

  const tokenizerMax = Number(classifier.tokenizer.model_max_length);
  const modelMax = Number(classifier.model.config.max_position_embeddings);

  // The pinned E5 tokenizer config uses a huge sentinel, so enforce the model's real input bound.
  const maxTokens = Math.min(
    MAX_INPUT_TOKENS,
    Number.isFinite(tokenizerMax) && tokenizerMax > 0 ? tokenizerMax : MAX_INPUT_TOKENS,
    Number.isFinite(modelMax) && modelMax > 0 ? modelMax : MAX_INPUT_TOKENS,
  );

  if (!Number.isSafeInteger(maxTokens) || maxTokens < 2) {
    throw new Error('The selected AI-text model has no safe token limit.');
  }

  return async (text) => {
    const inputs = classifier.tokenizer(text, {
      padding: true,
      truncation: true,
      max_length: maxTokens,
    });

    const { logits } = await classifier.model(inputs);

    if (logits.dims.length !== 2 || logits.dims[0] !== 1 || logits.dims[1] !== 2) {
      throw new Error('The selected AI-text model did not return two class logits.');
    }

    const humanLogit = Number(logits.data[0]);
    const aiLogit = Number(logits.data[AI_LABEL_ID]);

    if (!Number.isFinite(humanLogit) || !Number.isFinite(aiLogit)) {
      throw new Error('The selected AI-text model returned invalid class logits.');
    }

    const maxLogit = Math.max(humanLogit, aiLogit);
    const humanWeight = Math.exp(humanLogit - maxLogit);
    const aiWeight = Math.exp(aiLogit - maxLogit);
    const aiGenerated = aiWeight / (humanWeight + aiWeight);

    if (!Number.isFinite(aiGenerated) || aiGenerated < 0 || aiGenerated > 1) {
      throw new Error('The selected AI-text model returned an invalid probability.');
    }

    return { aiGenerated };
  };
}
