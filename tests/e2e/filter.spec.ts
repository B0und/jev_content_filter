import { test, expect } from './fixtures';
import { defaultSettings } from '../../src/shared/types';

test('filters posts and previews, restores them on pause, and persists an unblock', async ({
  page,
  context,
  extensionId,
}) => {
  await page.goto('https://x.com/home');
  const safe = page.locator('[data-post="101"]');
  const blocked = page.locator('[data-post="102"]');
  const previewPost = page.locator('[data-post="103"]');
  await expect(safe).toBeVisible();
  await expect(blocked).toBeHidden();
  await expect(previewPost).toBeVisible();
  await expect(previewPost.locator('[data-testid="card.wrapper"]')).toBeHidden();

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByRole('switch', { name: 'Enable filtering', exact: true }).click();
  await expect(blocked).toBeVisible();
  await expect(previewPost.locator('[data-testid="card.wrapper"]')).toBeVisible();
  await popup.getByRole('switch', { name: 'Enable filtering', exact: true }).click();
  await expect(blocked).toBeHidden();

  const logsPromise = context.waitForEvent('page');
  await popup.getByRole('button', { name: 'Open logs' }).click();
  const logs = await logsPromise;
  await logs.waitForLoadState();
  const row = logs.locator('.row').filter({ hasText: 'controlled classifier fixture' });
  const reviewPromise = context.waitForEvent('page');
  await row.getByRole('link').click();
  const review = await reviewPromise;
  await review.waitForLoadState();
  await expect(review).toHaveURL('https://x.com/test/status/102?jev=review');
  await expect(review.locator('[data-post="102"]')).toBeVisible();
  await review.close();
  await row.getByRole('button', { name: 'Unblock', exact: true }).click();
  await expect(blocked).toBeVisible();
  await page.reload();
  await expect(blocked).toBeVisible();
  await expect(blocked.getByRole('button', { name: 'Allowed by you', exact: true })).toBeVisible();
});

test('inspects a post, changes its threshold, and opens extension logs', async ({
  page,
  context,
  extensionId,
}) => {
  await page.goto('https://twitter.com/home');
  await page.evaluate(() => {
    const spacer = document.createElement('div');
    spacer.style.height = '2000px';
    document.body.append(spacer);
  });
  const safe = page.locator('[data-post="101"]');
  await safe.evaluate((element) => element.scrollIntoView({ block: 'end' }));
  await safe.getByRole('button', { name: 'Allowed', exact: true }).click();
  const panel = page.locator('[data-jev-panel]');
  await expect(panel.locator('.panel')).toBeInViewport();
  await expect(panel.getByText('Text', { exact: true })).toBeVisible();
  await panel.getByRole('spinbutton', { name: 'Sexual text threshold percent' }).fill('50');
  await panel.getByRole('spinbutton', { name: 'Sexual text threshold percent' }).press('Tab');
  const logsPromise = context.waitForEvent('page');
  await panel.getByRole('link', { name: 'Open logs' }).click();
  const logs = await logsPromise;
  await expect(logs).toHaveURL(`chrome-extension://${extensionId}/logs.html`);
  await expect(logs.getByRole('tab', { name: /Blocked/ })).toBeVisible();
  await logs.getByRole('tab', { name: /Errors/ }).click();
  await expect(logs.getByRole('tabpanel')).toContainText('No scan errors');
});

test('a failed text request stays visible and exposes an error', async ({ page, extensionId }) => {
  void extensionId;
  await page.goto('https://x.com/home');
  await page.locator('[data-post="101"] [data-testid="tweetText"]').evaluate((node) => {
    node.textContent = 'API_FAILURE';
  });
  const post = page.locator('[data-post="101"]');
  await expect(post.getByRole('button', { name: 'Not fully checked', exact: true })).toBeVisible();
  await expect(post).toBeVisible();
});

test('runs the bundled image classifier without a text API key', async ({ page, setSettings }) => {
  test.setTimeout(90_000);
  const settings = defaultSettings();
  settings.gatewayKey = '';
  settings.enabled.sexualText = false;
  settings.enabled.aiGenerated = false;
  for (const key of ['porn', 'hentai', 'sexy', 'drawings'] as const) settings.thresholds[key] = 1;
  await setSettings(settings);
  await page.goto('https://x.com/home');
  await page.locator('[data-post="101"]').evaluate((post) => {
    const image = document.createElement('img');
    image.src = 'https://pbs.twimg.com/media/landscape.png';
    post.append(image);
  });
  const post = page.locator('[data-post="101"]');
  await expect(post.getByRole('button', { name: 'Allowed', exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await post.getByRole('button', { name: 'Allowed', exact: true }).click();
  const panel = page.locator('[data-jev-panel]');
  const pornRow = panel
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: 'Porn', exact: true }) });
  for (const label of ['Porn', 'Hentai', 'Suggestive images', 'Drawings / anime']) {
    const row = panel
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: label, exact: true }) });
    await expect(row.getByRole('cell').nth(1)).toHaveText(/\d+\.\d+%/);
  }
  await pornRow.getByRole('spinbutton').fill('0');
  await pornRow.getByRole('spinbutton').press('Tab');
  await expect(post).toBeHidden();
});
test('filters video thumbnails on search results', async ({ page, setSettings }) => {
  test.setTimeout(90_000);
  const settings = defaultSettings();
  settings.gatewayKey = '';
  settings.enabled.sexualText = false;
  settings.enabled.aiGenerated = false;
  for (const key of ['porn', 'hentai', 'sexy', 'drawings'] as const) {
    settings.enabled[key] = true;
    settings.thresholds[key] = 0;
  }
  await setSettings(settings);
  await page.goto('https://x.com/search?q=big%20boobs&src=typed_query');
  await page.locator('[data-post="101"]').evaluate((post) => {
    const image = document.createElement('img');
    image.src =
      'https://pbs.twimg.com/amplify_video_thumb/2069468789058465792/img/eZrGHrwKMJo3FT1u?format=jpg&name=small';
    post.append(image);
  });
  await expect(page.locator('[data-post="101"]')).toBeHidden({ timeout: 60_000 });
});
test('hides disabled categories from the timeline inspector', async ({ page, setSettings }) => {
  test.setTimeout(90_000);
  const settings = defaultSettings();
  settings.gatewayKey = 'test-only-not-a-real-key';
  settings.enabled.drawings = false;
  settings.enabled.sexualText = true;
  settings.enabled.aiGenerated = false;
  for (const key of ['porn', 'hentai', 'sexy'] as const) settings.thresholds[key] = 1;
  settings.thresholds.sexualText = 1;
  await setSettings(settings);
  await page.goto('https://x.com/home');
  await page.locator('[data-post="101"]').evaluate((post) => {
    const image = document.createElement('img');
    image.src = 'https://pbs.twimg.com/media/landscape.png';
    post.append(image);
  });
  const post = page.locator('[data-post="101"]');
  await expect(post.getByRole('button', { name: 'Allowed', exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await post.getByRole('button', { name: 'Allowed', exact: true }).click();
  const panel = page.locator('[data-jev-panel]');
  await expect(panel.locator('.group-label')).toHaveText(['Text', 'Images']);
  await expect(panel.getByRole('cell', { name: 'Porn', exact: true })).toHaveCount(1);
  await expect(panel.getByRole('cell', { name: 'Drawings / anime', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('cell', { name: 'Sexual text', exact: true })).toHaveCount(1);
  await expect(panel.getByRole('cell', { name: 'AI-written text', exact: true })).toHaveCount(0);
});
test('opens blocked image posts in review mode from logs', async ({
  page,
  context,
  extensionId,
  setSettings,
}) => {
  test.setTimeout(90_000);
  const settings = defaultSettings();
  settings.gatewayKey = '';
  settings.enabled.sexualText = false;
  settings.enabled.aiGenerated = false;
  settings.thresholds.porn = 0;
  for (const key of ['hentai', 'sexy', 'drawings'] as const) settings.thresholds[key] = 1;
  await setSettings(settings);
  await page.goto('https://x.com/home');
  await page.locator('[data-post="101"]').evaluate((post) => {
    const image = document.createElement('img');
    image.src = 'https://pbs.twimg.com/media/landscape.png';
    post.append(image);
  });
  const post = page.locator('[data-post="101"]');
  await expect(post).toBeHidden({ timeout: 60_000 });

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const logsPromise = context.waitForEvent('page');
  await popup.getByRole('button', { name: 'Open logs' }).click();
  const logs = await logsPromise;
  await logs.waitForLoadState();
  const row = logs.locator('.row').filter({ hasText: 'A calm afternoon in the garden.' });
  await expect(row).toBeVisible();
  const reviewPromise = context.waitForEvent('page');
  await row.getByRole('link').click();
  const review = await reviewPromise;
  await review.waitForLoadState();
  await expect(review).toHaveURL('https://x.com/gardener/status/101?jev=review');
  await expect(review.locator('[data-post="101"]')).toBeVisible();
  await review.close();
  await logs.close();
  await popup.close();
});

test('does not flap when X swaps media size variants', async ({ page, setSettings }) => {
  test.setTimeout(90_000);
  const settings = defaultSettings();
  settings.gatewayKey = '';
  settings.enabled.sexualText = false;
  settings.enabled.aiGenerated = false;
  for (const key of ['porn', 'hentai', 'sexy', 'drawings'] as const) {
    settings.enabled[key] = true;
    settings.thresholds[key] = 0;
  }
  await setSettings(settings);
  await page.goto('https://x.com/home');

  const post = page.locator('[data-post="101"]');
  await post.evaluate((article) => {
    const image = document.createElement('img');
    image.src = 'https://pbs.twimg.com/media/oscillating?format=jpg&name=small';
    article.append(image);
  });
  await expect(post).toBeHidden({ timeout: 60_000 });

  const result = await post.evaluate(async (article) => {
    const image = article.querySelector<HTMLImageElement>(
      'img[src*="pbs.twimg.com/media/oscillating"]',
    );
    if (!image) throw new Error('oscillating media image missing');
    let removals = 0;
    const observer = new MutationObserver((records) => {
      if (!article.hasAttribute('data-jev-hidden')) {
        removals += records.filter(
          (record) => record.attributeName === 'data-jev-hidden' && record.oldValue !== null,
        ).length;
      }
    });
    observer.observe(article, {
      attributes: true,
      attributeFilter: ['data-jev-hidden'],
      attributeOldValue: true,
    });
    for (let index = 0; index < 24; index++) {
      image.src = `https://pbs.twimg.com/media/oscillating?format=jpg&name=${
        index % 2 === 0 ? '120x120' : 'small'
      }`;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    }
    observer.disconnect();
    return { removals, hidden: article.hasAttribute('data-jev-hidden') };
  });

  expect(result).toEqual({ removals: 0, hidden: true });
});

test('rechecks recycled posts and newly enabled preview categories', async ({
  page,
  setSettings,
}) => {
  const settings = defaultSettings();
  settings.gatewayKey = 'test-only-not-a-real-key';
  for (const key of ['porn', 'hentai', 'sexy', 'drawings'] as const) settings.enabled[key] = false;
  settings.enabled.sexualText = false;
  settings.enabled.aiGenerated = false;
  await setSettings(settings);
  await page.goto('https://x.com/home');
  const preview = page.locator('[data-post="103"] [data-testid="card.wrapper"]');
  await expect(preview).toBeVisible();
  settings.enabled.sexualText = true;
  await setSettings(settings);
  await expect(preview).toBeHidden();
  const recycled = page.locator('[data-post="102"]');
  await expect(recycled).toBeHidden();
  await recycled.evaluate((post) => {
    post.querySelector('[data-testid="tweetText"]')!.textContent = 'A different safe post';
    post.querySelector('a[href*="/status/"]')!.setAttribute('href', '/human/status/104');
  });
  await expect(recycled).toBeVisible();
  await expect(recycled.getByRole('button', { name: 'Allowed', exact: true })).toBeVisible();
});

test('persists popup edits and supports keyboard log filtering and clearing', async ({
  page,
  context,
  extensionId,
}) => {
  await page.goto('https://x.com/home');
  await expect(page.locator('[data-post="102"]')).toBeHidden();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByText('API key & scan details').click();
  const provider = popup.getByLabel('Text provider');
  await expect(provider).toHaveValue('vercel');
  const key = popup.getByLabel('Vercel AI Gateway API key');
  await expect(key).toHaveAttribute('type', 'password');
  const showKey = popup.getByRole('button', { name: 'Show API key', exact: true });
  await showKey.click();
  await expect(key).toHaveAttribute('type', 'text');
  await expect(popup.getByRole('button', { name: 'Hide API key', exact: true })).toBeVisible();
  await popup.getByRole('button', { name: 'Hide API key', exact: true }).click();
  await provider.selectOption('typesafe');
  await expect(popup.getByLabel('TypeSafe API key')).toBeVisible();
  await provider.selectOption('vercel');
  await expect(popup.getByLabel('Vercel AI Gateway API key')).toBeVisible();
  const threshold = popup.getByRole('spinbutton', { name: 'Sexual text threshold percent' });
  await threshold.fill('45');
  await threshold.press('Tab');
  await popup.reload();
  await expect(
    popup.getByRole('spinbutton', { name: 'Sexual text threshold percent' }),
  ).toHaveValue('45');
  await popup.goto(`chrome-extension://${extensionId}/logs.html`);
  await popup.getByRole('combobox', { name: 'Filter by reason' }).click();
  await popup.getByRole('option', { name: 'Porn', exact: true }).click();
  await expect(popup.getByRole('tabpanel')).toContainText('No blocked posts match');
  const blockedTab = popup.getByRole('tab', { name: /Blocked/ });
  await blockedTab.focus();
  await blockedTab.press('ArrowRight');
  await popup.keyboard.press('Enter');
  await expect(popup.getByRole('tab', { name: /Errors/ })).toHaveAttribute('aria-selected', 'true');
  await popup.getByRole('tab', { name: /Blocked/ }).click();
  await popup.getByRole('button', { name: 'Clear all' }).click();
  await expect(popup.getByRole('tabpanel')).toContainText('No blocked posts.');
});
