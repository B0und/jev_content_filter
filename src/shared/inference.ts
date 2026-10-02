import * as Schema from 'effect/Schema';
import { CATEGORY_KEYS } from './types';

export type ModelKind = 'image' | 'aiText';
export interface ModelStatus {
  state: 'idle' | 'loading' | 'ready' | 'error';
  loaded: number;
  total: number;
  error: string;
}
export type ModelStatuses = Record<ModelKind, ModelStatus>;
export const MODEL_STATUS_KEY = 'localModelStatus';
export function initialModelStatuses(): ModelStatuses {
  return {
    image: { state: 'idle', loaded: 0, total: 0, error: '' },
    aiText: { state: 'idle', loaded: 0, total: 0, error: '' },
  };
}
const probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const byteCount = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
export const ModelKindSchema = Schema.Literals(['image', 'aiText']);
export const ModelStatusSchema = Schema.Struct({
  state: Schema.Literals(['idle', 'loading', 'ready', 'error']),
  loaded: byteCount,
  total: byteCount,
  error: Schema.String,
});
export const ModelStatusesSchema = Schema.Struct({
  image: ModelStatusSchema,
  aiText: ModelStatusSchema,
});
export const InferenceRequestSchema = Schema.Union([
  Schema.Struct({
    target: Schema.Literal('local-inference'),
    operation: Schema.Literal('warmup'),
    models: Schema.mutable(Schema.Array(ModelKindSchema)),
  }),
  Schema.Struct({
    target: Schema.Literal('local-inference'),
    operation: Schema.Literal('image'),
    dataUrl: Schema.String,
  }),
  Schema.Struct({
    target: Schema.Literal('local-inference'),
    operation: Schema.Literal('aiText'),
    text: Schema.String,
  }),
]);
export type InferenceRequest = typeof InferenceRequestSchema.Type;
export const InferenceReplySchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    scores: Schema.Record(Schema.Literals(CATEGORY_KEYS), Schema.optionalKey(probability)),
    warning: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);
export type InferenceReply = typeof InferenceReplySchema.Type;
