import { test, expect } from './fixtures';
import { STORAGE_KEYS, type BlockedEntry } from '../../src/filtering/types';

function entries(): BlockedEntry[] {
  return Array.from({ length: 500 }, (_, index) => ({
    tweetId: `virtual-${index}`,
    author: `Author ${index}`,
    handle: `reader${index}`,
    snippet: `Entry ${index}: ${'Variable height row text. '.repeat((index % 5) + 1)}`,
    surface: 'timeline',
    ts: index + 1,
    reasons: [{ key: index % 2 ? 'hentai' : 'porn', score: 0.9 }],
  }));
}

test('log rows stay measured and interactive across scrolling, resizing, updates and tab remounts', async ({
  page,
  worker,
  extensionId,
}) => {
  const log = entries();
  await worker.evaluate(({ key, log }) => chrome.storage.local.set({ [key]: log }), {
    key: STORAGE_KEYS.log,
    log,
  });
  await page.goto(`chrome-extension://${extensionId}/logs.html`);
  const scroll = page.locator('.virtual-scroll');
  const rows = page.locator('.row');
  await expect(rows.filter({ hasText: 'Entry 0:' })).toBeVisible();
  expect(await rows.count()).toBeLessThan(50);
  await scroll.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  const last = rows.filter({ hasText: 'Entry 499:' });
  await expect(last).toBeVisible();
  await page.setViewportSize({ width: 500, height: 700 });
  await scroll.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(last).toBeVisible();
  await last.getByRole('button', { name: 'Unblock', exact: true }).click();
  await expect(last).toContainText('Unblocked');

  // Reorder the same number of keys to invalidate cached index measurements.
  await worker.evaluate(({ key, log }) => chrome.storage.local.set({ [key]: [...log].reverse() }), {
    key: STORAGE_KEYS.log,
    log,
  });
  await scroll.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(last).toBeVisible();
  await expect(last).toContainText('Unblocked');

  const rowPositions = await rows.evaluateAll((nodes) =>
    nodes.map((node) => {
      const bounds = node.getBoundingClientRect();

      return { top: bounds.top, bottom: bounds.bottom };
    }),
  );

  for (let index = 1; index < rowPositions.length; index++)
    expect(rowPositions[index]!.top).toBeGreaterThanOrEqual(rowPositions[index - 1]!.bottom - 1);

  await page.getByRole('tab', { name: /Errors/ }).click();
  await expect(page.getByText('No scan errors')).toBeVisible();
  await page.getByRole('tab', { name: /Blocked/ }).click();
  await expect(last).toBeVisible();
  await page.getByRole('button', { name: 'Clear all', exact: true }).click();
  await expect(rows).toHaveCount(0);
});
