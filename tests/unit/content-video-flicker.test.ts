import {
  baseSettings,
  buildTweetArticle,
  clearFeed,
  startRuntime,
  stopRuntime,
  until,
} from './support';
import { afterEach, expect, it } from 'vitest';

afterEach(clearFeed);

it('keeps a blocked video stable when X changes only its thumbnail size', async () => {
  const configured = baseSettings();
  configured.enabled = {
    ...configured.enabled,
    porn: true,
    hentai: false,
    sexy: false,
    drawings: false,

    aiGenerated: false,
  };
  const runtime = await startRuntime({ enabled: configured.enabled });
  runtime.bg.imageRespond = () => ({ ok: true, scores: { porn: 0.99 } });
  const article = buildTweetArticle({
    id: '2105016474192515573',
    handle: 'personakoto',
    text: "Genuinely the best purchase of my life, I finally get to know what it's like for Makoto to listen to music :D",
  });
  const video = document.createElement('video');
  const thumbnail =
    'https://pbs.twimg.com/amplify_video_thumb/2105016301022289920/img/wOMgFoWLEu-N1SAL?format=webp&name=';
  video.setAttribute('poster', `${thumbnail}medium`);
  article.append(video);
  runtime.handle.discover();
  await until(() => article.hasAttribute('data-jev-hidden'));

  let unhideTransitions = 0;
  try {
    for (let index = 0; index < 12; index++) {
      video.setAttribute('poster', `${thumbnail}${index % 2 ? 'medium' : 'small'}`);
      runtime.handle.discover();
      if (!article.hasAttribute('data-jev-hidden')) unhideTransitions++;
      await until(() => runtime.handle.report().pending === 0);
    }
    expect(
      unhideTransitions,
      'size-only video thumbnail changes must not repeatedly unhide a classified post',
    ).toBe(0);
    expect(runtime.handle.report().blocked).toBe(1);
  } finally {
    stopRuntime(runtime);
  }
});

it('keeps the parent post blocked when quoted-post metadata mounts before its timestamp', async () => {
  const runtime = await startRuntime();
  runtime.bg.respond = () => ({ ok: true, custom: { 'preset-1': 0.99 } });
  const article = buildTweetArticle({
    id: '2105016474192515573',
    text: 'The parent post stays unchanged while its quote hydrates.',
  });
  try {
    runtime.handle.discover();
    await until(() => article.hasAttribute('data-jev-hidden'));
    const quote = document.createElement('div');
    quote.setAttribute('role', 'link');
    quote.innerHTML = '<a href="/personakoto/status/2104953623734022484"><time>5h</time></a>';
    article.prepend(quote);
    runtime.handle.discover();
    expect(
      article.hasAttribute('data-jev-hidden'),
      'a quoted timestamp must not replace the classified parent with an unclassified post',
    ).toBe(true);
    await until(() => runtime.handle.report().pending === 0);
    expect(runtime.handle.report().blocked).toBe(1);
    quote.remove();
    runtime.handle.discover();
    expect(article.hasAttribute('data-jev-hidden')).toBe(true);
  } finally {
    stopRuntime(runtime);
  }
});
