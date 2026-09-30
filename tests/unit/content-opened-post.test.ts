// Opening a post directly — its permalink, or the detail view X mounts over
// the timeline — never filters that post. The rest of the page keeps the
// normal policy, and the exemption follows the live path, not the page the
// document was first loaded with.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  aria,
  buildTweetArticle,
  clearFeed,
  iconButton,
  startRuntime,
  stopRuntime,
  until,
} from './support';

const explicit = () => ({ ok: true as const, sexual: 0.9, ai: 0.01 });

describe('opened post', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearFeed();
    window.history.replaceState({}, '', '/');
  });

  it('filters neighbors but not the post the URL addresses', async () => {
    const test = await startRuntime();
    test.bg.respond = explicit;
    const opened = buildTweetArticle({ id: '2020', text: 'explicit opened post' });
    const neighbor = buildTweetArticle({ id: '2021', text: 'explicit timeline post' });
    window.history.replaceState({}, '', '/user/status/2020');
    test.handle.discover();
    await until(
      () => neighbor.hasAttribute('data-jev-hidden') && test.handle.report().pending === 0,
      'neighbor was not filtered',
    );
    expect(opened.hasAttribute('data-jev-hidden')).toBe(false);
    expect(aria(iconButton(opened))).toBe('Opened post');
    expect(test.handle.report().blocked).toBe(1);
    expect(test.handle.report().pageBlocked).toBe(1);
    // Nothing was hidden for the opened post, so the log has no row to unblock.
    await until(() => test.bg.blockedEntries.length === 1, 'neighbor was not logged');
    expect(test.bg.blockedEntries.map((entry) => entry.tweetId)).toEqual(['2021']);

    // A detail view opened over this page moves the URL: the exemption follows
    // it, and the post left behind goes back to being filtered.
    window.history.replaceState({}, '', '/user/status/2021');
    test.handle.discover();
    await until(
      () => opened.hasAttribute('data-jev-hidden') && !neighbor.hasAttribute('data-jev-hidden'),
      'exemption did not follow the URL',
    );
    expect(aria(iconButton(neighbor))).toBe('Opened post');
    expect(test.handle.report().blocked).toBe(1);
    expect(test.handle.report().pageBlocked).toBe(2);
    await until(() => test.bg.blockedEntries.length === 2);
    expect(test.bg.blockedEntries.map((entry) => entry.tweetId)).toEqual(['2021', '2020']);
    stopRuntime(test);
  });

  it('leaves the opened post and its link preview alone', async () => {
    const test = await startRuntime();
    test.bg.respond = explicit;
    const article = buildTweetArticle({
      id: '2022',
      text: 'an ordinary link',
      previewText: 'explicit preview text',
    });
    const card = article.querySelector<HTMLElement>('[data-testid="card.wrapper"]');
    if (!card) throw new Error('card wrapper missing');
    window.history.replaceState({}, '', '/user/status/2022');
    test.handle.discover();
    await until(() => test.handle.report().pending === 0 && test.bg.jevCalls.length === 2);
    expect(article.hasAttribute('data-jev-hidden')).toBe(false);
    expect(card.hasAttribute('data-jev-card-hidden')).toBe(false);
    expect(test.bg.blockedEntries).toEqual([]);
    expect(test.handle.report().blocked).toBe(0);
    expect(test.handle.report().pageBlocked).toBe(0);
    stopRuntime(test);
  });
});
