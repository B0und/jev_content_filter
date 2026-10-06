import { Effect } from 'effect';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { textScores } from '../../src/content/classify';
import { settings } from '../../src/content/state';
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

const imageUrl = 'https://pbs.twimg.com/media/text.png?name=small';
const explicitText = 'Как называется этап, когда она не стесняется сосать твой член?';
function configured() {
  const current = baseSettings();
  return baseSettings({
    providerKeys: { vercel: 'test-key', typesafe: '', openrouter: '' },
    enabled: {
      ...current.enabled,
      sexualText: true,
      aiGenerated: false,
      porn: false,
      hentai: false,
      sexy: false,
      drawings: false,
    },
  });
}
beforeEach(() => fakeBrowser.reset());
afterEach(clearFeed);

it('blocks image-only posts through sexual text with all visual categories off', async () => {
  const test = await startRuntime(configured());
  test.bg.ocrRespond = () => ({ ok: true, scores: {}, text: explicitText });
  test.bg.respond = ({ text }) => ({ ok: true, sexual: text.includes(explicitText) ? 0.99 : 0.01 });
  const article = buildTweetArticle({ id: '8100', text: '', images: [imageUrl] });
  test.handle.discover();
  await until(() => article.hasAttribute('data-jev-hidden'), 'image words were not filtered');
  expect(test.bg.jevCalls[0]?.text).toContain(`Text in attached image 1:\n${explicitText}`);
  expect(test.bg.imageCalls).toHaveLength(0);
  expect(test.bg.aiCalls).toHaveLength(0);
  expect(test.bg.ocrCalls[0]?.url).toContain('name=large');
  stopRuntime(test);
});

it('combines caption and all image text, caches size variants, and keeps AI input unchanged', async () => {
  const bg = installFakeBackground();
  settings.current = configured();
  settings.current.enabled.aiGenerated = true;
  bg.ocrRespond = ({ url }) => ({
    ok: true,
    scores: {},
    text: url.includes('second') ? 'Second image words' : explicitText,
  });
  const post = newPostStub('8101');
  const first = await Effect.runPromise(
    textScores(post, 'Дегустация', [imageUrl, 'https://pbs.twimg.com/media/second.png']),
  );
  expect(first.errors).toEqual([]);
  expect(bg.jevCalls[0]?.text).toContain('Tweet text:\nДегустация');
  expect(bg.jevCalls[0]?.text).toContain(explicitText);
  expect(bg.jevCalls[0]?.text).toContain('Text in attached image 2:\nSecond image words');
  expect(bg.aiCalls[0]?.text).toBe('Дегустация');
  await Effect.runPromise(
    textScores(post, 'Дегустация', [
      imageUrl.replace('small', 'thumb'),
      'https://pbs.twimg.com/media/second.png',
    ]),
  );
  expect(bg.ocrCalls).toHaveLength(2);
  expect(bg.jevCalls).toHaveLength(1);
});

it('reports failed extraction while checking the caption and retries without caching the failure', async () => {
  const bg = installFakeBackground();
  settings.current = configured();
  bg.ocrRespond = () => ({ ok: false, error: 'OCR unavailable' });
  const post = newPostStub('8102');
  const first = await Effect.runPromise(textScores(post, 'Caption', [imageUrl]));
  expect(first.scores.sexualText).toBe(0.01);
  expect(first.errors).toContain('Image text: OCR unavailable');
  bg.ocrRespond = () => ({ ok: true, scores: {}, text: explicitText });
  await Effect.runPromise(textScores(post, 'Caption', [imageUrl]));
  expect(bg.ocrCalls).toHaveLength(2);
  expect(bg.jevCalls[1]?.text).toContain(explicitText);
});

it('rechecks sexual text when a new image arrives after a safe caption', async () => {
  const test = await startRuntime(configured());
  test.bg.ocrRespond = () => ({ ok: true, scores: {}, text: explicitText });
  test.bg.respond = ({ text }) => ({ ok: true, sexual: text.includes(explicitText) ? 0.99 : 0.01 });
  const article = buildTweetArticle({ id: '8103', text: 'Дегустация' });
  test.handle.discover();
  await until(() => test.bg.jevCalls.length === 1 && test.handle.report().pending === 0);
  const image = document.createElement('img');
  image.src = imageUrl;
  const photo = document.createElement('div');
  photo.setAttribute('data-testid', 'tweetPhoto');
  photo.append(image);
  article.append(photo);
  test.handle.discover();
  await until(() => article.hasAttribute('data-jev-hidden'), 'late image text was not checked');
  stopRuntime(test);
});

it('checks text in link preview images even without preview text', async () => {
  const test = await startRuntime(configured());
  test.bg.ocrRespond = () => ({ ok: true, scores: {}, text: explicitText });
  test.bg.respond = ({ text }) => ({ ok: true, sexual: text.includes(explicitText) ? 0.99 : 0.01 });
  const article = buildTweetArticle({ id: '8104', text: 'A link' });
  const card = document.createElement('div');
  card.setAttribute('data-testid', 'card.wrapper');
  const image = document.createElement('img');
  image.src = 'https://pbs.twimg.com/card_img/2100961645971333120/example?format=png';
  card.append(image);
  article.append(card);
  test.handle.discover();
  await until(
    () => card.hasAttribute('data-jev-card-hidden'),
    'preview image words were not filtered',
  );
  expect(article.hasAttribute('data-jev-hidden')).toBe(false);
  stopRuntime(test);
});

it('skips OCR when sexual text is disabled and caches successful empty extraction', async () => {
  const bg = installFakeBackground();
  settings.current = configured();
  settings.current.enabled.sexualText = false;
  settings.current.enabled.aiGenerated = true;
  const post = newPostStub('8105');
  await Effect.runPromise(textScores(post, 'Caption', [imageUrl]));
  expect(bg.ocrCalls).toHaveLength(0);
  settings.current.enabled.sexualText = true;
  await Effect.runPromise(textScores(post, 'Caption', [imageUrl]));
  await Effect.runPromise(textScores(post, 'Another caption', [imageUrl]));
  expect(bg.ocrCalls).toHaveLength(1);
  expect(bg.jevCalls.map(({ text }) => text)).toEqual(['Caption', 'Another caption']);
});
