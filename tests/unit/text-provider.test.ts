// @vitest-environment node
import { Effect, Exit } from 'effect';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw/http';
import { setupServer } from 'msw/node';

const { createGatewayMock, evaluateMock } = vi.hoisted(() => ({
  createGatewayMock: vi.fn(),
  evaluateMock: vi.fn(),
}));

vi.mock('ai', () => ({ experimental_decide: evaluateMock }));
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
  evaluateMock.mockImplementation(async (options) => {
    const actual = await vi.importActual<typeof import('ai')>('ai');
    return actual.experimental_decide(options);
  });
  server.resetHandlers();
  createGatewayMock.mockImplementation(() => ({ decisionModel: (id: string) => ({ id }) }));
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
          answers: { sexual: { type: 'noul', noul: 0.9 } },
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
    ).toEqual({ sexual: 0.9 });
  });

  it('rejects malformed probabilities received over HTTP', async () => {
    server.use(
      http.post('https://api.typesafe.ai/v1/systemone', () =>
        HttpResponse.json({ answers: { sexual: { type: 'noul', noul: 1.1 } } }),
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
    if (result._tag === 'Failure')
      expect(result.failure.message).toMatch(/probability|Invalid response|invalid/i);
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

  it.each([
    ['typesafe', 'https://api.typesafe.ai/v1/systemone'],
    ['openrouter', 'https://openrouter.ai/api/alpha/decisions'],
  ] as const)(
    'sends enabled custom filters in one SDK decision call through %s',
    async (provider, endpoint) => {
      let body: unknown;
      server.use(
        http.post(endpoint, async ({ request }) => {
          expect(request.headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
          body = await request.json();
          return HttpResponse.json({
            answers: {
              sexual: { type: 'noul', noul: 0.1 },
              'custom:garden': { type: 'noul', noul: 0.9 },
            },
          });
        }),
      );
      const filter = {
        id: 'garden',
        name: 'Gardening',
        instructions: 'Posts about gardening',
        enabled: true,
        threshold: 0.65,
      };
      expect(
        await Effect.runPromise(
          evaluateText({
            provider,
            apiKey: API_KEY,
            text: 'Garden advice',
            filters: [filter, { ...filter, id: 'disabled', enabled: false }],
          }),
        ),
      ).toEqual({ sexual: 0.1, custom: { garden: 0.9 } });
      expect(body).toMatchObject({
        state: { tweet_text: 'Garden advice' },
        questions: {
          'custom:garden': {
            type: 'noul',
            instructions: expect.stringContaining(filter.instructions),
          },
        },
      });
      expect(body).not.toHaveProperty('questions.custom:disabled');
    },
  );

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
        // Observe the native transport signal; MSW's cloned Request signal can
        // outlive an interrupted fetch on Node 26.
        const originalFetch = globalThis.fetch;
        let transportSignal: AbortSignal | undefined;
        vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
          transportSignal = init?.signal ?? undefined;
          return originalFetch(input, init);
        });
        server.use(
          http.post('https://api.typesafe.ai/v1/systemone', () => {
            const response = Promise.withResolvers<Response>();
            if (!transportSignal) throw new Error('Missing transport abort signal');
            requestSignal.resolve(transportSignal);
            transportSignal.addEventListener(
              'abort',
              () =>
                response.resolve(
                  HttpResponse.json({ answers: { sexual: { type: 'noul', noul: 0.1 } } }),
                ),
              { once: true },
            );
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
