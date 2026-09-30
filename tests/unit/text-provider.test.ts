import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createGatewayMock, evaluateMock, fetchMock } = vi.hoisted(() => ({
  createGatewayMock: vi.fn(),
  evaluateMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('ai', () => ({ experimental_evaluate: evaluateMock }));
vi.mock('@ai-sdk/gateway', () => ({
  createGateway: (...args: unknown[]) => createGatewayMock(...args),
}));

import { evaluateText } from '../../src/background/text-provider';

const API_KEY = 'provider-secret-token';

beforeEach(() => {
  createGatewayMock.mockReset();
  evaluateMock.mockReset();
  fetchMock.mockReset();
  createGatewayMock.mockImplementation(() => ({ evaluationModel: (id: string) => ({ id }) }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('text provider effects', () => {
  it('returns a typed status error without exposing the provider key', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: { message: `Invalid key ${API_KEY}` } }),
    });

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
        fetchMock.mockImplementation((_url: string, options: RequestInit) => {
          if (!(options.signal instanceof AbortSignal)) throw new Error('request signal missing');
          return rejectOnAbort(options.signal);
        });
      }

      const controller = new AbortController();
      const pending = Effect.runPromise(
        evaluateText({ provider, apiKey: API_KEY, text: 'hello' }),
        { signal: controller.signal },
      );
      const signal = await requestSignal.promise;
      controller.abort();
      await vi.waitFor(() => expect(signal.aborted).toBe(true));
      await pending.catch(() => undefined);
      expect(signal.aborted).toBe(true);
    },
  );
});
