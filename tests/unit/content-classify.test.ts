// Classification/cache regressions: media URL handling, v7 validation,
// independent text-task caching, and the retry policy for missing keys.
import {
  baseSettings,
  buildTweetArticle,
  clearFeed,
  installFakeBackground,
  newPostStub,
  startRuntime,
  stopRuntime,
  until,
} from './support';
import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  canRetry,
  evictCache,
  imageScores,
  readCache,
  textScores,
} from '../../src/content/classify';
import { canonicalMediaUrl, readArticle } from '../../src/content/dom';
import { settings } from '../../src/content/state';
import { STORAGE_KEYS, type CategoryKey, type Settings } from '../../src/filtering/types';
import { applySettingsChange } from '../../src/filtering/settings';
afterEach(clearFeed);

function textTaskSettings(overrides: Partial<Settings> = {}): Settings {
  const base = baseSettings();
  return baseSettings({
    ...overrides,
    enabled: {
      ...base.enabled,
      porn: false,
      hentai: false,
      sexy: false,
      drawings: false,
      sexualText: true,
      aiGenerated: true,
      ...overrides.enabled,
    },
    providerKeys: {
      vercel: 'test-key',
      typesafe: 'test-key',
      openrouter: 'test-key',
      ...overrides.providerKeys,
    },
  });
}

describe('media URL canonicalization', () => {
  it('collapses the size variants X oscillates between', () => {
    // The exact churn seen on x.com: same image, alternating size params.
    const small = canonicalMediaUrl('https://pbs.twimg.com/media/AbCdEf?format=jpg&name=small');
    const thumb = canonicalMediaUrl('https://pbs.twimg.com/media/AbCdEf?format=jpg&name=120x120');
    const bare = canonicalMediaUrl('https://pbs.twimg.com/media/AbCdEf?format=jpg');
    const legacy = canonicalMediaUrl('https://pbs.twimg.com/media/AbCdEf.jpg:small');
    const extension = canonicalMediaUrl('https://pbs.twimg.com/media/AbCdEf.PNG');
    expect(new Set([small, thumb, bare]).size).toBe(1);
    expect(legacy).toBe(small);
    expect(canonicalMediaUrl('')).toBe('');
    // An extension is folded into format=, so it agrees with the query form.
    expect(extension).toBe('https://pbs.twimg.com/media/AbCdEf?format=png');
  });
  it('keeps card-image URLs fetchable', () => {
    const cardUrl =
      'https://pbs.twimg.com/card_img/2100961645971333120/45zu5XnN?format=jpg&name=small';
    const missingVariants = [
      'https://pbs.twimg.com/card_img/2099822332181176320/hs2JqHCK?format=jpg',
      'https://pbs.twimg.com/card_img/2101117402364960768/zvUxTM5k?format=jpg',
      'https://pbs.twimg.com/card_img/2100819766235762688/5A5Jk0Hw?format=jpg',
    ];
    expect(canonicalMediaUrl(cardUrl)).toBe(cardUrl);
    for (const missingVariant of missingVariants) {
      expect(canonicalMediaUrl(missingVariant)).toBe(`${missingVariant}&name=small`);
    }
  });

  it('keeps media ids case-sensitive and stays fetchable', () => {
    // Case matters: these are different files on pbs.twimg.com.
    expect(canonicalMediaUrl('https://pbs.twimg.com/media/AbCdEf?format=jpg')).not.toBe(
      canonicalMediaUrl('https://pbs.twimg.com/media/abcdef?format=jpg'),
    );
    // Host case is DNS-insensitive.
    expect(canonicalMediaUrl('https://PBS.twimg.com/media/AbCdEf?format=jpg&name=large')).toBe(
      canonicalMediaUrl('https://pbs.twimg.com/media/AbCdEf?format=jpg&name=small'),
    );
    // twimg 404s without format=, so the canonical form must keep it.
    expect(canonicalMediaUrl('https://pbs.twimg.com/media/AbCdEf.jpg:small')).toBe(
      'https://pbs.twimg.com/media/AbCdEf?format=jpg',
    );
  });
});
describe('article media discovery', () => {
  it('collects video thumbnails from images and video posters', () => {
    const thumbnail =
      'https://pbs.twimg.com/ext_tw_video_thumb/1234567890/pu/img/thumb.jpg?name=small';
    const poster =
      'https://pbs.twimg.com/ext_tw_video_thumb/9876543210/pu/img/poster.jpg?name=small';
    const article = buildTweetArticle({ id: '4100', images: [thumbnail] });
    const video = document.createElement('video');
    video.setAttribute('poster', poster);
    article.append(video);

    expect(readArticle(article)?.urls).toEqual([
      canonicalMediaUrl(thumbnail),
      canonicalMediaUrl(poster),
    ]);
    article.remove();
  });
});

describe('score cache', () => {
  afterEach(async () => {
    await browser.storage.local.clear();
  });

  it('rejects malformed entries and never reads cache versions before v7', async () => {
    const key = `${STORAGE_KEYS.scores}:v7:t:abc`;
    await browser.storage.local.set({ [key]: { scores: { porn: 3 }, ts: 1 } });
    expect(await Effect.runPromise(readCache(key))).toBeNull();
    await browser.storage.local.set({ [key]: { scores: { porn: 'high' }, ts: 1 } });
    expect(await Effect.runPromise(readCache(key))).toBeNull();
    await browser.storage.local.set({ [key]: { scores: { madeUpKey: 0.5 }, ts: 1 } });
    expect(await Effect.runPromise(readCache(key))).toBeNull();
    const previous = `${STORAGE_KEYS.scores}:v6:t:abc`;
    await browser.storage.local.set({ [previous]: { scores: { porn: 0.9 }, ts: 1 } });
    expect(await Effect.runPromise(readCache(previous))).toBeNull();
    const legacy = `${STORAGE_KEYS.scores}:t:abc`;
    await browser.storage.local.set({ [legacy]: { scores: { porn: 0.9 }, ts: 1 } });
    expect(await Effect.runPromise(readCache(legacy))).toBeNull();
    await browser.storage.local.set({ [key]: { scores: { porn: 0.9 }, ts: 1 } });
    expect(await Effect.runPromise(readCache(key))).toEqual({ scores: { porn: 0.9 }, ts: 1 });
  });

  it('reuses image category scores from the browser-message classifier', async () => {
    fakeBrowser.reset();
    settings.current = baseSettings({
      enabled: {
        ...baseSettings().enabled,
        sexualText: false,
        aiGenerated: false,
      },
    });
    const scores: Partial<Record<CategoryKey, number>> = { porn: 0.9, drawings: 0.7 };
    const bg = installFakeBackground();
    bg.imageRespond = () => ({ ok: true, scores });
    const url = 'https://pbs.twimg.com/media/CacheKey?format=jpg';

    const first = await Effect.runPromise(imageScores([url]));
    expect(first).toEqual({ scores, errors: [] });
    expect(bg.imageCalls).toHaveLength(1);

    const second = await Effect.runPromise(imageScores([url]));
    expect(second).toEqual(first);
    expect(bg.imageCalls).toHaveLength(1);
  });

  it('ignores legacy model scores after the anime pipeline is installed', async () => {
    fakeBrowser.reset();
    settings.current = baseSettings();
    const bg = installFakeBackground();
    bg.imageRespond = () => ({ ok: true, scores: { sexy: 0.93 } });
    const url = 'https://pbs.twimg.com/media/CacheKey?format=jpg';
    await Effect.runPromise(imageScores([url]));
    const stored = await browser.storage.local.get(null);
    const entry = Object.entries(stored).find(([key]) => key.includes(':i:'))!;
    const suffix = entry[0].slice(entry[0].lastIndexOf(':'));
    await browser.storage.local.clear();
    await browser.storage.local.set({
      [`${STORAGE_KEYS.scores}:v7:i:nsfwjs/mobilenet_v2:d55a54c51f14380670064cc129b2ea51029c5e46${suffix}`]:
        { scores: { sexy: 0.001 }, ts: Date.now() },
    });
    expect(await Effect.runPromise(imageScores([url]))).toEqual({
      scores: { sexy: 0.93 },
      errors: [],
    });
    expect(bg.imageCalls).toHaveLength(2);
  });

  it('preserves partial scores and retries an incomplete anime check without caching it', async () => {
    fakeBrowser.reset();
    settings.current = baseSettings();
    const bg = installFakeBackground();
    bg.imageRespond = () => ({
      ok: true,
      scores: { porn: 0.9 },
      warning: 'Anime sensitivity check failed. Retry to complete it.',
    });
    const url = 'https://pbs.twimg.com/media/Partial?format=jpg';
    expect(await Effect.runPromise(imageScores([url]))).toEqual({
      scores: { porn: 0.9 },
      errors: ['Image 1: Anime sensitivity check failed. Retry to complete it.'],
    });
    bg.imageRespond = () => ({ ok: true, scores: { porn: 0.9, sexy: 0.93 } });
    const recovered = await Effect.runPromise(imageScores([url]));
    expect(recovered).toEqual({ scores: { porn: 0.9, sexy: 0.93 }, errors: [] });
    expect(await Effect.runPromise(imageScores([url]))).toEqual(recovered);
    expect(bg.imageCalls).toHaveLength(2);
  });

  it('reuses cached sexual and local-AI scores across posts with identical text', async () => {
    fakeBrowser.reset();
    settings.current = textTaskSettings();
    const post = newPostStub('4000');
    const otherPost = newPostStub('4001', 'same text');
    const bg = installFakeBackground();
    bg.respond = () => ({ ok: true, sexual: 0.4 });
    bg.aiRespond = () => ({ ok: true, scores: { aiGenerated: 0.2 } });

    const first = await Effect.runPromise(textScores(post, 'same text'));
    expect(first).toEqual({ scores: { sexualText: 0.4, aiGenerated: 0.2 }, errors: [] });
    const second = await Effect.runPromise(textScores(otherPost, 'same text'));
    expect(second).toEqual(first);
    expect(bg.jevCalls).toHaveLength(1);
    expect(bg.aiCalls).toHaveLength(1);
  });

  it('re-evaluates sexual text for a new provider while reusing local AI text', async () => {
    fakeBrowser.reset();
    settings.current = textTaskSettings({ textProvider: 'vercel' });
    const post = newPostStub('4010');
    const bg = installFakeBackground();
    bg.respond = () => ({ ok: true, sexual: 0.4 });
    bg.aiRespond = () => ({ ok: true, scores: { aiGenerated: 0.2 } });

    await expect(Effect.runPromise(textScores(post, 'provider-sensitive text'))).resolves.toEqual({
      scores: { sexualText: 0.4, aiGenerated: 0.2 },
      errors: [],
    });
    settings.current = { ...settings.current, textProvider: 'typesafe' };
    bg.respond = () => ({ ok: true, sexual: 0.8 });
    bg.aiRespond = () => ({ ok: true, scores: { aiGenerated: 0.95 } });
    await expect(Effect.runPromise(textScores(post, 'provider-sensitive text'))).resolves.toEqual({
      scores: { sexualText: 0.8, aiGenerated: 0.2 },
      errors: [],
    });
    expect(bg.jevCalls).toHaveLength(2);
    expect(bg.aiCalls).toHaveLength(1);
  });

  it('rejects stale text results without discarding a valid local-AI cache entry', async () => {
    fakeBrowser.reset();
    settings.current = textTaskSettings({
      providerKeys: {
        vercel: 'synthetic-vercel',
        typesafe: 'synthetic-typesafe',
        openrouter: '',
      },
    });
    const post = newPostStub('4020');
    const bg = installFakeBackground();
    const gate = Promise.withResolvers<{ ok: true; sexual: number }>();
    const jevStarted = Promise.withResolvers<void>();
    const aiStarted = Promise.withResolvers<void>();
    bg.respond = () => {
      jevStarted.resolve();
      return gate.promise;
    };
    bg.aiRespond = () => {
      aiStarted.resolve();
      return { ok: true, scores: { aiGenerated: 0.2 } };
    };
    const old = Effect.runPromise(textScores(post, 'configuration-race'));
    const rejected = expect(old).rejects.toThrow('Text configuration changed');
    await Promise.all([jevStarted.promise, aiStarted.promise]);
    settings.current = applySettingsChange(settings.current, {
      field: 'textProvider',
      value: 'typesafe',
    });
    gate.resolve({ ok: true, sexual: 0.1 });
    await rejected;

    const stored = await browser.storage.local.get(null);
    const cachedScores = Object.values(stored).flatMap((value) => {
      if (typeof value !== 'object' || value === null || !('scores' in value)) return [];
      const scores = value.scores;
      return typeof scores === 'object' && scores !== null ? [scores] : [];
    });
    expect(cachedScores).toEqual([{ aiGenerated: 0.2 }]);

    bg.respond = () => ({ ok: true, sexual: 0.9 });
    bg.aiRespond = () => ({ ok: true, scores: { aiGenerated: 0.95 } });
    await expect(Effect.runPromise(textScores(post, 'configuration-race'))).resolves.toEqual({
      scores: { sexualText: 0.9, aiGenerated: 0.2 },
      errors: [],
    });
    expect(bg.jevCalls).toHaveLength(2);
    expect(bg.aiCalls).toHaveLength(1);
  });
});
describe('runtime text task behavior', () => {
  it('hides an AI-classified post without an API key when sexual text is disabled', async () => {
    const configured = textTaskSettings({
      providerKeys: { vercel: '', typesafe: '', openrouter: '' },
    });
    configured.enabled.sexualText = false;
    configured.thresholds.aiGenerated = 0.65;
    const test = await startRuntime(configured);
    try {
      test.bg.aiRespond = () => ({ ok: true, scores: { aiGenerated: 0.93 } });
      const article = buildTweetArticle({
        id: '4110',
        text: 'A generated post that has an above-threshold local score.',
      });
      test.handle.discover();

      await until(
        () => article.hasAttribute('data-jev-hidden') && test.handle.report().pending === 0,
        'local AI score did not hide the post',
      );
      expect(test.handle.report()).toMatchObject({ blocked: 1, failed: 0, errors: [] });
      expect(test.bg.jevCalls).toHaveLength(0);
      expect(test.bg.aiCalls).toHaveLength(1);
    } finally {
      stopRuntime(test);
    }
  });

  it('keeps a successful local-AI block when the sexual-text task fails', async () => {
    const configured = textTaskSettings();
    configured.thresholds.aiGenerated = 0.65;
    const test = await startRuntime(configured);
    try {
      test.bg.respond = () => ({ ok: false, error: 'HTTP 401 unauthorized' });
      test.bg.aiRespond = () => ({ ok: true, scores: { aiGenerated: 0.91 } });
      const article = buildTweetArticle({
        id: '4111',
        text: 'A generated post whose remote sexual-text check is unavailable.',
      });
      test.handle.discover();

      await until(
        () =>
          article.hasAttribute('data-jev-hidden') &&
          test.handle.report().pending === 0 &&
          test.handle.report().failed === 1,
        'successful local score did not survive the failed remote task',
      );
      expect(test.handle.report()).toMatchObject({
        blocked: 1,
        failed: 1,
        retrying: 0,
        errors: ['Text: HTTP 401 unauthorized'],
      });
      expect(test.bg.aiCalls).toHaveLength(1);
      expect(test.bg.jevCalls).toHaveLength(1);
    } finally {
      stopRuntime(test);
    }
  });
});

describe('retry policy', () => {
  it('does not retry missing-key failures', async () => {
    const configured = textTaskSettings({
      providerKeys: { vercel: '', typesafe: '', openrouter: '' },
    });
    configured.enabled.aiGenerated = false;
    const test = await startRuntime(configured);
    const article = buildTweetArticle({ id: '4001', text: 'something to check' });
    test.handle.discover();

    await until(
      () => test.bg.loggedErrors.some((text) => text.includes('API key')),
      'missing key not surfaced',
    );
    expect(article.querySelector<HTMLElement>('[data-jev-host]')?.isConnected).toBe(true);
    expect(test.handle.report().retrying).toBe(0);
    expect(article.hasAttribute('data-jev-hidden')).toBe(false);
    // More passes must not turn it into a retry loop.
    test.handle.discover();
    expect(test.handle.report().retrying).toBe(0);
    expect(canRetry('Add an API key in the extension popup to check text.')).toBe(false);
    expect(canRetry('HTTP 401 unauthorized')).toBe(false);
    expect(canRetry('Server 500')).toBe(true);

    stopRuntime(test);
  });

  it('keeps the oldest entries when evicting under the limit', async () => {
    const writes: Promise<unknown>[] = [];
    for (let index = 0; index < 50; index++) {
      writes.push(
        browser.storage.local.set({
          [`${STORAGE_KEYS.scores}:v7:seed:${index}`]: { scores: { porn: 0.5 }, ts: index },
        }),
      );
    }
    await Promise.all(writes);
    await Effect.runPromise(evictCache()); // limit is 4000: nothing may be dropped
    const stored = await browser.storage.local.get(null);
    const cacheKeys = Object.keys(stored).filter((key) => key.startsWith(STORAGE_KEYS.scores));
    expect(cacheKeys.length).toBe(50);
  });
});

it('checks custom rules with built-in text checks off and invalidates their cache after edits', async () => {
  fakeBrowser.reset();
  const filter = {
    id: 'garden',
    name: 'Gardening',
    instructions: 'Posts about the garden',
    enabled: true,
    threshold: 0.65,
  };
  const base = textTaskSettings();
  settings.current = textTaskSettings({
    textFilters: [filter],
    enabled: { ...base.enabled, sexualText: false, aiGenerated: false },
  });
  const bg = installFakeBackground();
  bg.respond = () => ({ ok: true, sexual: 0.01, custom: { garden: 0.9 } });
  const post = newPostStub('custom-cache');
  const first = await Effect.runPromise(textScores(post, 'same text'));
  expect(first.scores['custom:garden']).toBe(0.9);
  expect(await Effect.runPromise(textScores(post, 'same text'))).toEqual(first);
  expect(bg.jevCalls).toHaveLength(1);
  settings.current = applySettingsChange(settings.current, {
    field: 'textFilter',
    value: { ...filter, instructions: 'Posts about a different topic' },
  });
  bg.respond = () => ({ ok: true, sexual: 0.01, custom: { garden: 0.1 } });
  expect((await Effect.runPromise(textScores(post, 'same text'))).scores['custom:garden']).toBe(
    0.1,
  );
  expect(bg.jevCalls).toHaveLength(2);
  settings.current = applySettingsChange(settings.current, {
    field: 'textFilter',
    value: { ...filter, enabled: false },
  });
  expect(await Effect.runPromise(textScores(post, 'same text'))).toEqual({
    scores: {},
    errors: [],
  });
  expect(bg.jevCalls).toHaveLength(2);
});
