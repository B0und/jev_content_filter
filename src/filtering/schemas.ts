import * as Schema from 'effect/Schema';
import { CATEGORY_KEYS, TEXT_PROVIDERS } from './types';
import { ModelKindSchema, ModelStatusesSchema } from '../inference/contracts';

export const CategoryKeySchema = Schema.Literals(CATEGORY_KEYS);
export const TextProviderSchema = Schema.Literals(TEXT_PROVIDERS);
const probability = Schema.Number.check(
  Schema.isFinite(),
  Schema.isBetween({ minimum: 0, maximum: 1 }),
);
const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const SettingsSchema = Schema.Struct({
  masterEnabled: Schema.Boolean,
  textProvider: TextProviderSchema,
  providerKeys: Schema.Record(TextProviderSchema, Schema.String),
  textConfigRevision: nonNegativeInt,
  enabled: Schema.Record(CategoryKeySchema, Schema.Boolean),
  thresholds: Schema.Record(CategoryKeySchema, probability),
});

export const SettingsChangeSchema = Schema.Union([
  Schema.Struct({ field: Schema.Literal('masterEnabled'), value: Schema.Boolean }),
  Schema.Struct({ field: Schema.Literal('textProvider'), value: TextProviderSchema }),
  Schema.Struct({
    field: Schema.Literal('providerKey'),
    provider: TextProviderSchema,
    value: Schema.String,
  }),
  Schema.Struct({
    field: Schema.Literal('enabled'),
    category: CategoryKeySchema,
    value: Schema.Boolean,
  }),
  Schema.Struct({
    field: Schema.Literal('threshold'),
    category: CategoryKeySchema,
    value: probability,
  }),
]);

export const FilterStatusSchema = Schema.Struct({
  state: Schema.Literals(['ok', 'failing']),
  reason: Schema.optionalKey(Schema.String),
  updatedAt: Schema.Number.check(Schema.isFinite()),
});

export const BlockedEntrySchema = Schema.Struct({
  tweetId: Schema.String,
  handle: Schema.optionalKey(Schema.String),
  target: Schema.optionalKey(Schema.Literals(['post', 'preview'])),
  author: Schema.String,
  snippet: Schema.String,
  surface: Schema.String,
  ts: Schema.Number.check(Schema.isFinite()),
  reasons: Schema.mutable(
    Schema.Array(Schema.Struct({ key: CategoryKeySchema, score: probability })),
  ),
});

export const ScanErrorEntrySchema = Schema.Struct({
  ts: Schema.Number.check(Schema.isFinite()),
  message: Schema.String,
  tweetId: Schema.optionalKey(Schema.String),
  handle: Schema.optionalKey(Schema.String),
});

export const ClearReplySchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    type: Schema.Literal('clear-log'),
    cleared: Schema.mutable(Schema.Array(BlockedEntrySchema)),
  }),
  Schema.Struct({
    ok: Schema.Literal(true),
    type: Schema.Literal('clear-errors'),
    cleared: Schema.mutable(Schema.Array(ScanErrorEntrySchema)),
  }),
]);
export type ClearReply = typeof ClearReplySchema.Type;

export const TabReportSchema = Schema.Struct({
  analyzed: nonNegativeInt,
  blocked: nonNegativeInt,
  pageAnalyzed: nonNegativeInt,
  pageBlocked: nonNegativeInt,
  pending: nonNegativeInt,
  failed: nonNegativeInt,
  retrying: nonNegativeInt,
  lastScannedAt: Schema.Number.check(Schema.isFinite()),
  errors: Schema.mutable(Schema.Array(Schema.String)),
});

export const BgRequestSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('jev'),
    tweetId: Schema.String,
    text: Schema.String,
    provider: TextProviderSchema,
    revision: nonNegativeInt,
  }),
  Schema.Struct({ type: Schema.Literal('update-settings'), change: SettingsChangeSchema }),
  Schema.Struct({ type: Schema.Literal('classify-image'), url: Schema.String }),
  Schema.Struct({ type: Schema.Literal('classify-ai'), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal('load-model'), kind: ModelKindSchema }),
  Schema.Struct({ type: Schema.Literal('local-model-status'), models: ModelStatusesSchema }),
  Schema.Struct({ type: Schema.Literal('get-status') }),
  Schema.Struct({ type: Schema.Literal('log-blocked'), entry: BlockedEntrySchema }),
  Schema.Struct({
    type: Schema.Literal('log-error'),
    message: Schema.String,
    tweetId: Schema.String,
    handle: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal('clear-log') }),
  Schema.Struct({ type: Schema.Literal('clear-errors') }),
  Schema.Struct({ type: Schema.Literal('open-logs'), errors: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal('tab-stats'), blocked: nonNegativeInt }),
]);

export const SettingsReplySchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), settings: SettingsSchema }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);
