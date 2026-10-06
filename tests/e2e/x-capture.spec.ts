import { readFile } from 'node:fs/promises';
import { test, expect, remoteSettings } from './fixtures';
import captured from '../fixtures/x/orca-public-thread/tweets.json' with { type: 'json' };

// Replays captured X article markup. No replacement Twitter renderer is used.
test('filters captured X replies and link cards while keeping the addressed note tweet visible', async ({
  page,
  context,
  setSettings,
}) => {
  const settings = remoteSettings();
  settings.providerKeys.vercel = 'test-only-not-a-real-key';
  for (const category of ['porn', 'hentai', 'sexy', 'drawings'] as const)
    settings.enabled[category] = false;
  await setSettings(settings);
  const articles = await Promise.all(
    captured.tweets.map((tweet) =>
      readFile(`tests/fixtures/x/orca-public-thread/${tweet.rest_id}.html`, 'utf8'),
    ),
  );
  await context.route('https://x.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><meta charset="utf-8"></head><body>${articles.join('\n')}</body></html>`,
    }),
  );
  // Classification remains controlled; the X input is the authentic capture.
  await context.route('https://ai-gateway.vercel.sh/**', (route) =>
    route.fulfill({
      json: {
        answers: {
          sexual: { type: 'boolean', probability: 0.99 },
        },
      },
    }),
  );
  await page.goto(captured.source);
  const opened = page.locator('article[data-testid="tweet"]').nth(0);
  const linkReply = page.locator('article[data-testid="tweet"]').nth(1);
  const textReply = page.locator('article[data-testid="tweet"]').nth(2);
  await expect(opened.getByRole('button', { name: 'Opened post', exact: true })).toBeVisible();
  await expect(opened).toBeVisible();
  await expect(linkReply).toBeVisible();
  await expect(linkReply.locator('[data-testid="card.wrapper"]')).toBeHidden();
  await expect(linkReply.locator('[data-jev-card-link]')).toBeVisible();
  await expect(textReply).toBeHidden();
  await page.evaluate(() => history.pushState({}, '', '/home'));
  await expect(opened).toBeHidden();
  await page.evaluate(() => history.back());
  await expect(opened).toBeVisible();
});
