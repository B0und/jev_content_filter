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
      body:
        fixture +
        `<a data-testid="AppTabBar_Profile_Link" href="/viewerA">Profile</a><script>fetch('/i/api/graphql/test/User')</script>`,
    }),
  );
  await page.goto('https://x.com/home');
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(3);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByRole('tab', { name: 'Settings', exact: true }).click();
  await popup
    .getByRole('switch', {
      name: 'Skip First for followed accounts',
      exact: true,
    })
    .click();
  await expect(page.locator('[data-jev-hidden-slot]').first().locator('p')).not.toContainText(
    'First',
  );
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(3);
  await popup
    .getByRole('switch', {
      name: 'Skip Second for followed accounts',
      exact: true,
    })
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
      json: {
        data: {
          user: {
            result: { legacy: { screen_name: 'Reader', following: true } },
          },
        },
      },
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

test('switching the active viewer invalidates follows and rejects old-account responses', async ({
  page,
  worker,
  setSettings,
}) => {
  expect(worker.url()).toContain('chrome-extension:');
  const settings = remoteSettings();
  settings.providerKeys.vercel = 'test-only-not-a-real-key';
  settings.followedExemptions = settings.textFilters.map((f) => `custom:${f.id}` as const);
  await setSettings(settings);
  await page.route('https://x.com/home', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: fixture + '<a data-testid="AppTabBar_Profile_Link" href="/viewerA">Profile</a>',
    }),
  );
  const oldResponse = Promise.withResolvers<void>();
  const oldStarted = Promise.withResolvers<void>();
  const oldProcessed = Promise.withResolvers<void>();
  await page.exposeFunction('jevOldViewerProcessed', () => oldProcessed.resolve());
  await page.addInitScript(() => {
    // oxlint-disable-next-line typescript/unbound-method -- invoked below with the original Response receiver.
    const json = Response.prototype.json;
    const tracked = new WeakSet<Promise<unknown>>();
    Response.prototype.json = function () {
      const promise = json.call(this);
      if (this.url.endsWith('/OldViewer')) tracked.add(promise);
      return promise;
    };
    // oxlint-disable-next-line typescript/unbound-method -- called with the original Promise receiver.
    const nativeThen = Promise.prototype.then;
    // oxlint-disable-next-line unicorn/no-thenable -- observes completion of an existing native Promise consumer.
    Promise.prototype.then = function (...args) {
      const result = Reflect.apply(nativeThen, this, args);
      if (tracked.has(this)) {
        tracked.delete(this);
        const complete = () => {
          const callback = Reflect.get(window, 'jevOldViewerProcessed');
          if (typeof callback === 'function') void callback();
        };
        void Reflect.apply(nativeThen, result, [complete, complete]);
      }
      return result;
    };
  });
  await page.route('https://x.com/i/api/graphql/test/OldViewer', async (route) => {
    oldStarted.resolve();
    await oldResponse.promise;
    await route.fulfill({
      json: { legacy: { screen_name: 'Reader', following: true } },
    });
  });
  await page.route('https://x.com/i/api/graphql/test/NewViewer', (route) =>
    route.fulfill({
      json: { legacy: { screen_name: 'Reader', following: true } },
    }),
  );
  await page.goto('https://x.com/home');
  await page.evaluate(async () => {
    await fetch('/i/api/graphql/test/NewViewer');
  });
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(1);
  await page.evaluate(() => {
    void fetch('/i/api/graphql/test/OldViewer');
  });
  await oldStarted.promise;
  await page
    .locator('[data-testid=AppTabBar_Profile_Link]')
    .evaluate((e) => e.setAttribute('href', '/viewerB'));
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(3);
  const delivered = page.waitForResponse('https://x.com/i/api/graphql/test/OldViewer');
  oldResponse.resolve();
  await delivered;
  await oldProcessed.promise;
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(3);
  await page.evaluate(async () => {
    await fetch('/i/api/graphql/test/NewViewer');
  });
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(1);
  await page.locator('[data-testid=AppTabBar_Profile_Link]').evaluate((e) => e.remove());
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(3);
  await page.evaluate(async () => {
    await fetch('/i/api/graphql/test/NewViewer');
  });
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(3);
});

test('page-forged follow packets cannot exempt posts or poison later genuine observations', async ({
  page,
  worker,
  setSettings,
}) => {
  expect(worker.url()).toContain('chrome-extension:');
  const settings = remoteSettings();
  settings.providerKeys.vercel = 'test-only-not-a-real-key';
  settings.followedExemptions = settings.textFilters.map((f) => `custom:${f.id}` as const);
  await setSettings(settings);
  await page.route('https://x.com/home', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: fixture + '<a data-testid="AppTabBar_Profile_Link" href="/viewerA">Profile</a>',
    }),
  );
  await page.route('https://untrusted.example/i/api/graphql/test/External', (route) =>
    route.fulfill({
      headers: { 'Access-Control-Allow-Origin': '*' },
      json: { legacy: { screen_name: 'Reader', following: true } },
    }),
  );
  await page.addInitScript(() => {
    // oxlint-disable-next-line typescript/unbound-method -- called with its original Response receiver.
    const json = Response.prototype.json;
    Response.prototype.json = function () {
      if (this.url.startsWith('https://untrusted.example/'))
        Reflect.set(window, 'jevExternalParsed', true);
      return Reflect.apply(json, this, []);
    };
  });
  let following = true;
  await page.route('https://x.com/i/api/graphql/test/Trusted', (route) =>
    route.fulfill({ json: { legacy: { screen_name: 'Reader', following } } }),
  );
  await page.goto('https://x.com/home');
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(3);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const barrier = (event: MessageEvent) => {
          if (event.source === window && event.data?.type === 'jev-test-barrier') {
            window.removeEventListener('message', barrier);
            resolve();
          }
        };
        window.addEventListener('message', barrier);
        window.postMessage(
          {
            type: 'jev-follow-state',
            epoch: 999999,
            users: [{ handle: 'reader', following: true }],
          },
          location.origin,
        );
        window.postMessage(
          {
            type: 'jev-follow-state',
            payload: JSON.stringify({
              epoch: 999999,
              sequence: 999999,
              users: [{ handle: 'reader', following: true }],
            }),
            signature: Array(32).fill(0),
          },
          location.origin,
        );
        window.postMessage({ type: 'jev-test-barrier' }, location.origin);
      }),
  );
  await page.evaluate(async () => {
    await fetch('https://untrusted.example/i/api/graphql/test/External');
    window.postMessage({ type: 'jev-follow-request' }, location.origin);
  });
  expect(await page.evaluate(() => Reflect.get(window, 'jevExternalParsed') === true)).toBe(false);
  // A native observation is ordered after the forged messages; its success proves no forged epoch poisoned authority.
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(3);
  await page.evaluate(async () => {
    await fetch('/i/api/graphql/test/Trusted');
  });
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(1);
  following = false;
  await page.evaluate(() => {
    // oxlint-disable-next-line typescript/unbound-method -- saved only to restore the original Response prototype method.
    const original = Response.prototype.json;
    Reflect.set(window, 'jevRestoreJson', () => {
      Response.prototype.json = original;
      Reflect.deleteProperty(Object.prototype, 'toJSON');
      Reflect.deleteProperty(Array.prototype, '0');
    });
    Object.defineProperty(Array.prototype, '0', {
      configurable: true,
      set(value) {
        if (value && typeof value === 'object' && 'following' in value) value.following = true;
        Object.defineProperty(this, '0', {
          value,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      },
    });
    Response.prototype.json = () =>
      Promise.resolve({ legacy: { screen_name: 'Reader', following: true } });
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value: () => ({ legacy: { screen_name: 'Reader', following: true } }),
    });
  });
  await page.evaluate(async () => {
    await fetch('/i/api/graphql/test/Trusted');
  });
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(3);
  await page.evaluate(() => {
    const restore = Reflect.get(window, 'jevRestoreJson');
    if (typeof restore === 'function') restore();
    Reflect.deleteProperty(window, 'jevRestoreJson');
  });
  const snapshot = await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      // This page listener precedes the observer's listener registered during open.
      xhr.addEventListener('load', () => {
        xhr.response.legacy.following = true;
        resolve();
      });
      xhr.addEventListener('error', reject);
      xhr.open('GET', '/i/api/graphql/test/Trusted');
      xhr.responseType = 'json';
      xhr.send();
    });
    return await new Promise<Array<{ handle: string; following: boolean }>>((resolve) => {
      const listener = (event: MessageEvent) => {
        if (event.data?.type !== 'jev-follow-state' || typeof event.data.payload !== 'string')
          return;
        window.removeEventListener('message', listener);
        resolve(JSON.parse(event.data.payload).users);
      };
      window.addEventListener('message', listener);
      window.postMessage({ type: 'jev-follow-request' }, location.origin);
    });
  });
  expect(snapshot).toContainEqual({ handle: 'reader', following: false });
  await expect(page.locator('[data-jev-hidden-slot]')).toHaveCount(3);
});
