import { experimental_evaluate } from 'ai';
import { createGateway, type GatewayProvider } from '@ai-sdk/gateway';
import { Effect } from 'effect';
import * as Schema from 'effect/Schema';
import type { TextProvider } from '../shared/types';

export interface TextScores {
  sexual: number;
  ai: number;
}

interface TextEvaluationRequest {
  provider: TextProvider;
  apiKey: string;
  text: string;
}

export class TextProviderError extends Schema.TaggedError<TextProviderError>()(
  'TextProviderError',
  {
    provider: Schema.Literals(['vercel', 'typesafe', 'openrouter']),
    message: Schema.String,
    statusCode: Schema.optional(Schema.Finite),
  },
) {}

const DIRECT_PROVIDER_CONFIG = {
  typesafe: {
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
  },
  openrouter: {
    endpoint: 'https://openrouter.ai/api/alpha/decisions',
    model: 'typesafe/jev-1.13',
  },
} as const;

const DECISION_QUESTIONS = {
  sexual: {
    type: 'noul',
    instructions:
      'Does this tweet contain explicit sexual content, lewd innuendo, heavily implied sexual content, or engagement bait designed to arouse?',
    criteria: {
      true: 'Lewd imagery descriptions, sexual innuendo, thirst traps, or gooner-bait phrasing',
      false:
        'Ordinary non-sexual content, even if it discusses news, health, or relationships factually',
    },
  },
  ai: {
    type: 'noul',
    instructions:
      'Was this tweet most likely written by an AI or LLM, e.g. generic AI phrasing, engagement-farming templates, or machine-generated summaries?',
    criteria: {
      true: 'Tell-tale LLM phrasing, over-structured lists, hollow engagement bait, synthetic voice',
      false: 'Natural human writing, including slang, typos, or short fragments',
    },
  },
} as const;

const GATEWAY_QUESTIONS = {
  sexual: {
    type: 'boolean',
    instructions:
      'Does this tweet contain explicit sexual content, lewd innuendo, heavily implied sexual content, or engagement bait designed to arouse?',
    criteria: {
      true: 'Lewd imagery descriptions, sexual innuendo, thirst traps, or gooner-bait phrasing',
      false:
        'Ordinary non-sexual content, even if it discusses news, health, or relationships factually',
    },
  },
  ai: {
    type: 'boolean',
    instructions:
      'Was this tweet most likely written by an AI or LLM, e.g. generic AI phrasing, engagement-farming templates, or machine-generated summaries?',
    criteria: {
      true: 'Tell-tale LLM phrasing, over-structured lists, hollow engagement bait, synthetic voice',
      false: 'Natural human writing, including slang, typos, or short fragments',
    },
  },
} as const;

const AnswerSchema = Schema.Struct({
  probability: Schema.optional(Schema.Unknown),
  noul: Schema.optional(Schema.Unknown),
});
const AnswersSchema = Schema.Record(Schema.String, Schema.Unknown);
const ProbabilitySchema = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const EvaluationResponseSchema = Schema.Struct({ answers: Schema.optional(Schema.Unknown) });
const ProviderErrorResponseSchema = Schema.Struct({
  error: Schema.optional(Schema.Struct({ message: Schema.optional(Schema.String) })),
});

let gatewayInstance: GatewayProvider | null = null;
let gatewayKeyUsed = '';

function gateway(apiKey: string): GatewayProvider {
  if (!gatewayInstance || gatewayKeyUsed !== apiKey) {
    gatewayInstance = createGateway({ apiKey });
    gatewayKeyUsed = apiKey;
  }
  return gatewayInstance;
}

function probabilityOf(answer: unknown): number | undefined {
  const value = answer ?? {};
  if (!Schema.is(AnswerSchema)(value)) return undefined;
  const probability = typeof value.probability === 'number' ? value.probability : value.noul;
  return Schema.is(ProbabilitySchema)(probability) ? probability : undefined;
}

function scoresFromAnswers(rawAnswers: unknown): TextScores {
  const input = rawAnswers ?? {};
  const answers = Schema.is(AnswersSchema)(input) ? input : {};
  const sexual = probabilityOf(answers.sexual);
  const ai = probabilityOf(answers.ai);
  if (sexual === undefined || ai === undefined) {
    throw new Error(
      `Jev returned invalid probability (sexual: ${JSON.stringify(answers.sexual)}, ai: ${JSON.stringify(answers.ai)})`,
    );
  }
  return { sexual, ai };
}

class ProviderResponseError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'ProviderResponseError';
    this.statusCode = statusCode;
  }
}

function asTextProviderError(
  provider: TextProvider,
  apiKey: string,
  cause: unknown,
): TextProviderError {
  let statusCode: number | undefined;
  if (typeof cause === 'object' && cause !== null && 'statusCode' in cause) {
    if (typeof cause.statusCode === 'number') statusCode = cause.statusCode;
  }
  const originalMessage = cause instanceof Error ? cause.message : String(cause);
  const message = apiKey ? originalMessage.replaceAll(apiKey, '[redacted]') : originalMessage;
  return new TextProviderError({
    provider,
    message,
    ...(statusCode === undefined ? {} : { statusCode }),
  });
}

const evaluateViaDecisions = async (
  provider: Exclude<TextProvider, 'vercel'>,
  apiKey: string,
  text: string,
  signal: AbortSignal,
): Promise<TextScores> => {
  const config = DIRECT_PROVIDER_CONFIG[provider];
  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      state: { tweet_text: text },
      questions: DECISION_QUESTIONS,
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
  });

  if (!response.ok) {
    let message = response.statusText || 'provider request failed';
    try {
      const body = Schema.decodeUnknownSync(ProviderErrorResponseSchema)(await response.json());
      if (body.error?.message !== undefined) message = body.error.message;
    } catch {
      // Preserve the HTTP status when the provider returns a non-JSON error.
    }
    throw new ProviderResponseError(response.status, message);
  }

  const result = Schema.decodeUnknownSync(EvaluationResponseSchema)(await response.json());
  return scoresFromAnswers(result.answers);
};

export const evaluateText = Effect.fnUntraced(function* ({
  provider,
  apiKey,
  text,
}: TextEvaluationRequest): Effect.fn.Return<TextScores, TextProviderError> {
  return yield* Effect.tryPromise({
    try: (signal) => {
      if (provider !== 'vercel') return evaluateViaDecisions(provider, apiKey, text, signal);

      return experimental_evaluate({
        model: gateway(apiKey).evaluationModel('typesafe-ai/jev'),
        maxRetries: 0,
        // Keep the provider deadline while inheriting Effect interruption.
        abortSignal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
        state: { tweet_text: text },
        questions: GATEWAY_QUESTIONS,
      }).then((result) =>
        scoresFromAnswers(Schema.decodeSync(EvaluationResponseSchema)(result).answers),
      );
    },
    catch: (cause) => asTextProviderError(provider, apiKey, cause),
  });
});
