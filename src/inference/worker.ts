import { Effect, Layer, ManagedRuntime, Semaphore } from 'effect';
import * as Schema from 'effect/Schema';
import { createLocalModels } from './models';
import { InferenceRequestSchema, type InferenceReply } from '../shared/inference';

const WorkerRequestSchema = Schema.Struct({ id: Schema.Int, request: InferenceRequestSchema });
class LocalInferenceError extends Schema.TaggedError<LocalInferenceError>()('LocalInferenceError', {
  message: Schema.String,
}) {}
const runtime = ManagedRuntime.make(Layer.empty);
const inference = Semaphore.makeUnsafe(1);
const models = createLocalModels((status) => self.postMessage({ type: 'status', models: status }));
self.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!Schema.is(WorkerRequestSchema)(event.data)) return;
  const { id, request } = event.data;
  const classify = Effect.tryPromise({
    try: async (): Promise<InferenceReply> => {
      if (request.operation === 'warmup') {
        await Promise.all(request.models.map((kind) => models.load(kind)));
        return { ok: true, scores: {} };
      }
      if (request.operation === 'image')
        return { ok: true, ...(await models.classifyImage(request.dataUrl)) };
      const scores = await models.classifyAiText(request.text);
      return { ok: true, scores };
    },
    catch: (error) =>
      new LocalInferenceError({
        message: error instanceof Error ? error.message : String(error),
      }),
  });
  runtime.runFork(
    inference
      .withPermits(1)(classify)
      .pipe(
        Effect.match({
          onSuccess: (reply) => self.postMessage({ type: 'result', id, reply }),
          onFailure: (error) =>
            self.postMessage({ type: 'result', id, reply: { ok: false, error: error.message } }),
        }),
      ),
  );
});
