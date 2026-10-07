import { test, expect } from './fixtures';

test('late decisions keep the post being read in place after native scrolling', async ({
  page,
  context,
  worker,
}) => {
  expect(worker.url()).toContain('chrome-extension:');
  const decision = Promise.withResolvers<void>();
  await context.route('https://ai-gateway.vercel.sh/**', async (route) => {
    await decision.promise;
    const request = route.request().postDataJSON();
    await route.fulfill({
      json: {
        answers: Object.fromEntries(
          Object.keys(request.questions).map((key) => [
            key,
            {
              type: 'boolean',
              probability: request.state.tweet_text.includes('BLOCK_TEXT') ? 0.99 : 0.01,
            },
          ]),
        ),
      },
    });
  });
  await page.route('https://x.com/home', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><style>body { margin: 0; overflow-anchor: none; font: 16px system-ui } main { width: 600px; margin: auto } article { box-sizing: border-box; height: 240px; padding: 20px; border-bottom: 1px solid gray }</style><main>${Array.from({ length: 15 }, (_, index) => `<div data-testid="cellInnerDiv"><article data-testid="tweet" data-post="${900 + index}"><div data-testid="User-Name">Reader @reader</div><button data-testid="caret">More</button><a href="/reader/status/${900 + index}"><time>Now</time></a><div data-testid="tweetText">${index < 3 || index === 14 ? 'BLOCK_TEXT' : 'An ordinary post'} ${index}</div></article></div>`).join('')}</main>`,
    }),
  );
  await page.goto('https://x.com/home');
  await expect(page.locator('[data-jev-host]')).toHaveCount(15);
  await page.mouse.wheel(0, 780);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(780);
  const reading = page.locator('[data-post="903"]');
  const before = await reading.boundingBox();
  decision.resolve();
  await expect(page.locator('[data-post="900"]')).toBeHidden();
  await expect(page.locator('[data-post="902"]')).toBeHidden();
  await expect.poll(async () => (await reading.boundingBox())!.y).toBe(before!.y);
  await expect(page.locator('[data-post="914"]')).toBeHidden();
  await expect(page.locator('[data-post="914"]').locator('xpath=..')).not.toHaveAttribute(
    'data-jev-preserved',
  );
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(3);
  await page.mouse.wheel(0, -780);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  const first = page.locator('[data-post="900"]');
  const next = page.locator('[data-post="903"]');
  const nextBefore = await next.boundingBox();
  await page.getByRole('button', { name: 'Show post', exact: true }).first().click();
  await expect(first).toBeVisible();
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(2);
  expect((await next.boundingBox())!.y).toBe(nextBefore!.y);
  await first.getByRole('button', { name: 'Shown temporarily', exact: true }).click();
  await page.getByRole('button', { name: 'Hide again', exact: true }).click();
  await expect(first).toBeHidden();
  expect((await next.boundingBox())!.y).toBe(nextBefore!.y);
  const overrides = await worker.evaluate(
    async () => (await chrome.storage.local.get('postOverrides')).postOverrides,
  );
  expect(overrides ?? {}).toEqual({});
  // Recycled X cells must shed the previous post's reserved space and controls.
  await first.evaluate((article) => {
    article.querySelector('a')!.setAttribute('href', '/reader/status/999');
    article.querySelector('[data-testid="tweetText"]')!.textContent = 'An ordinary recycled post';
  });
  await expect(first).toBeVisible();
  await expect(first.locator('xpath=..')).not.toHaveAttribute('data-jev-preserved');
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(2);
});
