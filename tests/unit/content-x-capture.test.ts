import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalMediaUrl, readArticle } from '../../src/content/dom';
import captured from '../fixtures/x/orca-public-thread/tweets.json';

function article(id: string) {
  const html = readFileSync(`tests/fixtures/x/orca-public-thread/${id}.html`, 'utf8');
  document.body.innerHTML = html;
  const element = document.querySelector<HTMLElement>('article[data-testid="tweet"]');

  if (!element) throw new Error('Captured X article missing');

  return element;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('captured public X thread', () => {
  it('extracts the full note tweet and photo instead of its truncated legacy text or avatar', () => {
    const tweet = captured.tweets[0];

    if (!tweet?.note_tweet || !tweet.legacy.extended_entities)
      throw new Error('Captured note tweet or photo missing');
    const content = readArticle(article(tweet.rest_id));
    const user = tweet.core.user_results.result.core;
    expect(content).toMatchObject({
      id: tweet.rest_id,
      handle: user.screen_name,
      previewUrl: '',
    });
    expect(content?.author).toContain(`@${user.screen_name}`);
    expect(content?.text).not.toBe(tweet.legacy.full_text);
    expect(content?.text.startsWith(tweet.note_tweet.note_tweet_results.result.text)).toBe(true);
    expect(content?.urls).toEqual(
      tweet.legacy.extended_entities.media.map((media) => canonicalMediaUrl(media.media_url_https)),
    );
  });

  it('keeps a link-only reply identified even though X renders its URL as a card', () => {
    const tweet = captured.tweets[1];

    if (!tweet) throw new Error('Captured link-only reply missing');
    const content = readArticle(article(tweet.rest_id));
    expect(content).toMatchObject({
      id: tweet.rest_id,
      handle: tweet.core.user_results.result.core.screen_name,
      text: '',
      urls: [],
    });
  });
});
