import { test, expect } from './fixtures';
import * as Schema from 'effect/Schema';
import { TabReportSchema } from '../../src/filtering/schemas';

const decodeReport = Schema.decodeUnknownSync(TabReportSchema);

test('preserves page-load badge totals during sustained native scrolling and recycled returns', async ({
  page,
  worker,
}) => {
  await page.route('https://x.com/home', (route) =>
    route.fulfill({
      path: 'tests/e2e/scroll-feed.html',
      contentType: 'text/html',
    }),
  );
  await page.goto('https://x.com/home');
  const tabId = await worker.evaluate(async () => {
    const id = (await chrome.tabs.query({ url: 'https://x.com/home' }))[0]?.id;
    if (id === undefined) throw new Error('Timeline tab missing');
    return id;
  });
  const report = async () =>
    decodeReport(
      await worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'get-report' }), tabId),
    );
  const badge = () => worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
  await expect(page.locator('[data-post="702"]')).toBeHidden();
  await expect(page.locator('[data-post="703"]')).toBeHidden();
  await expect.poll(badge).toBe('2');
  await expect.poll(async () => (await report()).pending).toBe(0);
  let lastScan = (await report()).lastScannedAt;
  const samples: Array<{ scrollStart: number; badge: string }> = [];

  for (let step = 1; step <= 26; step++) {
    await page.mouse.wheel(0, 2400);
    await expect(page.locator('main')).toHaveAttribute('data-scroll-start', String(step * 10));
    await expect.poll(async () => (await report()).lastScannedAt).toBeGreaterThan(lastScan);
    await expect.poll(async () => (await report()).pending).toBe(0);
    lastScan = (await report()).lastScannedAt;
    const count = await badge();
    samples.push({ scrollStart: step * 10, badge: count });
    expect(count, `Badge reset while scrolling: ${JSON.stringify(samples)}`).toBe('2');
  }
  await expect.poll(async () => (await report()).pageAnalyzed).toBeGreaterThan(200);

  await page.mouse.wheel(0, -62400);
  await expect(page.locator('main')).toHaveAttribute('data-scroll-start', '0');
  await expect(page.locator('[data-post="702"]')).toBeHidden();
  await expect(page.locator('[data-post="703"]')).toBeHidden();
  await expect.poll(async () => (await report()).pending).toBe(0);
  await expect.poll(badge).toBe('2');
  await expect.poll(async () => (await report()).pageBlocked).toBe(2);
});

test('ignores iframe navigation but clears the badge on a new top-level document', async ({
  page,
  worker,
}) => {
  await page.goto('https://x.com/home');
  const tabId = await worker.evaluate(async () => {
    const id = (await chrome.tabs.query({ url: 'https://x.com/home' }))[0]?.id;
    if (id === undefined) throw new Error('Timeline tab missing');
    return id;
  });
  const badge = () => worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
  await expect.poll(badge).toBe('2');
  await page.evaluate(() => {
    const iframe = document.createElement('iframe');
    iframe.src = 'https://x.com/embedded';
    document.body.append(iframe);
  });
  await expect(page.frameLocator('iframe').locator('[data-post="101"]')).toBeVisible();
  expect(await badge()).toBe('2');

  await page.route('https://example.org/', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>New document</title><h1>No filter on this site</h1>',
    }),
  );
  await page.goto('https://example.org/');
  await expect.poll(badge).toBe('');
});
