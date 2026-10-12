// @vitest-environment node
import { Result, Effect, Exit } from 'effect';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw/http';
import { setupServer } from 'msw/node';

const createGatewayMock = vi.fn();

const evaluateMock = vi.fn();

import {
  textProviderSdk,
  evaluateText as evaluateProviderText,
} from '../../src/background/text-provider';
import { defaultSettings } from '../../src/filtering/types';

const evaluateText = (
  request: Omit<Parameters<typeof evaluateProviderText>[0], 'filters'> & {
    filters?: Parameters<typeof evaluateProviderText>[0]['filters'];
  },
) => evaluateProviderText({ filters: defaultSettings().textFilters, ...request });

const API_KEY = 'provider-secret-token';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));

afterAll(() => server.close());

beforeEach(() => {
  vi.spyOn(textProviderSdk, 'decide').mockImplementation(evaluateMock);
  vi.spyOn(textProviderSdk, 'createGateway').mockImplementation(createGatewayMock);
  createGatewayMock.mockReset();
  evaluateMock.mockReset();
  evaluateMock.mockImplementation(async (options) => {
    const actual = await import('ai');

    return actual.experimental_decide(options);
  });
  server.resetHandlers();
  createGatewayMock.mockImplementation(() => ({ decisionModel: (id: string) => ({ id }) }));
});

afterEach(() => {
  server.resetHandlers();
});

describe('text provider effects', () => {
  it('makes no decision call when all text filters are disabled or deleted', async () => {
    for (const filters of [
      [],
      defaultSettings().textFilters.map((filter) => ({ ...filter, enabled: false })),
    ]) {
      expect(
        await Effect.runPromise(
          evaluateText({ provider: 'typesafe', apiKey: API_KEY, text: 'hello', filters }),
        ),
      ).toEqual({ custom: {} });
    }

    expect(evaluateMock).not.toHaveBeenCalled();
  });
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

    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe('TextProviderError');
      expect(result.failure).toMatchObject({
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
          answers: { 'custom:preset-1': { type: 'noul', noul: 0.9 } },
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
    ).toEqual({ custom: { 'preset-1': 0.9 } });
  });

  it('lets the SDK reject malformed probabilities received over HTTP', async () => {
    server.use(
      http.post('https://api.typesafe.ai/v1/systemone', () =>
        HttpResponse.json({ answers: { 'custom:preset-1': { type: 'noul', noul: 1.1 } } }),
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

    if (Result.isFailure(result))
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

    if (Result.isFailure(result)) {
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
      let calls = 0;
      server.use(
        http.post(endpoint, async ({ request }) => {
          calls++;
          expect(request.headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
          body = await request.json();

          return HttpResponse.json({
            answers: {
              'custom:garden': { type: 'noul', noul: 0.9 },
              'custom:sports': { type: 'noul', noul: 0.2 },
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
            filters: [
              filter,
              { ...filter, id: 'sports', instructions: 'Posts about sports' },
              { ...filter, id: 'disabled', enabled: false },
            ],
          }),
        ),
      ).toEqual({ custom: { garden: 0.9, sports: 0.2 } });
      expect(body).toMatchObject({
        state: { tweet_text: 'Garden advice' },
        questions: {
          'custom:garden': {
            type: 'noul',
            instructions: expect.stringContaining(filter.instructions),
          },
        },
      });
      expect(calls).toBe(1);
      expect(body).toHaveProperty('questions.custom:sports');
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
                  HttpResponse.json({
                    answers: { 'custom:preset-1': { type: 'noul', noul: 0.1 } },
                  }),
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
