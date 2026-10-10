import { test, expect, remoteSettings } from './fixtures';
import * as Schema from 'effect/Schema';
import { SettingsSchema } from '../../src/filtering/schemas';

const fixture = `<!doctype html><style>body{margin:0;font:15px/20px Arial}main{width:600px;margin:auto}article{padding:16px;border-bottom:1px solid gray}.body{min-height:160px}.header{display:flex;justify-content:space-between}</style><main>${['Reader', 'Reader', 'Other'].map((handle, index) => `<article data-testid="tweet" data-post="${1031 + index}"><div class="header"><div data-testid="User-Name">${handle} @${handle}</div><a href="/${handle}/status/${1031 + index}"><time>Now</time></a><button data-testid="caret">More</button></div><div class="body" data-testid="tweetText">BLOCK_TEXT</div><div role="group"><button data-testid="reply">Reply</button></div></article>`).join('')}</main>`;

const followFixture =
  fixture +
  `
<a data-testid="AppTabBar_Profile_Link" href="/viewerA">Profile</a>
<button id="refresh">Refresh relationships</button>
<button id="delayed">Start delayed refresh</button>
<button id="switch">Switch account</button>
<button id="logout">Log out</button>
<button id="text">Refresh text relationships</button>
<button id="json">Refresh JSON relationships</button>
<output id="status"></output>
<script>
  const status = document.querySelector('#status');
  const profile = document.querySelector('[data-testid=AppTabBar_Profile_Link]');
  const jsonRequest = new XMLHttpRequest();
  document.querySelector('#refresh').onclick = async () => {
    await fetch('/i/api/graphql/test/User');
    status.textContent = 'Refreshed';
  };
  document.querySelector('#delayed').onclick = async () => {
    await fetch('/i/api/graphql/test/DelayedUser');
    await fetch('/i/api/graphql/test/Barrier');
    status.textContent = 'Delayed refresh finished';
  };
  document.querySelector('#switch').onclick = () => { profile.href = '/viewerB'; };
  document.querySelector('#logout').onclick = () => { profile.remove(); };
  document.querySelector('#text').onclick = () => {
    const request = new XMLHttpRequest();
    request.open('GET', '/i/api/graphql/test/User');
    request.send();
  };
  document.querySelector('#json').onclick = () => {
    jsonRequest.open('GET', '/i/api/graphql/test/User');
    jsonRequest.responseType = 'json';
    jsonRequest.send();
  };
  fetch('/i/api/graphql/test/User');
</script>`;

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
    {
      id: 'first',
      name: 'First',
      instructions: 'BLOCK_TEXT',
      threshold: 0.65,
      enabled: true,
    },
    {
      id: 'second',
      name: 'Second',
      instructions: 'BLOCK_TEXT',
      threshold: 0.65,
      enabled: true,
    },
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
    .getByRole('button', {
      name: 'Remove Second exception for @reader',
      exact: true,
    })
    .click();
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(3);
});

test('native fetch and XHR relationships drive the all-filter followed-account checkbox and unfollow restores filtering', async ({
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
    {
      id: 'first',
      name: 'First',
      instructions: 'BLOCK_TEXT',
      threshold: 0.65,
      enabled: true,
    },
    {
      id: 'second',
      name: 'Second',
      instructions: 'BLOCK_TEXT',
      threshold: 0.65,
      enabled: true,
    },
  ];
  await setSettings(settings);
  let following = true;
  await page.route('https://x.com/i/api/graphql/test/User', (route) =>
    route.fulfill({
      json: {
        data: {
          user: {
            result: {
              legacy: { screen_name: 'Reader', following, followed_by: false },
            },
          },
        },
      },
    }),
  );
  await page.route('https://x.com/home', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: followFixture,
    }),
  );
  await page.route('https://x.com/i/api/graphql/test/Barrier', (route) =>
    route.fulfill({ json: {} }),
  );
  await page.goto('https://x.com/home');
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(3);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByRole('tab', { name: 'Settings', exact: true }).click();

  const checkbox = popup.getByRole('checkbox', {
    name: "Don't filter posts from accounts I follow",
    exact: true,
  });

  await expect(checkbox).not.toBeChecked();
  await expect(popup.getByRole('heading', { name: 'Author exceptions', exact: true })).toHaveCount(
    0,
  );
  await checkbox.check();
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(1);
  await checkbox.uncheck();
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(3);
  await checkbox.check();
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(1);
  await popup.reload();
  await popup.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(checkbox).toBeChecked();
  await page.reload();
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(1);
  const oldResponse = Promise.withResolvers<void>();
  const oldStarted = Promise.withResolvers<void>();
  await page.route('https://x.com/i/api/graphql/test/DelayedUser', async (route) => {
    oldStarted.resolve();
    await oldResponse.promise;
    await route.fulfill({
      json: {
        data: {
          user: {
            result: { legacy: { screen_name: 'Reader', following: true } },
          },
        },
      },
    });
  });
  await page.getByRole('button', { name: 'Start delayed refresh', exact: true }).click();
  await oldStarted.promise;
  following = false;
  await page.getByRole('button', { name: 'Refresh text relationships', exact: true }).click();
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(3);
  const oldDelivered = page.waitForResponse('https://x.com/i/api/graphql/test/DelayedUser');
  oldResponse.resolve();
  await oldDelivered;
  await expect(page.locator('#status')).toHaveText('Delayed refresh finished');
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(3);
});

test('switching the active viewer invalidates follows and rejects old-account responses', async ({
  page,
  worker,
  setSettings,
}) => {
  expect(worker.url()).toContain('chrome-extension:');
  const settings = remoteSettings();
  settings.providerKeys.vercel = 'test-only-not-a-real-key';
  settings.skipFollowed = true;
  await setSettings(settings);
  await page.route('https://x.com/home', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: followFixture,
    }),
  );
  const oldResponse = Promise.withResolvers<void>();
  const oldStarted = Promise.withResolvers<void>();
  await page.route('https://x.com/i/api/graphql/test/DelayedUser', async (route) => {
    oldStarted.resolve();
    await oldResponse.promise;
    await route.fulfill({
      json: { legacy: { screen_name: 'Reader', following: true } },
    });
  });
  await page.route('https://x.com/i/api/graphql/test/User', (route) =>
    route.fulfill({
      json: { legacy: { screen_name: 'Reader', following: true } },
    }),
  );
  await page.route('https://x.com/i/api/graphql/test/Barrier', (route) =>
    route.fulfill({ json: {} }),
  );
  await page.goto('https://x.com/home');
  await page.getByRole('button', { name: 'Refresh relationships', exact: true }).click();
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Start delayed refresh', exact: true }).click();
  await oldStarted.promise;
  await page.getByRole('button', { name: 'Switch account', exact: true }).click();
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(3);
  const delivered = page.waitForResponse('https://x.com/i/api/graphql/test/DelayedUser');
  oldResponse.resolve();
  await delivered;
  await expect(page.locator('#status')).toHaveText('Delayed refresh finished');
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(3);
  await page.getByRole('button', { name: 'Refresh relationships', exact: true }).click();
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(3);
  await page.getByRole('button', { name: 'Refresh relationships', exact: true }).click();
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(3);
});

test('JSON-mode XHR and reused requests update followed-account filtering', async ({
  page,
  setSettings,
}) => {
  const settings = remoteSettings();
  settings.providerKeys.vercel = 'test-only-not-a-real-key';
  settings.skipFollowed = true;
  await setSettings(settings);
  await page.route('https://x.com/home', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: followFixture,
    }),
  );
  let following = false;
  await page.route('https://x.com/i/api/graphql/test/User', (route) =>
    route.fulfill({
      json: { core: { screen_name: 'Reader' }, relationship_perspectives: { following } },
    }),
  );
  await page.route('https://x.com/i/api/graphql/test/Barrier', (route) =>
    route.fulfill({ json: {} }),
  );
  await page.goto('https://x.com/home');
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(3);

  following = true;
  await page.getByRole('button', { name: 'Refresh JSON relationships', exact: true }).click();
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(1);
  following = false;
  await page.getByRole('button', { name: 'Refresh JSON relationships', exact: true }).click();
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(3);
});
