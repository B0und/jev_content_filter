import { experimental_evaluate } from 'ai';
import { createGateway, type GatewayProvider } from '@ai-sdk/gateway';
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
  const value = (answer as { probability?: unknown; noul?: unknown } | undefined) ?? {};
  const probability = typeof value.probability === 'number' ? value.probability : value.noul;
  if (
    typeof probability !== 'number' ||
    !Number.isFinite(probability) ||
    probability < 0 ||
    probability > 1
  ) {
    return undefined;
  }
  return probability;
}

function scoresFromAnswers(rawAnswers: unknown): TextScores {
  const answers = (rawAnswers ?? {}) as Record<string, unknown>;
  const sexual = probabilityOf(answers.sexual);
  const ai = probabilityOf(answers.ai);
  if (sexual === undefined || ai === undefined) {
    throw new Error(
      `Jev returned invalid probability (sexual: ${JSON.stringify(answers.sexual)}, ai: ${JSON.stringify(answers.ai)})`,
    );
  }
  return { sexual, ai };
}

async function evaluateViaGateway(apiKey: string, text: string): Promise<TextScores> {
  const result = await experimental_evaluate({
    model: gateway(apiKey).evaluationModel('typesafe-ai/jev'),
    maxRetries: 0,
    // Gateway can take ~15s to surface a rate-limit error; cap the wait so
    // the fail-open path isn't held hostage by a doomed request.
    abortSignal: AbortSignal.timeout(8000),
    state: { tweet_text: text },
    questions: {
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
    },
  });
  return scoresFromAnswers((result as { answers?: unknown }).answers);
}

class ProviderResponseError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'ProviderResponseError';
    this.statusCode = statusCode;
  }
}

async function evaluateViaDecisions(
  provider: Exclude<TextProvider, 'vercel'>,
  apiKey: string,
  text: string,
): Promise<TextScores> {
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
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    let message = response.statusText || 'provider request failed';
    try {
      const body = (await response.json()) as { error?: { message?: unknown } };
      if (typeof body.error?.message === 'string') message = body.error.message;
    } catch {
      // Preserve the HTTP status when the provider returns a non-JSON error.
    }
    throw new ProviderResponseError(response.status, message);
  }

  const result = (await response.json()) as { answers?: unknown };
  return scoresFromAnswers(result.answers);
}

export function evaluateText({
  provider,
  apiKey,
  text,
}: TextEvaluationRequest): Promise<TextScores> {
  if (provider === 'vercel') return evaluateViaGateway(apiKey, text);
  return evaluateViaDecisions(provider, apiKey, text);
}
