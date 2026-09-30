// @vitest-environment node
import { Effect, Exit } from 'effect';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw/http';
import { setupServer } from 'msw/node';

const { createGatewayMock, evaluateMock } = vi.hoisted(() => ({
  createGatewayMock: vi.fn(),
  evaluateMock: vi.fn(),
}));

vi.mock('ai', () => ({ experimental_evaluate: evaluateMock }));
vi.mock('@ai-sdk/gateway', () => ({
  createGateway: (...args: unknown[]) => createGatewayMock(...args),
}));

import { evaluateText } from '../../src/background/text-provider';

const API_KEY = 'provider-secret-token';
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterAll(() => server.close());

beforeEach(() => {
  createGatewayMock.mockReset();
  evaluateMock.mockReset();
  server.resetHandlers();
  createGatewayMock.mockImplementation(() => ({ evaluationModel: (id: string) => ({ id }) }));
});

afterEach(() => {
  server.resetHandlers();
});

describe('text provider effects', () => {
  it('returns a typed status error without exposing the provider key', async () => {
    server.use(
      http.post('https://api.typesafe.ai/v1/systemone', () =>
        HttpResponse.json({ error: { message: `Invalid key ${API_KEY}` } }, { status: 401 }),
      ),
    );

    const result = await Effect.runPromise(
      Effect.result(evaluateText({ provider: 'typesafe', apiKey: API_KEY, text: 'hello' })),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure).toMatchObject({
        _tag: 'TextProviderError',
        provider: 'typesafe',
        statusCode: 401,
        message: 'Invalid key [redacted]',
      });
      expect(JSON.stringify(result.failure)).not.toContain(API_KEY);
      expect(result.failure).not.toHaveProperty('cause');
    }
  });

  it.each([
    ['typesafe', 'https://api.typesafe.ai/v1/systemone'],
    ['openrouter', 'https://openrouter.ai/api/alpha/decisions'],
  ] as const)('decodes HTTP probability responses from %s', async (provider, endpoint) => {
    server.use(
      http.post(endpoint, () =>
        HttpResponse.json({
          answers: { sexual: { noul: 0.9 }, ai: { probability: 0.01 } },
        }),
      ),
    );
    expect(
      await Effect.runPromise(
        evaluateText({
          provider,
          apiKey: API_KEY,
          text: 'test input',
        }),
      ),
    ).toEqual({ sexual: 0.9, ai: 0.01 });
  });

  it('rejects malformed probabilities received over HTTP', async () => {
    server.use(
      http.post('https://api.typesafe.ai/v1/systemone', () =>
        HttpResponse.json({ answers: { sexual: { noul: 1.1 }, ai: { noul: 0.01 } } }),
      ),
    );
    const result = await Effect.runPromise(
      Effect.result(
        evaluateText({
          provider: 'typesafe',
          apiKey: API_KEY,
          text: 'test input',
        }),
      ),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') expect(result.failure.message).toContain('invalid probability');
  });

  it('reports a network failure as a typed provider error', async () => {
    server.use(http.post('https://api.typesafe.ai/v1/systemone', () => HttpResponse.error()));
    const result = await Effect.runPromise(
      Effect.result(
        evaluateText({
          provider: 'typesafe',
          apiKey: API_KEY,
          text: 'test input',
        }),
      ),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure._tag).toBe('TextProviderError');
      expect(result.failure.provider).toBe('typesafe');
      expect(result.failure.statusCode).toBeUndefined();
      expect(JSON.stringify(result.failure)).not.toContain(API_KEY);
    }
  });

  it.each(['typesafe', 'vercel'] as const)(
    'interrupts the pending %s request',
    async (provider) => {
      const requestSignal = Promise.withResolvers<AbortSignal>();
      const rejectOnAbort = (signal: AbortSignal) => {
        const { promise, reject } = Promise.withResolvers<never>();
        requestSignal.resolve(signal);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        return promise;
      };

      if (provider === 'vercel') {
        evaluateMock.mockImplementation((options: { abortSignal: AbortSignal }) =>
          rejectOnAbort(options.abortSignal),
        );
      } else {
        server.use(
          http.post('https://api.typesafe.ai/v1/systemone', ({ request }) => {
            const response = Promise.withResolvers<Response>();
            requestSignal.resolve(request.signal);
            request.signal.addEventListener('abort', () => response.resolve(HttpResponse.error()), {
              once: true,
            });
            return response.promise;
          }),
        );
      }

      const controller = new AbortController();
      const pending = Effect.runPromiseExit(
        evaluateText({ provider, apiKey: API_KEY, text: 'hello' }),
        { signal: controller.signal },
      );
      const signal = await requestSignal.promise;
      controller.abort();
      await vi.waitFor(() => expect(signal.aborted).toBe(true));
      expect(Exit.hasInterrupts(await pending)).toBe(true);
    },
  );
});
