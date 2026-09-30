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
  await expect(previewPost.locator('[data-jev-card-link]')).toBeVisible();

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
  await expect(review).toHaveURL('https://x.com/test/status/102');
  await expect(review.locator('[data-post="102"]')).toBeVisible();
  await review.close();
  await row.getByRole('button', { name: 'Unblock', exact: true }).click();
  await expect(blocked).toBeVisible();
  await page.reload();
  await expect(blocked).toBeVisible();
  await expect(blocked.getByRole('button', { name: 'Allowed by you', exact: true })).toBeVisible();
});
test('never filters the post opened directly and follows a same-document route change', async ({
  page,
  setSettings,
}) => {
  const settings = defaultSettings();
  settings.providerKeys.vercel = 'test-only-not-a-real-key';
  for (const category of ['porn', 'hentai', 'sexy', 'drawings'] as const)
    settings.enabled[category] = false;
  await setSettings(settings);

  await page.goto('https://x.com/test/status/102');
  const opened = page.locator('[data-post="102"]');
  await expect(opened).toBeVisible();
  await expect(opened.getByRole('button', { name: 'Opened post', exact: true })).toBeVisible();
  // Everything else on the page keeps the normal policy: the neighboring
  // preview still scores and hides.
  await expect(page.locator('[data-post="103"] [data-testid="card.wrapper"]')).toBeHidden();

  // URL-only navigation must update visibility without a DOM mutation.
  await page.evaluate(() => history.pushState({}, '', '/home'));
  await expect(opened).toBeHidden();
  await expect(page.locator('[data-post="101"]')).toBeVisible();
  await page.evaluate(() => history.replaceState({}, '', '/test/status/102'));
  await expect(opened).toBeVisible();
  await expect(opened.getByRole('button', { name: 'Opened post', exact: true })).toBeVisible();
  await page.evaluate(() => history.pushState({}, '', '/home'));
  await expect(opened).toBeHidden();
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL('https://x.com/test/status/102');
  await expect(opened).toBeVisible();
});

test('collapses blocked timeline cells and restores their space on pause', async ({
  page,
  context,
  extensionId,
}) => {
  await page.goto('https://x.com/home');
  const blocked = page.locator('[data-post="102"]');
  const previewCard = page.locator('[data-post="103"] [data-testid="card.wrapper"]');
  await expect(previewCard).toBeHidden();
  await expect(blocked).toBeHidden();
  const blockedCell = blocked.locator('xpath=..');
  await expect
    .poll(() => blockedCell.evaluate((cell) => cell.getBoundingClientRect().height))
    .toBe(0);
  await expect(page.locator('[data-post="101"] [data-jev-host]')).toHaveCount(1);
  const controlBox = await page.locator('[data-post="101"]').evaluate((article) => {
    const host = article.querySelector<HTMLElement>('[data-jev-host]');
    const caret = article.querySelector<HTMLElement>('[data-testid="caret"]');
    const button = host?.shadowRoot?.querySelector('button');
    if (!host || !caret || !button) throw new Error('filter control geometry is unavailable');
    const rect = (element: Element) => {
      const box = element.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
      };
    };
    return { article: rect(article), host: rect(host), button: rect(button), caret: rect(caret) };
  });
  expect(controlBox.host.width).toBeGreaterThanOrEqual(30);
  expect(controlBox.button.width).toBeGreaterThanOrEqual(30);
  expect(controlBox.button.left).toBeGreaterThanOrEqual(controlBox.host.left);
  expect(controlBox.button.right).toBeLessThanOrEqual(controlBox.host.right);
  expect(controlBox.button.left).toBeGreaterThanOrEqual(controlBox.article.left);
  expect(controlBox.button.right).toBeLessThanOrEqual(controlBox.article.right);
  const spacing = await page.locator('[data-post="101"]').evaluate((article) => {
    const host = article.querySelector<HTMLElement>('[data-jev-host]')!;
    const author = article.querySelector('[data-testid="User-Name"]')!;
    const text = article.querySelector('[data-testid="tweetText"]')!;
    const measure = () => ({
      gap: text.getBoundingClientRect().top - author.getBoundingClientRect().bottom,
      height: article.getBoundingClientRect().height,
    });
    const enabled = measure();
    const parent = host.parentNode!;
    const next = host.nextSibling;
    host.remove();
    const native = measure();
    parent.insertBefore(host, next);
    return { enabled, native };
  });
  expect(spacing.enabled).toEqual(spacing.native);

  const initialTop = await page.evaluate(() => {
    const marker = document.createElement('div');
    marker.dataset.layoutSentinel = '';
    marker.style.height = '1px';
    document.querySelector('main')!.append(marker);
    return marker.getBoundingClientRect().top;
  });

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const toggle = popup.getByRole('switch', { name: 'Enable filtering', exact: true });

  await toggle.click();
  await expect(blocked).toBeVisible();
  const pausedTop = await page
    .locator('[data-layout-sentinel]')
    .evaluate((marker) => marker.getBoundingClientRect().top);
  const restoredHeight = await blockedCell.evaluate((cell) => cell.getBoundingClientRect().height);
  expect(restoredHeight).toBeGreaterThan(0);
  expect(pausedTop - initialTop).toBe(restoredHeight);

  await toggle.click();
  await expect(blocked).toBeHidden();
  const resumedTop = await page
    .locator('[data-layout-sentinel]')
    .evaluate((marker) => marker.getBoundingClientRect().top);
  expect(resumedTop).toBe(initialTop);
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
  settings.providerKeys.vercel = '';
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
  settings.providerKeys.vercel = '';
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
  settings.providerKeys.vercel = 'test-only-not-a-real-key';
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
test('opens blocked image posts from the logs without hiding them', async ({
  page,
  context,
  extensionId,
  setSettings,
}) => {
  test.setTimeout(90_000);
  const settings = defaultSettings();
  settings.providerKeys.vercel = '';
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
  await expect(review).toHaveURL('https://x.com/gardener/status/101');
  await expect(review.locator('[data-post="101"]')).toBeVisible();
  await review.close();
  await logs.close();
  await popup.close();
});

test('does not flap when X swaps media size variants', async ({ page, setSettings }) => {
  test.setTimeout(90_000);
  const settings = defaultSettings();
  settings.providerKeys.vercel = '';
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
  settings.providerKeys.vercel = 'test-only-not-a-real-key';
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

test('keeps page-load badge totals across recycled cells and log visits, then resets on reload', async ({
  page,
  context,
  worker,
  extensionId,
  setSettings,
}) => {
  await page.goto('https://x.com/home');
  await expect(page.locator('[data-post="102"]')).toBeHidden();
  await expect(page.locator('[data-post="103"] [data-testid="card.wrapper"]')).toBeHidden();
  const tabId = await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'https://x.com/home' });
    const id = tabs[0]?.id;
    if (id === undefined) throw new Error('Timeline tab missing');
    return id;
  });
  const badge = () => worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
  const report = () =>
    worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'get-report' }), tabId);
  await expect.poll(badge).toBe('2');

  const logs = await context.newPage();
  await logs.goto(`chrome-extension://${extensionId}/logs.html`);
  await expect(logs.locator('.row')).toHaveCount(2);
  await logs.bringToFront();
  await page.evaluate(() => {
    document.querySelector('[data-post="102"]')?.closest('[data-testid="cellInnerDiv"]')?.remove();
    document.querySelector('[data-post="103"]')?.remove();
    const next = document.querySelector('[data-post="101"]')?.cloneNode(true);
    if (!(next instanceof HTMLElement)) throw new Error('Source article missing');
    next.dataset.post = '104';
    next.querySelector('a')!.setAttribute('href', '/gardener/status/104');
    next.querySelector('[data-jev-host]')?.remove();
    next.querySelector('[data-testid="tweetText"]')!.textContent =
      'Another ordinary gardening post.';
    document.querySelector('main')!.append(next);
  });
  await expect.poll(async () => (await report()).analyzed).toBe(2);
  await page.bringToFront();
  await expect.poll(badge).toBe('2');
  await expect.poll(async () => (await report()).pageBlocked).toBe(2);
  await expect.poll(async () => (await report()).pageAnalyzed).toBe(4);

  const settings = defaultSettings();
  settings.providerKeys.vercel = 'test-only-not-a-real-key';
  for (const key of ['porn', 'hentai', 'sexy', 'drawings'] as const) settings.enabled[key] = false;
  settings.masterEnabled = false;
  await setSettings(settings);
  await expect.poll(badge).toBe('');
  settings.masterEnabled = true;
  await setSettings(settings);
  await expect.poll(badge).toBe('2');

  await page.evaluate(() => {
    const next = document.querySelector('[data-post="104"]')?.cloneNode(true);
    if (!(next instanceof HTMLElement)) throw new Error('Source article missing');
    next.dataset.post = '105';
    next.querySelector('a')!.setAttribute('href', '/test/status/105');
    next.querySelector('[data-jev-host]')?.remove();
    next.querySelector('[data-testid="tweetText"]')!.textContent =
      'BLOCK_TEXT another blocked post.';
    document.querySelector('main')!.append(next);
  });
  await expect(page.locator('[data-post="105"]')).toBeHidden();
  await expect.poll(badge).toBe('3');
  const popup = await context.newPage();
  await page.bringToFront();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator('.counters')).toContainText('5 analyzed / 3 blocked');
  await logs
    .locator('.row')
    .filter({ hasText: 'another blocked post' })
    .getByRole('button', { name: 'Unblock', exact: true })
    .click();
  await expect(page.locator('[data-post="105"]')).toBeVisible();
  await expect.poll(badge).toBe('3');
  await page.reload();
  await expect(page.locator('[data-post="102"]')).toBeHidden();
  await expect(page.locator('[data-post="103"] [data-testid="card.wrapper"]')).toBeHidden();
  await expect.poll(badge).toBe('2');
  await expect.poll(async () => (await report()).pageAnalyzed).toBe(3);
});
