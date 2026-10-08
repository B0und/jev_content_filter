import { test, expect, remoteSettings } from './fixtures';
import * as Schema from 'effect/Schema';
import { SettingsSchema } from '../../src/filtering/schemas';

const fixture = `<!doctype html><style>body{margin:0;font:15px/20px Arial}main{width:600px;margin:auto}article{padding:16px;border-bottom:1px solid gray}.body{min-height:160px}.header{display:flex;justify-content:space-between}</style><main>${['Reader', 'Reader', 'Other'].map((handle, index) => `<article data-testid="tweet" data-post="${1031 + index}"><div class="header"><div data-testid="User-Name">${handle} @${handle}</div><a href="/${handle}/status/${1031 + index}"><time>Now</time></a><button data-testid="caret">More</button></div><div class="body" data-testid="tweetText">BLOCK_TEXT</div><div role="group"><button data-testid="reply">Reply</button></div></article>`).join('')}</main>`;

test('author exceptions require confirmation, persist, stay category scoped and can be removed', async ({
  page,
  context,
  worker,
  extensionId,
  setSettings,
}) => {
  expect(worker.url()).toContain('chrome-extension:');
  const settings = remoteSettings();
  settings.providerKeys.vercel = 'test-only-not-a-real-key';
  settings.textFilters = [
    { id: 'first', name: 'First', instructions: 'BLOCK_TEXT', threshold: 0.65, enabled: true },
    { id: 'second', name: 'Second', instructions: 'BLOCK_TEXT', threshold: 0.65, enabled: true },
  ];
  await setSettings(settings);
  await page.route('https://x.com/home', (route) =>
    route.fulfill({ contentType: 'text/html', body: fixture }),
  );
  await page.goto('https://x.com/home');
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(3);
  const before = (await page.locator('[data-post="1033"]').boundingBox())!.y;
  const opener = page
    .getByRole('button', { name: 'Skip a filter for @Reader', exact: true })
    .first();
  await opener.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  const stored = await worker.evaluate(
    async () => (await chrome.storage.local.get('settings')).settings,
  );
  expect(Schema.decodeUnknownSync(SettingsSchema)(stored).authorExceptions).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await opener.click();
  await dialog.getByLabel('Filter to skip').selectOption('custom:first');
  await dialog.getByRole('button', { name: 'Save author exception', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(3);
  await expect(page.locator('[data-jev-hidden-slot]').first().locator('p')).not.toContainText(
    'First',
  );
  await opener.click();
  await dialog.getByLabel('Filter to skip').selectOption('custom:second');
  await dialog.getByRole('button', { name: 'Save author exception', exact: true }).click();
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(1);
  expect((await page.locator('[data-post="1033"]').boundingBox())!.y).toBe(before);
  await page.reload();
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(1);
  await expect(page.locator('[data-post="1031"] [data-testid="tweetText"]')).toBeVisible();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByRole('tab', { name: 'Settings', exact: true }).click();
  await popup
    .getByRole('button', { name: 'Remove Second exception for @reader', exact: true })
    .click();
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(3);
});

test('native fetch and XHR relationships drive selective followed-account exceptions and unfollow restores filtering', async ({
  page,
  context,
  worker,
  extensionId,
  setSettings,
}) => {
  expect(worker.url()).toContain('chrome-extension:');
  const settings = remoteSettings();
  settings.providerKeys.vercel = 'test-only-not-a-real-key';
  settings.textFilters = [
    { id: 'first', name: 'First', instructions: 'BLOCK_TEXT', threshold: 0.65, enabled: true },
    { id: 'second', name: 'Second', instructions: 'BLOCK_TEXT', threshold: 0.65, enabled: true },
  ];
  await setSettings(settings);
  let following = true;
  await page.route('https://x.com/i/api/graphql/test/User', (route) =>
    route.fulfill({
      json: {
        data: {
          user: { result: { legacy: { screen_name: 'Reader', following, followed_by: false } } },
        },
      },
    }),
  );
  await page.route('https://x.com/home', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: fixture + `<script>fetch('/i/api/graphql/test/User')</script>`,
    }),
  );
  await page.goto('https://x.com/home');
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(3);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByRole('tab', { name: 'Settings', exact: true }).click();
  await popup
    .getByRole('switch', { name: 'Skip First for followed accounts', exact: true })
    .click();
  await expect(page.locator('[data-jev-hidden-slot]').first().locator('p')).not.toContainText(
    'First',
  );
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(3);
  await popup
    .getByRole('switch', { name: 'Skip Second for followed accounts', exact: true })
    .click();
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(1);
  const oldResponse = Promise.withResolvers<void>();
  const oldStarted = Promise.withResolvers<void>();
  await page.route('https://x.com/i/api/graphql/test/DelayedUser', async (route) => {
    oldStarted.resolve();
    await oldResponse.promise;
    await route.fulfill({
      json: { data: { user: { result: { legacy: { screen_name: 'Reader', following: true } } } } },
    });
  });
  await page.evaluate(() => {
    void fetch('/i/api/graphql/test/DelayedUser');
  });
  await oldStarted.promise;
  following = false;
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', '/i/api/graphql/test/User');
        xhr.onload = () => resolve();
        xhr.onerror = () => reject(new Error('XHR failed'));
        xhr.send();
      }),
  );
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(3);
  const oldDelivered = page.waitForResponse('https://x.com/i/api/graphql/test/DelayedUser');
  oldResponse.resolve();
  await oldDelivered;
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(3);
});
