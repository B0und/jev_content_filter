// Lifecycle regressions: invalidation removes every trace, late/recycled
// DOM stays consistent, and a failed scan never hides unrelated content.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JevReply } from '../../src/shared/types';
import {
  clearFeed,
  buildTweetArticle,
  iconButton,
  startRuntime,
  stopRuntime,
  until,
  aria,
} from './support';

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

  it('discards a scan result for superseded content and re-scans', async () => {
    const test = await startRuntime();
    const article = buildTweetArticle({ id: '2005', text: 'first text' });
    const first = Promise.withResolvers<JevReply>();
    let calls = 0;
    test.bg.respond = () => {
      calls += 1;
      return calls === 1
        ? first.promise
        : Promise.resolve({ ok: true, sexual: 0.99, ai: 0.01 } as JevReply);
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

    const image = article.querySelector('img') as HTMLImageElement;
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
