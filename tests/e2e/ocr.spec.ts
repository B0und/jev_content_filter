import * as Schema from 'effect/Schema';
import { readFile } from 'node:fs/promises';
import { OcrReplyCodec } from '../../src/inference/contracts';
import { test, expect, remoteSettings } from './fixtures';

const EvaluationSchema = Schema.Struct({ state: Schema.Struct({ tweet_text: Schema.String }) });

test('recovers outlined sexual wording inside an image through the installed extension', async ({
  context,
  extensionId,
  page,
}) => {
  await context.route('https://pbs.twimg.com/media/outlined-ocr*', async (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: await readFile('benchmarks/ocr-fixtures/meme.png'),
    }),
  );
  const inputs: string[] = [];
  await context.route('https://ai-gateway.vercel.sh/**', async (route) => {
    const decoded = Schema.decodeUnknownSync(EvaluationSchema)(route.request().postDataJSON());
    inputs.push(decoded.state.tweet_text);
    await route.fulfill({
      json: {
        answers: {
          sexual: {
            type: 'boolean',
            probability: decoded.state.tweet_text.includes('SEND NUDES') ? 0.99 : 0.01,
          },
        },
      },
    });
  });
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const reply: unknown = await popup.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'extract-image-text',
      url: 'https://pbs.twimg.com/media/outlined-ocr.png',
    }),
  );
  expect(Schema.decodeUnknownSync(OcrReplyCodec)(reply)).toMatchObject({
    _tag: 'Success',
    success: expect.stringContaining('SEND NUDES'),
  });
  await page.goto('https://x.com/home');
  await page.evaluate(() => {
    const article = document.createElement('article');
    article.dataset.testid = 'tweet';
    article.dataset.post = 'outlined-ocr';
    article.innerHTML =
      '<div data-testid="User-Name">OCR test</div><a href="/test/status/9003"><time>Now</time></a><div data-testid="tweetText">A harmless caption</div><img src="https://pbs.twimg.com/media/outlined-ocr.png">';
    document.body.append(article);
  });
  await expect(page.locator('[data-post="outlined-ocr"]')).toHaveAttribute('data-jev-hidden', '', {
    timeout: 30000,
  });
  expect(
    inputs.some((text) => text.includes('A harmless caption') && text.includes('SEND NUDES')),
  ).toBe(true);
});

test('reads Russian and English screenshot text locally and filters an innocent caption', async ({
  page,
  context,
  setSettings,
  extensionId,
}) => {
  test.setTimeout(60_000);
  const settings = remoteSettings();
  settings.providerKeys.vercel = 'test-only-not-a-real-key';
  for (const key of ['porn', 'hentai', 'sexy', 'drawings'] as const) settings.enabled[key] = false;
  await setSettings(settings);
  await page.goto('https://x.com/home');
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1100;
    canvas.height = 420;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');
    ctx.fillStyle = '#242424';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'white';
    ctx.font = '36px Arial';
    ctx.fillText('Как называется этап, когда она не', 30, 90);
    ctx.fillText('стесняется сосать твой член, но', 30, 150);
    ctx.fillText('стесняется показать сиськи?', 30, 210);
    ctx.fillText('English screenshot text', 30, 290);
    return canvas.toDataURL();
  });
  await context.route('https://pbs.twimg.com/media/ocr-example*', (route) =>
    route.fulfill({ contentType: 'image/png', body: Buffer.from(image.split(',')[1]!, 'base64') }),
  );
  const inputs: string[] = [];
  await context.route('https://ai-gateway.vercel.sh/**', async (route) => {
    const request: unknown = route.request().postDataJSON();
    const decoded = Schema.decodeUnknownSync(EvaluationSchema)(request);
    const text = decoded.state.tweet_text;
    inputs.push(text);
    // Synthetic provider decision: proves recognized Russian words reach Jev.
    await route.fulfill({
      json: {
        answers: {
          sexual: { type: 'boolean', probability: text.includes('сосать твой член') ? 0.99 : 0.01 },
        },
      },
    });
  });
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const reply: unknown = await popup.evaluate(async () =>
    chrome.runtime.sendMessage({
      type: 'extract-image-text',
      url: 'https://pbs.twimg.com/media/ocr-example.png',
    }),
  );
  const result = Schema.decodeUnknownSync(OcrReplyCodec)(reply);
  expect(result).toMatchObject({
    _tag: 'Success',
    success: expect.stringContaining('сосать твой член'),
  });
  expect(result).toMatchObject({ success: expect.stringContaining('English screenshot text') });
  await page.evaluate(() => {
    const article = document.createElement('article');
    article.dataset.testid = 'tweet';
    article.dataset.post = '9001';
    article.innerHTML =
      '<div data-testid="User-Name">OCR test</div><a href="/test/status/9001"><time>Now</time></a><div data-testid="tweetText">Дегустация</div><img src="https://pbs.twimg.com/media/ocr-example.png">';
    document.body.append(article);
  });
  const article = page.locator('[data-post="9001"]');
  await expect(article).toHaveAttribute('data-jev-hidden', '', { timeout: 30_000 });
  expect(
    inputs.some((text) => text.includes('Дегустация') && text.includes('сосать твой член')),
  ).toBe(true);
  // Image-only posts use the same cached OCR but still get a sexual-text decision.
  await page.evaluate(() => {
    const article = document.createElement('article');
    article.dataset.testid = 'tweet';
    article.dataset.post = '9002';
    article.innerHTML =
      '<div data-testid="User-Name">OCR test</div><a href="/test/status/9002"><time>Now</time></a><img src="https://pbs.twimg.com/media/ocr-example.png">';
    document.body.append(article);
  });
  await expect(page.locator('[data-post="9002"]')).toHaveAttribute('data-jev-hidden', '', {
    timeout: 30_000,
  });
});
