// Regression tests for the background service worker. Tests exercise the
// public seams only: registered message handlers via runtime.sendMessage /
// onMessage.trigger, and storage.local / storage.session state. The external
// AI evaluation (gateway model) is mocked; decisions and storage are real.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

const { evaluateMock, createGatewayMock, fetchMock } = vi.hoisted(() => ({
  evaluateMock: vi.fn(),
  createGatewayMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('ai', () => ({ experimental_evaluate: evaluateMock }));
vi.mock('@ai-sdk/gateway', () => ({
  createGateway: (...args: unknown[]) => createGatewayMock(...args),
}));

// Dynamic import here is intentional: it exercises a module-loading boundary.
// The worker keeps module-level state (settings cache, log queue, tab counts),
// so each test needs a fresh module instance via vi.resetModules(); a static
// import would pin one stateful instance for the whole file.
async function startWorker(): Promise<void> {
  vi.resetModules();
  const { startBackground } = await import('../../src/background/runtime');
  startBackground();
}

function okAnswer(probability: number) {
  return { type: 'boolean', probability };
}

function evaluateResult(answers: Record<string, unknown>) {
  return {
    answers,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    warnings: [],
  };
}

const SETTINGS = {
  masterEnabled: true,
  textProvider: 'vercel' as const,
  gatewayKey: 'test-only-not-a-real-key',
  enabled: {
    porn: true,
    hentai: true,
    sexy: true,
    drawings: true,
    sexualText: true,
    aiGenerated: true,
  },
  thresholds: {
    porn: 0.6,
    hentai: 0.6,
    sexy: 0.65,
    drawings: 0.7,
    sexualText: 0.65,
    aiGenerated: 0.65,
  },
};

function blockedEntry(tweetId: string) {
  return {
    tweetId,
    author: 'author',
    snippet: 'snippet',
    surface: 'timeline',
    ts: Date.now(),
    reasons: [{ key: 'porn' as const, score: 0.9 }],
  };
}

beforeEach(() => {
  fakeBrowser.reset();
  vi.stubGlobal('fetch', fetchMock);
  evaluateMock.mockReset();
  createGatewayMock.mockReset();
  fetchMock.mockReset();
  createGatewayMock.mockImplementation(() => ({ evaluationModel: (id: string) => ({ id }) }));
});

describe('background worker lifecycle', () => {
  it('registers the message listener synchronously with no awaits', async () => {
    await startWorker();
    expect(fakeBrowser.runtime.onMessage.hasListeners()).toBe(true);
  });

  it('answers a get-status message before settings finish loading', async () => {
    await startWorker();
    await expect(fakeBrowser.runtime.sendMessage({ type: 'get-status' })).resolves.toEqual({
      state: 'ok',
      updatedAt: 0,
    });
  });
});

describe('jev classification', () => {
  it('propagates valid probabilities to the caller', async () => {
    await fakeBrowser.storage.local.set({ settings: SETTINGS });
    await startWorker();
    evaluateMock.mockResolvedValue(
      evaluateResult({
        sexual: okAnswer(0.93),
        ai: okAnswer(0.05),
      }),
    );
    await expect(
      fakeBrowser.runtime.sendMessage({ type: 'jev', tweetId: 't1', text: 'hi' }),
    ).resolves.toEqual({ ok: true, sexual: 0.93, ai: 0.05 });
  });
  it.each([
    {
      provider: 'typesafe' as const,
      endpoint: 'https://api.typesafe.ai/v1/systemone',
      model: 'jev-latest',
      sexual: 0.87,
      ai: 0.12,
    },
    {
      provider: 'openrouter' as const,
      endpoint: 'https://openrouter.ai/api/alpha/decisions',
      model: 'typesafe/jev-1.13',
      sexual: 0.78,
      ai: 0.21,
    },
  ])('uses the $provider Decisions API', async ({ provider, endpoint, model, sexual, ai }) => {
    await fakeBrowser.storage.local.set({
      settings: { ...SETTINGS, textProvider: provider },
    });
    await startWorker();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: {
          sexual: { type: 'noul', noul: sexual },
          ai: { type: 'noul', noul: ai },
        },
      }),
    });

    await expect(
      fakeBrowser.runtime.sendMessage({ type: 'jev', tweetId: 'direct', text: 'hello' }),
    ).resolves.toEqual({ ok: true, sexual, ai });

    expect(fetchMock).toHaveBeenCalledWith(
      endpoint,
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-only-not-a-real-key',
          'Content-Type': 'application/json',
        },
      }),
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(request.body as string)).toMatchObject({
      model,
      state: { tweet_text: 'hello' },
      questions: {
        sexual: { type: 'noul' },
        ai: { type: 'noul' },
      },
    });
  });

  it('fails open on missing/undefined probability instead of propagating it', async () => {
    await fakeBrowser.storage.local.set({ settings: SETTINGS });
    await startWorker();
    evaluateMock.mockResolvedValue(
      evaluateResult({
        sexual: { type: 'boolean', probability: undefined },
        ai: okAnswer(0.5),
      }),
    );
    const reply = await fakeBrowser.runtime.sendMessage({
      type: 'jev',
      tweetId: 't1',
      text: 'hi',
    });
    expect(reply).toEqual({ ok: false, error: expect.stringContaining('probability') });
    expect(reply).not.toHaveProperty('sexual');
  });

  it('fails open on out-of-range probabilities', async () => {
    await fakeBrowser.storage.local.set({ settings: SETTINGS });
    await startWorker();
    evaluateMock.mockResolvedValue(
      evaluateResult({
        sexual: okAnswer(1.5),
        ai: okAnswer(0.5),
      }),
    );
    await expect(
      fakeBrowser.runtime.sendMessage({ type: 'jev', tweetId: 't1', text: 'hi' }),
    ).resolves.toEqual({ ok: false, error: expect.stringContaining('probability') });
  });

  it('fails open on a missing answer object', async () => {
    await fakeBrowser.storage.local.set({ settings: SETTINGS });
    await startWorker();
    evaluateMock.mockResolvedValue(evaluateResult({ ai: okAnswer(0.5) }));
    const reply = await fakeBrowser.runtime.sendMessage({
      type: 'jev',
      tweetId: 't1',
      text: 'hi',
    });
    expect(reply.ok).toBe(false);
  });

  it('clears a stored failing status only after a clean success', async () => {
    await fakeBrowser.storage.local.set({
      settings: SETTINGS,
      filterStatus: { state: 'failing', reason: 'boom', updatedAt: 1 },
    });
    await startWorker();

    evaluateMock.mockRejectedValue(new Error('gateway down'));
    await expect(fakeBrowser.runtime.sendMessage({ type: 'get-status' })).resolves.toMatchObject({
      state: 'failing',
    });

    evaluateMock.mockResolvedValue(
      evaluateResult({
        sexual: okAnswer(0.1),
        ai: okAnswer(0.1),
      }),
    );
    await expect(
      fakeBrowser.runtime.sendMessage({ type: 'jev', tweetId: 't2', text: 'x' }),
    ).resolves.toEqual({ ok: true, sexual: 0.1, ai: 0.1 });
    await expect(fakeBrowser.runtime.sendMessage({ type: 'get-status' })).resolves.toMatchObject({
      state: 'ok',
    });
  });
});

describe('gateway status surfacing', () => {
  it('prefixes the HTTP status so auth failures are non-retryable', async () => {
    // Real SDK 401s arrive as GatewayResponseError: statusCode present, but a
    // message that never mentions "401" ("Invalid error response format: …").
    await fakeBrowser.storage.local.set({ settings: SETTINGS });
    await startWorker();
    const error = new Error('Invalid error response format: Gateway request failed');
    (error as { statusCode?: number }).statusCode = 401;
    evaluateMock.mockRejectedValue(error);
    const reply = (await fakeBrowser.runtime.sendMessage({
      type: 'jev',
      tweetId: 't1',
      text: 'hi',
    })) as { ok: boolean; error: string };
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('401');
  });

  it('leaves messages that already carry the status untouched', async () => {
    await fakeBrowser.storage.local.set({ settings: SETTINGS });
    await startWorker();
    const error = new Error('HTTP 403 forbidden');
    (error as { statusCode?: number }).statusCode = 403;
    evaluateMock.mockRejectedValue(error);
    const reply = (await fakeBrowser.runtime.sendMessage({
      type: 'jev',
      tweetId: 't1',
      text: 'hi',
    })) as { ok: boolean; error: string };
    expect(reply.error).toBe('HTTP 403 forbidden');
  });
});

describe('serialized log queue', () => {
  it('serializes concurrent blocked-log appends from different tabs', async () => {
    await startWorker();
    await Promise.all([
      fakeBrowser.runtime.sendMessage({ type: 'log-blocked', entry: blockedEntry('a') }),
      fakeBrowser.runtime.sendMessage({ type: 'log-blocked', entry: blockedEntry('b') }),
    ]);
    const stored = await fakeBrowser.storage.local.get('blockedLog');
    const log = stored.blockedLog as Array<{ tweetId: string }>;
    expect(log.map((e) => e.tweetId).sort()).toEqual(['a', 'b']);
  });

  it('routes clear-log through the same queue so appends cannot resurrect entries', async () => {
    await startWorker();
    await fakeBrowser.runtime.sendMessage({ type: 'log-blocked', entry: blockedEntry('a') });

    // A clear racing an append: the clear is queued behind the append, so the
    // append's pre-clear snapshot cannot overwrite the emptied log.
    const append = fakeBrowser.runtime.sendMessage({
      type: 'log-blocked',
      entry: blockedEntry('b'),
    });
    const cleared = await fakeBrowser.runtime.sendMessage({ type: 'clear-log' });
    await expect(append).resolves.toBeDefined();

    expect(cleared).toEqual({ ok: true });
    let stored = await fakeBrowser.storage.local.get('blockedLog');
    expect(stored.blockedLog).toEqual([]);

    await fakeBrowser.runtime.sendMessage({ type: 'log-blocked', entry: blockedEntry('c') });
    stored = await fakeBrowser.storage.local.get('blockedLog');
    expect((stored.blockedLog as Array<{ tweetId: string }>).map((e) => e.tweetId)).toEqual(['c']);
  });

  it('routes clear-errors through the same queue', async () => {
    await startWorker();
    await fakeBrowser.runtime.sendMessage({
      type: 'log-error',
      message: 'boom',
      tweetId: 't1',
    });
    await expect(fakeBrowser.runtime.sendMessage({ type: 'clear-errors' })).resolves.toEqual({
      ok: true,
    });
    const stored = await fakeBrowser.storage.local.get('scanErrors');
    expect(stored.scanErrors).toEqual([]);
  });
});

describe('per-tab badge counts', () => {
  it('stores and repaints the tab count reported by a content tab', async () => {
    await fakeBrowser.storage.local.set({ settings: SETTINGS });
    await startWorker();
    const tab = await fakeBrowser.tabs.create({});
    await (fakeBrowser.runtime.onMessage.trigger(
      { type: 'tab-stats', blocked: 1234 },
      { tab },
      () => undefined,
    ) as Promise<unknown[]>);
    // The count and badge are applied asynchronously after the trigger.
    await vi.waitFor(async () => {
      const stored = await fakeBrowser.storage.session.get(null);
      expect(stored[`jevTabBlocked:${tab.id}`]).toBe(1234);
    });
    await vi.waitFor(async () => {
      expect(await fakeBrowser.action.getBadgeText({ tabId: tab.id })).toBe('1k');
    });
  });

  it('ignores tab-stats without a sender tab', async () => {
    await startWorker();
    await (fakeBrowser.runtime.onMessage.trigger(
      { type: 'tab-stats', blocked: 5 },
      {},
      () => undefined,
    ) as Promise<unknown[]>);
    const stored = await fakeBrowser.storage.session.get(null);
    expect(stored).toEqual({});
  });

  it('drops the tab count when the tab closes', async () => {
    await fakeBrowser.storage.local.set({ settings: SETTINGS });
    await startWorker();
    const tab = await fakeBrowser.tabs.create({});
    await (fakeBrowser.runtime.onMessage.trigger(
      { type: 'tab-stats', blocked: 3 },
      { tab },
      () => undefined,
    ) as Promise<unknown[]>);
    await vi.waitFor(async () => {
      const stored = await fakeBrowser.storage.session.get(null);
      expect(stored[`jevTabBlocked:${tab.id}`]).toBe(3);
    });
    await fakeBrowser.tabs.onRemoved.trigger(tab.id!, {
      isWindowClosing: false,
      windowId: tab.windowId,
    });
    await vi.waitFor(async () => {
      const stored = await fakeBrowser.storage.session.get(null);
      expect(stored[`jevTabBlocked:${tab.id}`]).toBeUndefined();
    });
  });
});
