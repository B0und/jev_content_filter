import { Result } from 'effect';
import * as Schema from 'effect/Schema';
import { InferenceReplySchema, OcrReplyCodec } from '../../inference/contracts';

const ResultEnvelopeSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('result'), id: Schema.Int, reply: InferenceReplySchema }),
  Schema.Struct({
    type: Schema.Literal('ocr-result'),
    id: Schema.Int,
    reply: Schema.toEncoded(OcrReplyCodec),
  }),
]);

const CorrelationSchema = Schema.Struct({
  type: Schema.Literals(['result', 'ocr-result']),
  id: Schema.Int,
});

export type InferenceResultEnvelope = typeof ResultEnvelopeSchema.Type;

interface PendingReply {
  expected: InferenceResultEnvelope['type'];
  resolve: (reply: InferenceResultEnvelope) => void;
  reject: (error: Error) => void;
}

/** Correlate and validate replies before releasing a request's worker slot. */
export function createPendingReplies() {
  const pending = new Map<number, PendingReply>();

  return {
    add: (id: number, reply: PendingReply) => pending.set(id, reply),
    cancel: (id: number) => pending.delete(id),
    settle: (event: MessageEvent<unknown>): number | null => {
      if (!Schema.is(CorrelationSchema)(event.data)) return null;
      const { id } = event.data;
      const request = pending.get(id);

      if (!request) return null;
      pending.delete(id);

      if (event.data.type !== request.expected)
        request.reject(new Error('Local inference worker returned the wrong result kind.'));
      else {
        const decoded = Schema.decodeUnknownResult(ResultEnvelopeSchema)(event.data);

        if (Result.isFailure(decoded))
          request.reject(new Error('Local inference worker returned an invalid result.'));
        else request.resolve(decoded.success);
      }

      return id;
    },
    failAll: (error: Error) => {
      const requests = [...pending.values()];
      pending.clear();

      for (const request of requests) request.reject(error);
    },
  };
}
