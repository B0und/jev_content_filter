// Regression tests for the background service worker. Tests exercise the
// public seams only: registered message handlers via runtime.sendMessage /
// onMessage.trigger, and storage.local / storage.session state. The external
// AI evaluation (gateway model) is mocked; decisions and storage are real.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Effect, Predicate } from 'effect';
import { loadLog } from '../../src/history/log';
import { defaultSettings, type BlockedEntry, type Settings } from '../../src/filtering/types';

const evaluateMock = vi.fn();

const createGatewayMock = vi.fn();

const fetchMock = vi.fn();

// Dynamic import here is intentional: it exercises a module-loading boundary.
// The worker keeps module-level state (settings cache, log queue, tab counts),
// so each test needs a fresh module instance via vi.resetModules(); a static
// import would pin one stateful instance for the whole file.
async function startWorker(): Promise<void> {
  vi.resetModules();
  const { textProviderSdk } = await import('../../src/background/text-provider');
  vi.spyOn(textProviderSdk, 'decide').mockImplementation(evaluateMock);
  vi.spyOn(textProviderSdk, 'createGateway').mockImplementation(createGatewayMock);
  const { startBackground } = await import('../../src/background/runtime');
  startBackground();
}

function okAnswer(probability: number) {
  return { type: 'boolean', probability };
}

function evaluateResult(answers: Record<string, ReturnType<typeof okAnswer>>) {
  return {
    answers,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    warnings: [],
  };
}

const SETTINGS: Settings = {
  authorExceptions: [],
  skipFollowed: false,
  textFilters: defaultSettings().textFilters,
  masterEnabled: true,
  textProvider: 'vercel',
  providerKeys: {
    vercel: 'synthetic-vercel',
    typesafe: 'synthetic-typesafe',
    openrouter: 'synthetic-openrouter',
  },
  textConfigRevision: 0,
  enabled: {
    porn: true,
    hentai: true,
    sexy: true,
    drawings: true,
    aiGenerated: true,
  },
  thresholds: {
    porn: 0.6,
    hentai: 0.6,
    sexy: 0.65,
    drawings: 0.7,
    aiGenerated: 0.65,
  },
};

function blockedEntry(tweetId: string): BlockedEntry {
  return {
    tweetId,
    author: 'author',
    snippet: 'snippet',
    surface: 'timeline',
    ts: Date.now(),
    reasons: [{ key: 'porn', score: 0.9 }],
  };
}

beforeEach(() => {
  fakeBrowser.reset();
  vi.stubGlobal('fetch', fetchMock);
  evaluateMock.mockReset();
  createGatewayMock.mockReset();
  fetchMock.mockReset();
  createGatewayMock.mockImplementation(() => ({ decisionModel: (id: string) => ({ id }) }));
});

describe('background worker lifecycle', () => {
  it('registers synchronously and serves messages after initialization', async () => {
    vi.resetModules();
    const { startBackground } = await import('../../src/background/runtime');

    startBackground();
    expect(fakeBrowser.runtime.onMessage.hasListeners()).toBe(true);
    await expect(fakeBrowser.runtime.sendMessage({ type: 'get-status' })).resolves.toEqual({
      state: 'ok',
      updatedAt: 0,
    });
  });

  it('rejects malformed known background messages', async () => {
    await startWorker();
    await expect(fakeBrowser.runtime.sendMessage({ type: 'jev' })).resolves.toEqual({
      ok: false,
      error: 'Invalid request.',
    });
  });

  it('replies to messages when native storage initialization fails', async () => {
    const failure = new Error('storage unavailable');
    const get = vi.spyOn(fakeBrowser.storage.local, 'get').mockRejectedValue(failure);
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await startWorker();
      await expect(fakeBrowser.runtime.sendMessage({ type: 'get-status' })).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining('load status'),
      });
    } finally {
      get.mockRestore();
      report.mockRestore();
    }
  });
});

describe('jev classification', () => {
  it('fails open on a missing answer object', async () => {
    await fakeBrowser.storage.local.set({ settings: SETTINGS });
    await startWorker();
    evaluateMock.mockResolvedValue(evaluateResult({}));

    const reply = await fakeBrowser.runtime.sendMessage({
      type: 'jev',
      provider: 'vercel',
      revision: 0,
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
        'custom:preset-1': okAnswer(0.1),
      }),
    );
    await expect(
      fakeBrowser.runtime.sendMessage({
        type: 'jev',
        tweetId: 't2',
        text: 'x',
        provider: 'vercel',
        revision: 0,
      }),
    ).resolves.toMatchObject({ ok: true, custom: { 'preset-1': 0.1 } });
    await expect(fakeBrowser.runtime.sendMessage({ type: 'get-status' })).resolves.toMatchObject({
      state: 'ok',
    });
  });
  it('bounds waiting classification requests at 64 while running three providers', async () => {
    await fakeBrowser.storage.local.set({ settings: SETTINGS });
    await startWorker();
    const gate = Promise.withResolvers<{ answers: Record<string, ReturnType<typeof okAnswer>> }>();
    evaluateMock.mockImplementation(() => gate.promise);

    const requests = Array.from({ length: 68 }, (_, index) =>
      fakeBrowser.runtime.sendMessage({
        type: 'jev',
        tweetId: `queued-${index}`,
        text: `queued ${index}`,
        provider: 'vercel',
        revision: 0,
      }),
    );

    let overflowReply: unknown;

    for (const request of requests) {
      void request.then((reply) => {
        if (!reply.ok && reply.error?.includes('queue full')) overflowReply = reply;
      });
    }

    await vi.waitFor(() => expect(overflowReply).toBeDefined());
    gate.resolve(evaluateResult({ 'custom:preset-1': okAnswer(0.1) }));
    const replies = await Promise.all(requests);

    expect(
      replies.filter((reply) => !reply.ok && reply.error?.includes('queue full')),
    ).toHaveLength(1);
    expect(replies.filter((reply) => reply.ok)).toHaveLength(67);
  });
});

describe('classify-image proxy', () => {
  it('rejects non-Twimg hosts without making a request', async () => {
    await startWorker();
    const url = 'https://example.com/image.png';
    await expect(fakeBrowser.runtime.sendMessage({ type: 'classify-image', url })).resolves.toEqual(
      {
        ok: false,
        error: `image proxy: host not allowed for ${url}`,
      },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects images over the proxy size limit', async () => {
    await startWorker();
    fetchMock.mockResolvedValue({
      ok: true,
      blob: async () => ({ size: 8 * 1024 * 1024 + 1 }),
    });

    await expect(
      fakeBrowser.runtime.sendMessage({
        type: 'classify-image',
        url: 'https://pbs.twimg.com/media/image.png',
      }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('image too large') });
  });

  it('reports the image fetch timeout', async () => {
    await startWorker();
    fetchMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));

    await expect(
      fakeBrowser.runtime.sendMessage({
        type: 'classify-image',
        url: 'https://pbs.twimg.com/media/image.png',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('timed out after 10000ms'),
    });
  });
});

describe('gateway status surfacing', () => {
  it('prefixes the HTTP status so auth failures are non-retryable', async () => {
    // Real SDK 401s arrive as GatewayResponseError: statusCode present, but a
    // message that never mentions "401" ("Invalid error response format: …").
    await fakeBrowser.storage.local.set({ settings: SETTINGS });
    await startWorker();

    const error = Object.assign(
      new Error('Invalid error response format: Gateway request failed'),
      { statusCode: 401 },
    );

    evaluateMock.mockRejectedValue(error);
    await expect(
      fakeBrowser.runtime.sendMessage({
        type: 'jev',
        provider: 'vercel',
        revision: 0,
        tweetId: 't1',
        text: 'hi',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('401'),
    });
  });

  it('leaves messages that already carry the status untouched', async () => {
    await fakeBrowser.storage.local.set({ settings: SETTINGS });
    await startWorker();
    const error = Object.assign(new Error('HTTP 403 forbidden'), { statusCode: 403 });
    evaluateMock.mockRejectedValue(error);
    await expect(
      fakeBrowser.runtime.sendMessage({
        type: 'jev',
        provider: 'vercel',
        revision: 0,
        tweetId: 't1',
        text: 'hi',
      }),
    ).resolves.toMatchObject({ ok: false, error: 'HTTP 403 forbidden' });
  });
});

describe('serialized log queue', () => {
  it('serializes concurrent blocked-log appends from different tabs', async () => {
    await startWorker();
    await Promise.all([
      fakeBrowser.runtime.sendMessage({ type: 'log-blocked', entry: blockedEntry('a') }),
      fakeBrowser.runtime.sendMessage({ type: 'log-blocked', entry: blockedEntry('b') }),
    ]);
    const log = await Effect.runPromise(loadLog());
    expect(log.map((entry) => entry.tweetId).sort()).toEqual(['a', 'b']);
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

    await fakeBrowser.runtime.sendMessage({ type: 'clear-log' });
    await append;

    expect(await Effect.runPromise(loadLog())).toEqual([]);

    await fakeBrowser.runtime.sendMessage({ type: 'log-blocked', entry: blockedEntry('c') });
    const log = await Effect.runPromise(loadLog());
    expect(log.map((entry) => entry.tweetId)).toEqual(['c']);
  });

  it('routes clear-errors through the same queue', async () => {
    await startWorker();
    await fakeBrowser.runtime.sendMessage({
      type: 'log-error',
      message: 'boom',
      tweetId: 't1',
    });
    await fakeBrowser.runtime.sendMessage({ type: 'clear-errors' });
    const stored = await fakeBrowser.storage.local.get('scanErrors');
    expect(stored.scanErrors).toEqual([]);
  });
});

describe('per-tab badge counts', () => {
  it('stores and repaints the tab count reported by a content tab', async () => {
    await fakeBrowser.storage.local.set({ settings: SETTINGS });
    await startWorker();
    const tab = await fakeBrowser.tabs.create({});

    const responses = await fakeBrowser.runtime.onMessage.trigger(
      { type: 'tab-stats', blocked: 1234 },
      { tab },
      () => undefined,
    );

    for (const response of responses) if (response) await response;
    // The count and badge are applied asynchronously after the trigger.
    await vi.waitFor(async () => {
      const stored = await fakeBrowser.storage.session.get(null);
      expect(stored[`jevTabBlocked:${tab.id}`]).toBe(1234);
    });
    await vi.waitFor(async () => {
      expect(await fakeBrowser.action.getBadgeText({ tabId: tab.id })).toBe('1k');
    });
  });

  it('rejects senderless tab counts before they reach session storage', async () => {
    await startWorker();
    await expect(
      fakeBrowser.runtime.sendMessage({ type: 'tab-stats', blocked: 5 }),
    ).resolves.toEqual({ ok: false });
    expect(await fakeBrowser.storage.session.get(null)).toEqual({});
  });

  it('drops the tab count when the tab closes', async () => {
    await fakeBrowser.storage.local.set({ settings: SETTINGS });
    await startWorker();
    const tab = await fakeBrowser.tabs.create({});

    const responses = await fakeBrowser.runtime.onMessage.trigger(
      { type: 'tab-stats', blocked: 3 },
      { tab },
      () => undefined,
    );

    for (const response of responses) if (response) await response;
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
  it.each(['navigation', 'removal'] as const)(
    'clears persisted tab counts after worker restart on %s before repaint',
    async (event) => {
      await fakeBrowser.storage.local.set({ settings: SETTINGS });
      const tab = await fakeBrowser.tabs.create({});
      const otherTab = await fakeBrowser.tabs.create({});
      const tabKey = `jevTabBlocked:${tab.id}`;
      const otherKey = `jevTabBlocked:${otherTab.id}`;
      await fakeBrowser.storage.session.set({ [tabKey]: 3, [otherKey]: 5 });
      await fakeBrowser.action.setBadgeText({ tabId: tab.id!, text: '3' });
      await fakeBrowser.action.setBadgeText({ tabId: otherTab.id!, text: 'waiting' });
      // Keep the fresh worker's tab-count map empty until the stale key is cleared.
      const settingsLoad = Promise.withResolvers<{ settings: typeof SETTINGS }>();

      const getSettings = vi
        .spyOn(fakeBrowser.storage.local, 'get')
        .mockImplementationOnce(() => settingsLoad.promise);

      await startWorker();

      if (event === 'navigation') {
        await fakeBrowser.webNavigation.onCommitted.trigger({
          documentId: 'after-restart',
          documentLifecycle: 'active',
          frameId: 0,
          frameType: 'outermost_frame',
          parentFrameId: -1,
          processId: 1,
          tabId: tab.id!,
          timeStamp: 1,
          transitionType: 'link',
          transitionQualifiers: [],
          url: 'https://example.com/',
        });
      } else {
        await fakeBrowser.tabs.onRemoved.trigger(tab.id!, {
          isWindowClosing: false,
          windowId: tab.windowId,
        });
      }

      await vi.waitFor(async () => {
        expect(await fakeBrowser.action.getBadgeText({ tabId: tab.id! })).toBe('');
      });

      settingsLoad.resolve({ settings: SETTINGS });
      await fakeBrowser.runtime.sendMessage({ type: 'get-status' });
      getSettings.mockRestore();
      // Startup's settings write triggers a repaint in the fake browser.
      await vi.waitFor(async () => {
        expect(await fakeBrowser.action.getBadgeText({ tabId: otherTab.id! })).toBe('5');
      });

      const stored = await fakeBrowser.storage.session.get(null);
      expect(stored[tabKey]).toBeUndefined();
      expect(await fakeBrowser.action.getBadgeText({ tabId: tab.id! })).toBe('');
    },
  );
});

describe('configuration transitions', () => {
  it('preserves concurrent field edits from independent settings callers', async () => {
    await fakeBrowser.storage.local.set({ settings: SETTINGS });
    await startWorker();
    await Promise.all([
      fakeBrowser.runtime.sendMessage({
        type: 'update-settings',
        change: { field: 'threshold', category: 'porn', value: 0.2 },
      }),
      fakeBrowser.runtime.sendMessage({
        type: 'update-settings',
        change: { field: 'threshold', category: 'hentai', value: 0.3 },
      }),
      fakeBrowser.runtime.sendMessage({
        type: 'update-settings',
        change: { field: 'masterEnabled', value: false },
      }),
    ]);
    const stored = await fakeBrowser.storage.local.get('settings');
    expect(stored.settings).toMatchObject({
      masterEnabled: false,
      thresholds: { porn: 0.2, hentai: 0.3 },
      providerKeys: SETTINGS.providerKeys,
    });
  });

  it('does not send text with old credentials while an earlier provider change is saving', async () => {
    await fakeBrowser.storage.local.set({ settings: SETTINGS });
    await startWorker();
    evaluateMock.mockResolvedValue(evaluateResult({ 'custom:preset-1': okAnswer(0.1) }));
    await fakeBrowser.runtime.sendMessage({
      type: 'jev',
      tweetId: 'startup',
      text: 'Finish initialization before holding a settings write.',
      provider: 'vercel',
      revision: 0,
    });
    evaluateMock.mockClear();
    const saving = Promise.withResolvers<void>();
    const releaseSave = Promise.withResolvers<void>();
    const originalSet = fakeBrowser.storage.local.set.bind(fakeBrowser.storage.local);
    vi.spyOn(fakeBrowser.storage.local, 'set').mockImplementation(async (entries) => {
      if (
        Predicate.isObject(entries) &&
        Predicate.isObject(entries.settings) &&
        entries.settings.textProvider === 'typesafe'
      ) {
        saving.resolve();
        await releaseSave.promise;
      }

      await originalSet(entries);
    });

    const change = fakeBrowser.runtime.sendMessage({
      type: 'update-settings',
      change: { field: 'textProvider', value: 'typesafe' },
    });

    await saving.promise;

    const reply = fakeBrowser.runtime.sendMessage({
      type: 'jev',
      tweetId: 'pending-provider-change',
      text: 'Do not disclose this post to the previous provider.',
      provider: 'vercel',
      revision: 0,
    });

    // Let already-submitted work run while the earlier storage write stays suspended.
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseSave.resolve();
    await change;
    expect(await reply).toMatchObject({ ok: false, stale: true });
    expect(evaluateMock).not.toHaveBeenCalled();
  });

  it('rejects queued and in-flight old configurations without invoking the new provider for them', async () => {
    await fakeBrowser.storage.local.set({ settings: SETTINGS });
    await startWorker();
    const gate = Promise.withResolvers<{ answers: Record<string, ReturnType<typeof okAnswer>> }>();
    evaluateMock.mockImplementation(() => gate.promise);

    const oldRequests = Array.from({ length: 4 }, (_, index) =>
      fakeBrowser.runtime.sendMessage({
        type: 'jev',
        tweetId: `old-${index}`,
        text: `old ${index}`,
        provider: 'vercel',
        revision: 0,
      }),
    );

    await vi.waitFor(() => expect(evaluateMock).toHaveBeenCalledTimes(3));
    await fakeBrowser.runtime.sendMessage({
      type: 'update-settings',
      change: { field: 'textProvider', value: 'typesafe' },
    });
    gate.resolve(evaluateResult({ 'custom:preset-1': okAnswer(0.1) }));
    const replies = await Promise.all(oldRequests);
    expect(replies.every((reply) => !reply.ok && reply.stale)).toBe(true);
    expect(evaluateMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(fakeBrowser.runtime.sendMessage({ type: 'get-status' })).resolves.toMatchObject({
      state: 'ok',
    });
    evaluateMock.mockResolvedValue(evaluateResult({ 'custom:preset-1': okAnswer(0.9) }));
    await expect(
      fakeBrowser.runtime.sendMessage({
        type: 'jev',
        tweetId: 'new',
        text: 'new text',
        provider: 'typesafe',
        revision: 1,
      }),
    ).resolves.toMatchObject({
      ok: true,
      provider: 'typesafe',
      revision: 1,
      custom: { 'preset-1': 0.9 },
    });
    expect(evaluateMock.mock.calls.at(-1)?.[0].model.provider).toBe('typesafe.decision');
  });

  it('does not send another providers key when switching to an unconfigured provider', async () => {
    await fakeBrowser.storage.local.set({
      settings: {
        ...SETTINGS,
        providerKeys: { vercel: 'synthetic-vercel', typesafe: '', openrouter: '' },
      },
    });
    await startWorker();
    await fakeBrowser.runtime.sendMessage({
      type: 'update-settings',
      change: { field: 'textProvider', value: 'typesafe' },
    });
    await expect(
      fakeBrowser.runtime.sendMessage({
        type: 'jev',
        tweetId: 'unconfigured',
        text: 'text',
        provider: 'typesafe',
        revision: 1,
      }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('no API key') });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createGatewayMock).not.toHaveBeenCalled();
  });
});
