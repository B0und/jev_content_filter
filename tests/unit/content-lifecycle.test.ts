// Lifecycle regressions: invalidation removes every trace, late/recycled
// DOM stays consistent, and a failed scan never hides unrelated content.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  aria,
  buildTweetArticle,
  browser,
  clearFeed,
  iconButton,
  nsfwProbe,
  startRuntime,
  stopRuntime,
  until,
} from './support';
import { STORAGE_KEYS } from '../../src/shared/types';

type FakeJevReply = { ok: true; sexual: number; ai: number } | { ok: false; error: string };

describe('content lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearFeed();
  });

  it('invalidation unhides posts, removes UI and stops reacting to storage', async () => {
    const test = await startRuntime();
    test.bg.respond = () => ({ ok: true, sexual: 0.9, ai: 0.01 });
    const article = buildTweetArticle({ id: '2001', text: 'explicit text' });
    test.handle.discover();
    await until(() => article.hasAttribute('data-jev-hidden'));

    stopRuntime(test);
    await until(
      () => !article.hasAttribute('data-jev-hidden'),
      'invalidation left the post hidden',
    );
    await until(
      () => article.querySelector('[data-jev-host]') == null,
      'invalidation left the icon host',
    );
    await until(
      () => document.querySelector('[data-jev-style]') == null,
      'invalidation left the global style',
    );
    expect(document.querySelector('[data-jev-panel]')).toBeNull();
    expect(test.handle.report()).toEqual({
      analyzed: 0,
      blocked: 0,
      pageAnalyzed: 0,
      pageBlocked: 0,
      pending: 0,
      failed: 0,
      retrying: 0,
      lastScannedAt: 0,
      errors: [],
    });

    // Storage changes after invalidation must not resurrect anything.
    if (!article.isConnected) document.body.append(article);
    test.handle.discover(); // no-op: the runtime is dead
    await until(
      () => document.querySelectorAll('[data-jev-host]').length === 0,
      'UI resurrected after invalidation',
    );
    expect(article.hasAttribute('data-jev-hidden')).toBe(false);
  });

  it('reattached DOM gets a fresh binding and keeps its classified state', async () => {
    const test = await startRuntime();
    test.bg.respond = () => ({ ok: true, sexual: 0.9, ai: 0.01 });
    const article = buildTweetArticle({ id: '2002', text: 'explicit text' });
    test.handle.discover();
    await until(() => article.hasAttribute('data-jev-hidden'), 'post not classified');

    article.remove();
    test.handle.discover();
    await until(
      () => document.querySelectorAll('[data-jev-host]').length === 0,
      'host stayed for detached article',
    );
    expect(test.handle.report().blocked).toBe(0);

    document.body.append(article); // late DOM: X re-inserts the same node
    test.handle.discover();
    await until(
      () => article.hasAttribute('data-jev-hidden'),
      'reattached post not re-hidden from retained scores',
    );
    expect(aria(iconButton(article))).toContain('Blocked');

    stopRuntime(test);
  });

  it('observes a video poster assigned late and replaced', async () => {
    const test = await startRuntime();
    nsfwProbe.predictions = [{ className: 'Porn', probability: 0.99 }];
    const article = buildTweetArticle({ id: '2010' });
    const card = document.createElement('div');
    card.setAttribute('data-testid', 'card.wrapper');
    const video = document.createElement('video');
    video.setAttribute('poster', '');
    card.append(video);
    article.append(card);
    test.handle.discover();

    video.setAttribute('poster', 'https://pbs.twimg.com/ext_tw_video_thumb/2010/pu/img/late.jpg');
    await until(
      () => card.hasAttribute('data-jev-card-hidden') && test.handle.report().blocked === 1,
      'late poster was not classified',
    );

    nsfwProbe.predictions = [{ className: 'Porn', probability: 0.01 }];
    video.setAttribute(
      'poster',
      'https://pbs.twimg.com/ext_tw_video_thumb/2010/pu/img/replaced.jpg',
    );
    await until(
      () =>
        !card.hasAttribute('data-jev-card-hidden') &&
        test.handle.report().blocked === 0 &&
        aria(iconButton(article)).includes('Allowed'),
      'replacement poster did not replace the old preview decision',
    );
    stopRuntime(test);
  });

  it('counts duplicate bindings once and follows recycled articles through detach and return', async () => {
    const test = await startRuntime();
    test.bg.respond = () => ({ ok: true, sexual: 0.99, ai: 0.01 });
    const first = buildTweetArticle({ id: '2011', text: 'shared explicit text' });
    const second = buildTweetArticle({ id: '2011', text: 'shared explicit text' });
    test.handle.discover();
    await until(
      () =>
        first.hasAttribute('data-jev-hidden') &&
        second.hasAttribute('data-jev-hidden') &&
        test.handle.report().blocked === 1,
      'duplicate articles did not share one visible report entry',
    );
    expect(test.handle.report().analyzed).toBe(1);
    expect(test.bg.jevCalls).toHaveLength(1);

    first.remove();
    expect(test.handle.report().blocked).toBe(1);
    test.handle.discover();
    second.remove();
    expect(test.handle.report().blocked).toBe(0);
    test.handle.discover();
    expect(test.handle.report().pageAnalyzed).toBe(1);
    expect(test.handle.report().pageBlocked).toBe(1);

    document.body.append(first);
    test.handle.discover();
    await until(
      () => first.hasAttribute('data-jev-hidden') && aria(iconButton(first)).includes('Blocked'),
      'retained post did not return',
    );
    expect(test.bg.jevCalls).toHaveLength(1);

    const statusLink = first.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
    const textNode = first.querySelector('[data-testid="tweetText"]');
    if (!statusLink || !textNode) throw new Error('tweet identity nodes missing');
    statusLink.setAttribute('href', '/user/status/2012');
    textNode.textContent = 'recycled explicit text';
    test.handle.discover();
    await until(
      () =>
        test.bg.jevCalls.length === 2 &&
        first.hasAttribute('data-jev-hidden') &&
        aria(iconButton(first)).includes('Blocked'),
      'recycled article did not bind and classify its new post',
    );
    expect(test.handle.report().blocked).toBe(1);
    expect(test.handle.report().pageBlocked).toBe(2);

    statusLink.setAttribute('href', '/user/status/2011');
    textNode.textContent = 'shared explicit text';
    test.handle.discover();
    expect(test.handle.report().blocked).toBe(1);
    expect(first.hasAttribute('data-jev-hidden')).toBe(true);
    expect(test.handle.report().pageAnalyzed).toBe(2);
    expect(test.handle.report().pageBlocked).toBe(2);
    expect(test.bg.jevCalls).toHaveLength(2);
    stopRuntime(test);
  });

  it('discards a scan result for superseded content and re-scans', async () => {
    const test = await startRuntime();
    const article = buildTweetArticle({ id: '2005', text: 'first text' });
    const first = Promise.withResolvers<FakeJevReply>();
    let calls = 0;
    test.bg.respond = () => {
      calls += 1;
      return calls === 1 ? first.promise : Promise.resolve({ ok: true, sexual: 0.99, ai: 0.01 });
    };
    test.handle.discover();
    await until(() => aria(iconButton(article)).includes('Scanning'), 'scan did not start');

    // X replaces the text before the in-flight reply lands: version bump.
    const textNode = article.querySelector('[data-testid="tweetText"]');
    if (!textNode) throw new Error('tweet text missing');
    textNode.textContent = 'replaced text';
    test.handle.discover();

    // The in-flight reply is for the superseded text — it must not settle
    // the post; the re-scan answers with its own blocking reply.
    first.resolve({ ok: true, sexual: 0.01, ai: 0.01 });
    await until(
      () => article.hasAttribute('data-jev-hidden'),
      'stale result superseded by a blocking re-scan failed',
    );
    expect(calls).toBe(2);
    expect(aria(iconButton(article))).toContain('Blocked');

    stopRuntime(test);
  });

  it('keeps attached posts beyond the detached retention limit and retains recent returns', async () => {
    const test = await startRuntime();
    test.bg.respond = () => ({ ok: true, sexual: 0.99, ai: 0.01 });
    const oldest = buildTweetArticle({ id: '2020', text: 'oldest retained marker' });
    const detached = Array.from({ length: 200 }, (_, index) =>
      buildTweetArticle({ id: String(3000 + index) }),
    );
    const recent = buildTweetArticle({ id: '4000', text: 'recent retained marker' });
    test.handle.discover();
    await until(
      () => oldest.hasAttribute('data-jev-hidden') && recent.hasAttribute('data-jev-hidden'),
      'marker posts were not classified',
    );
    expect(test.handle.report().blocked).toBe(2);
    expect(test.bg.jevCalls).toHaveLength(2);

    oldest.remove();
    for (const article of detached) article.remove();
    test.handle.discover();
    expect(test.handle.report().blocked).toBe(1);
    // Remove the persistent score cache so a retained Post and an evicted
    // Post have observably different work on return.
    const stored = await browser.storage.local.get(null);
    await browser.storage.local.remove(
      Object.keys(stored).filter((key) => key.startsWith(STORAGE_KEYS.scores)),
    );

    recent.remove();
    test.handle.discover();
    expect(test.handle.report().blocked).toBe(0);
    document.body.append(recent);
    test.handle.discover();
    await until(
      () => recent.hasAttribute('data-jev-hidden') && aria(iconButton(recent)).includes('Blocked'),
      'recent detached post did not return',
    );
    expect(test.bg.jevCalls).toHaveLength(2);

    document.body.append(oldest);
    test.handle.discover();
    await until(
      () =>
        test.bg.jevCalls.length === 3 &&
        oldest.hasAttribute('data-jev-hidden') &&
        aria(iconButton(oldest)).includes('Blocked'),
      'oldest detached post was not evicted and rescanned on return',
    );
    expect(test.handle.report().blocked).toBe(2);
    expect(test.handle.report().pageBlocked).toBe(2);
    stopRuntime(test);
  });

  it('discards an in-flight result when detached-post eviction replaces the post', async () => {
    const test = await startRuntime();
    const first = Promise.withResolvers<FakeJevReply>();
    let calls = 0;
    test.bg.respond = () => {
      calls += 1;
      return calls === 1 ? first.promise : Promise.resolve({ ok: true, sexual: 0.99, ai: 0.01 });
    };
    const article = buildTweetArticle({ id: '2021', text: 'pending eviction marker' });
    test.handle.discover();
    await until(() => aria(iconButton(article)).includes('Scanning'), 'scan did not start');

    const detached = Array.from({ length: 201 }, (_, index) =>
      buildTweetArticle({ id: String(5000 + index) }),
    );
    test.handle.discover();
    article.remove();
    for (const item of detached) item.remove();
    test.handle.discover();

    document.body.append(article);
    test.handle.discover();
    await until(
      () =>
        calls === 2 &&
        article.hasAttribute('data-jev-hidden') &&
        aria(iconButton(article)).includes('Blocked'),
      'evicted post did not receive a fresh scan on return',
    );
    first.resolve({ ok: true, sexual: 0.01, ai: 0.01 });
    await Promise.resolve();

    expect(article.hasAttribute('data-jev-hidden')).toBe(true);
    expect(test.handle.report().blocked).toBe(1);
    expect(calls).toBe(2);
    stopRuntime(test);
  });

  it('ignores X oscillating media srcs between size variants', async () => {
    // X rewrites each media <img src> between size params while the feed
    // scrolls (observed: ~127 swaps per image in 3s). Those swaps name the
    // same image, so they must never invalidate scores, unhide a blocked
    // post, or trigger a re-scan — that is the visible flapping bug.
    const test = await startRuntime();
    test.bg.respond = () => ({ ok: true, sexual: 0.99, ai: 0.01 });
    const article = buildTweetArticle({
      id: '2006',
      text: 'text with media',
      images: ['https://pbs.twimg.com/media/ChurnCase?format=jpg&name=small'],
    });
    test.handle.discover();
    await until(() => article.hasAttribute('data-jev-hidden'), 'post not blocked');

    const image = article.querySelector('img');
    if (!(image instanceof HTMLImageElement)) throw new Error('article image missing');
    const callsAfterScan = test.bg.jevCalls.length;
    // Simulate X's size-param oscillation: identical media id, different name.
    for (let index = 0; index < 40; index++) {
      image.src = `https://pbs.twimg.com/media/ChurnCase?format=jpg&name=${
        index % 2 === 0 ? '120x120' : 'small'
      }`;
      test.handle.discover();
    }

    // Nothing may flip: the post stays hidden, no new gateway calls, no re-scan.
    expect(article.hasAttribute('data-jev-hidden')).toBe(true);
    expect(aria(iconButton(article))).toContain('Blocked');
    expect(test.bg.jevCalls.length).toBe(callsAfterScan);

    stopRuntime(test);
  });

  it('a failed scan leaves the post visible and other posts untouched', async () => {
    const test = await startRuntime();
    const failing = buildTweetArticle({ id: '2003', text: 'maybe explicit text' });
    const healthy = buildTweetArticle({ id: '2004', text: 'perfectly normal text' });
    test.bg.respond = (request) =>
      request.tweetId === '2003'
        ? { ok: false, error: 'Server 500 blew up' }
        : { ok: true, sexual: 0.01, ai: 0.01 };
    test.handle.discover();

    await until(
      () =>
        aria(iconButton(failing)).includes('Not fully checked') ||
        aria(iconButton(failing)).includes('Retry'),
      'failed post state not surfaced',
    );
    await until(
      () => test.bg.loggedErrors.some((text) => text.includes('Server 500')),
      'scan error not logged',
    );
    expect(failing.hasAttribute('data-jev-hidden')).toBe(false);
    expect(healthy.hasAttribute('data-jev-hidden')).toBe(false);
    expect(aria(iconButton(healthy))).toContain('Allowed');
    expect(test.handle.report().failed).toBe(1);

    stopRuntime(test);
  });
});
