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

test('shared feed cells remain reserved until their last hidden post is revealed', async ({
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
  const article = (id: number, text: string) =>
    `<article data-testid="tweet" data-post="${id}"><div data-testid="User-Name">Reader @reader</div><button data-testid="caret">More</button><a href="/reader/status/${id}"><time>Now</time></a><div data-testid="tweetText">${text}</div></article>`;
  await page.route('https://x.com/home', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><style>body { margin: 0; overflow-anchor: none } article { box-sizing: border-box; height: 240px; padding: 20px }</style><div data-testid="cellInnerDiv" id="shared">${article(950, 'BLOCK_TEXT first')}${article(951, 'BLOCK_TEXT second')}</div><div data-testid="cellInnerDiv">${article(952, 'Ordinary reading post')}</div><div style="height:2000px"></div>`,
    }),
  );
  await page.goto('https://x.com/home');
  await expect(page.locator('[data-jev-host]')).toHaveCount(3);
  await page.mouse.wheel(0, 200);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(200);
  const reading = page.locator('[data-post="952"]');
  const before = (await reading.boundingBox())!.y;
  decision.resolve();
  await expect(page.locator('#shared [data-jev-hidden-slot]')).toHaveCount(2);
  await expect(page.locator('#shared')).toHaveAttribute('data-jev-preserved', '');
  await expect.poll(async () => (await reading.boundingBox())!.y).toBe(before);
  await page.mouse.wheel(0, -200);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await page.getByRole('button', { name: 'Show post', exact: true }).first().click();
  await expect(page.locator('#shared [data-jev-hidden-slot]')).toHaveCount(1);
  await expect(page.locator('#shared')).toHaveAttribute('data-jev-preserved', '');
  await expect(page.getByRole('button', { name: 'Show post', exact: true })).toBeVisible();
  await page
    .locator('[data-post="950"]')
    .getByRole('button', { name: 'Shown temporarily', exact: true })
    .click();
  await page.getByRole('button', { name: 'Hide again', exact: true }).click();
  await expect(page.locator('#shared [data-jev-hidden-slot]')).toHaveCount(2);
  await expect(page.locator('#shared')).toBeVisible();
  await page.getByRole('button', { name: 'Show post', exact: true }).first().click();
  await page.getByRole('button', { name: 'Show post', exact: true }).click();
  await expect(page.locator('#shared [data-jev-hidden-slot]')).toHaveCount(0);
  await expect(page.locator('#shared')).not.toHaveAttribute('data-jev-preserved');
  expect((await reading.boundingBox())!.y).toBe(before + 200);
});
