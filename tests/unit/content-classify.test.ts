// Cache and classification regressions: case-sensitive image URL keys,
// cache validation + versioning, NSFW class name mapping, and the retry
// policy (no forever-retries on missing keys).
import {
  nsfwProbe,
  baseSettings,
  buildTweetArticle,
  installFakeBackground,
  newPostStub,
  startRuntime,
  stopRuntime,
  until,
} from './support';
// Support must be imported first: it registers the NSFWJS/TF mocks the
// classify module uses.
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
import { STORAGE_KEYS } from '../../src/shared/types';

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

  it('rejects malformed, out-of-range, and stale-version entries', async () => {
    const key = `${STORAGE_KEYS.scores}:v5:t:abc`;
    await browser.storage.local.set({ [key]: { scores: { porn: 3 }, ts: 1 } });
    expect(await readCache(key)).toBeNull();
    await browser.storage.local.set({ [key]: { scores: { porn: 'high' }, ts: 1 } });
    expect(await readCache(key)).toBeNull();
    await browser.storage.local.set({ [key]: { scores: { madeUpKey: 0.5 }, ts: 1 } });
    expect(await readCache(key)).toBeNull();
    // Versioned keys: anything stored under the previous scheme is ignored.
    const previous = `${STORAGE_KEYS.scores}:v3:t:abc`;
    await browser.storage.local.set({ [previous]: { scores: { porn: 0.9 }, ts: 1 } });
    expect(await readCache(previous)).toBeNull();
    const legacy = `${STORAGE_KEYS.scores}:t:abc`;
    await browser.storage.local.set({ [legacy]: { scores: { porn: 0.9 }, ts: 1 } });
    expect(await readCache(legacy)).toBeNull();
    await browser.storage.local.set({ [key]: { scores: { porn: 0.9 }, ts: 1 } });
    expect(await readCache(key)).toEqual({ scores: { porn: 0.9 }, ts: 1 });
  });

  it('reuses cached image scores without re-running inference', async () => {
    nsfwProbe.predictions = [
      { className: 'Porn', probability: 0.9 },
      { className: 'Drawing', probability: 0.7 },
      { className: 'Neutral', probability: 0.1 },
    ];
    const url = 'https://pbs.twimg.com/media/CacheKey?format=jpg';
    const first = await imageScores([url]);
    expect(first.scores.porn).toBe(0.9);
    expect(first.scores.drawings).toBe(0.7);
    expect(first.scores.hentai).toBeUndefined();
    expect(nsfwProbe.loadCount).toBe(1);

    const second = await imageScores([url]);
    expect(second.scores).toEqual(first.scores);
    expect(nsfwProbe.loadCount).toBe(1); // served entirely from cache
  });

  it('reuses cached text scores regardless of author', async () => {
    settings.current = baseSettings({ gatewayKey: 'test-key' });
    const post = newPostStub('4000');
    const otherPost = newPostStub('4001', 'same text');
    const bg = installFakeBackground();
    bg.respond = () => ({ ok: true, sexual: 0.4, ai: 0.2 });

    const first = await textScores(post, 'same text');
    expect(first).toEqual({ sexualText: 0.4, aiGenerated: 0.2 });
    const second = await textScores(otherPost, 'same text');
    expect(second).toEqual(first);
    expect(bg.jevCalls).toEqual([{ type: 'jev', tweetId: '4000', text: 'same text' }]);
  });
  it('does not reuse text scores after the provider changes', async () => {
    fakeBrowser.reset();
    settings.current = baseSettings({ gatewayKey: 'test-key', textProvider: 'vercel' });
    const post = newPostStub('4010');
    const bg = installFakeBackground();
    bg.respond = () => ({ ok: true, sexual: 0.4, ai: 0.2 });

    await expect(textScores(post, 'provider-sensitive text')).resolves.toEqual({
      sexualText: 0.4,
      aiGenerated: 0.2,
    });
    settings.current = { ...settings.current, textProvider: 'typesafe' };
    bg.respond = () => ({ ok: true, sexual: 0.8, ai: 0.7 });
    await expect(textScores(post, 'provider-sensitive text')).resolves.toEqual({
      sexualText: 0.8,
      aiGenerated: 0.7,
    });
    expect(bg.jevCalls).toHaveLength(2);
  });
});

describe('NSFW class mapping', () => {
  it('maps singular NSFWJS class names onto the drawing category', async () => {
    nsfwProbe.predictions = [
      { className: 'Drawing', probability: 0.55 },
      { className: 'Porn', probability: 0.31 },
      { className: 'Hentai', probability: 0.06 },
      { className: 'Sexy', probability: 0.04 },
      { className: 'Neutral', probability: 0.04 },
    ];
    const result = await imageScores(['https://pbs.twimg.com/media/Singular?format=jpg']);
    expect(result.scores).toEqual({ drawings: 0.55, porn: 0.31, hentai: 0.06, sexy: 0.04 });
  });
});

describe('retry policy', () => {
  it('does not retry missing-key failures', async () => {
    const test = await startRuntime({ gatewayKey: '' });
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
          [`${STORAGE_KEYS.scores}:v5:seed:${index}`]: { scores: { porn: 0.5 }, ts: index },
        }),
      );
    }
    await Promise.all(writes);
    await evictCache(); // limit is 4000: nothing may be dropped
    const stored = await browser.storage.local.get(null);
    const cacheKeys = Object.keys(stored).filter((key) => key.startsWith(STORAGE_KEYS.scores));
    expect(cacheKeys.length).toBe(50);
  });
});
