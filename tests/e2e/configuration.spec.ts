import { test, expect, remoteSettings } from './fixtures';
import * as Schema from 'effect/Schema';
import { SettingsSchema } from '../../src/filtering/schemas';

test('upgrading settings without a filter list does not send text with a saved provider key', async ({
  page,
  context,
  worker,
  extensionId,
}) => {
  let requests = 0;
  await context.route('https://ai-gateway.vercel.sh/**', async (route) => {
    requests++;
    await route.abort();
  });

  const stored = await worker.evaluate(
    async () => (await chrome.storage.local.get('settings')).settings,
  );

  const { textFilters: _filters, ...settings } = Schema.decodeUnknownSync(SettingsSchema)(stored);
  await worker.evaluate(async (settings) => {
    await chrome.storage.local.set({ settings });
  }, settings);
  await page.goto('https://x.com/home');
  await expect(
    page.locator('[data-post="101"]').getByRole('button', { name: 'Not scanned', exact: true }),
  ).toBeVisible();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByRole('tab', { name: 'Filters', exact: true }).click();
  await expect(
    popup.getByRole('button', { name: 'Delete Content filter', exact: true }),
  ).toHaveCount(0);
  expect(requests).toBe(0);
});

test('blocked history displays and filters reason identifiers absent from current settings', async ({
  page,
  worker,
  extensionId,
}) => {
  await worker.evaluate(async () => {
    const entry = {
      tweetId: '101',
      author: '@author',
      snippet: 'Saved matching post',
      surface: 'Text',
      ts: 1,
      reasons: [{ key: 'unknownCategory', label: 'Saved rule', score: 0.9 }],
    };

    await chrome.storage.local.set({
      blockedLog: [
        entry,
        {
          ...entry,
          tweetId: '102',
          snippet: 'Other saved post',
          reasons: [{ key: 'porn', score: 0.8 }],
        },
      ],
    });
  });
  await page.goto(`chrome-extension://${extensionId}/logs.html`);
  await expect(page.locator('.row')).toHaveCount(2);
  await expect(page.getByText('Saved rule 90%', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Filter by reason' }).click();
  await page.getByRole('option', { name: 'Saved rule', exact: true }).click();
  await expect(page.locator('.row')).toHaveCount(1);
  await expect(page.locator('.row')).toContainText('Saved matching post');
});

test('threshold edits apply after a pause and flush when the popup closes', async ({
  context,
  worker,
  extensionId,
  setSettings,
}) => {
  const configured = remoteSettings();
  configured.enabled.porn = true;
  await setSettings(configured);
  const popup = await context.newPage();
  await popup.clock.install();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByRole('tab', { name: 'Images', exact: true }).click();
  const input = popup.getByRole('spinbutton', { name: 'Porn threshold percent', exact: true });

  const savedPercent = async () => {
    const stored = await worker.evaluate(
      async () => (await chrome.storage.local.get('settings')).settings,
    );

    return Schema.decodeUnknownSync(SettingsSchema)(stored).thresholds.porn * 100;
  };

  const initial = await savedPercent();
  await input.fill('75');
  await popup.clock.fastForward(300);
  expect(await savedPercent()).toBe(initial);
  await input.fill('80');
  await expect(popup.getByRole('slider', { name: 'Porn threshold', exact: true })).toHaveValue(
    '80',
  );
  await popup.clock.fastForward(300);
  expect(await savedPercent()).toBe(initial);
  await popup.clock.fastForward(100);
  await expect.poll(savedPercent).toBe(80);
  await input.fill('25');
  await popup.close();
  await expect.poll(savedPercent).toBe(25);
});

test('a newer saved threshold cancels an older pending popup edit', async ({
  context,
  worker,
  extensionId,
  setSettings,
}) => {
  const configured = remoteSettings();
  configured.enabled.porn = true;
  await setSettings(configured);
  const popup = await context.newPage();
  await popup.clock.install();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByRole('tab', { name: 'Images', exact: true }).click();
  const input = popup.getByRole('spinbutton', { name: 'Porn threshold percent', exact: true });
  await input.fill('75');
  configured.thresholds.porn = 0.35;
  await setSettings(configured);
  await expect(input).toHaveValue('35');
  await popup.clock.fastForward(400);
  await popup.close();

  const stored = await worker.evaluate(
    async () => (await chrome.storage.local.get('settings')).settings,
  );

  expect(Schema.decodeUnknownSync(SettingsSchema)(stored).thresholds.porn).toBe(0.35);
});

test('provider switches isolate credentials and restore each providers own key', async ({
  page,
  context,
  extensionId,
}) => {
  const calls: Array<{ correctCredential: boolean }> = [];
  await context.route('https://api.typesafe.ai/**', async (route) => {
    calls.push({
      correctCredential: route.request().headers().authorization === 'Bearer synthetic-typesafe',
    });
    await route.fulfill({
      json: { answers: { 'custom:preset-1': { type: 'noul', noul: 0.01 } } },
    });
  });
  await page.goto('https://x.com/home');
  const post = page.locator('[data-post="101"]');
  await expect(post.getByRole('button', { name: 'Allowed', exact: true })).toBeVisible();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByRole('tab', { name: 'Filters', exact: true }).click();
  await popup.getByRole('tab', { name: 'Settings', exact: true }).click();
  await popup.locator('#text-provider').selectOption('typesafe');
  await expect(popup.locator('#gateway-key')).toHaveValue('');
  await expect(post.getByRole('button', { name: 'Not fully checked', exact: true })).toBeVisible();
  expect(calls).toEqual([]);
  await popup.locator('#gateway-key').fill('synthetic-typesafe');
  await expect(post.getByRole('button', { name: 'Allowed', exact: true })).toBeVisible();
  expect(calls).toContainEqual({ correctCredential: true });
  expect(calls).not.toContainEqual({ correctCredential: false });
  await popup.locator('#text-provider').selectOption('vercel');
  await expect(popup.locator('#gateway-key')).toHaveValue('test-only-not-a-real-key');
  await popup.locator('#text-provider').selectOption('typesafe');
  await expect(popup.locator('#gateway-key')).toHaveValue('synthetic-typesafe');
  await popup.locator('#text-provider').selectOption('openrouter');
  await expect(popup.locator('#gateway-key')).toHaveValue('');
});

test('late and replaced video posters update the filtering decision without unrelated mutations', async ({
  page,
  context,
  setSettings,
}) => {
  test.setTimeout(90_000);
  const settings = remoteSettings();
  settings.textFilters = [];
  settings.enabled.aiGenerated = false;

  for (const category of ['porn', 'hentai', 'sexy', 'drawings'] as const)
    settings.thresholds[category] = 0;
  await setSettings(settings);
  await context.route('**/ext_tw_video_thumb/missing/**', (route) =>
    route.fulfill({ status: 404, body: 'Missing poster' }),
  );
  await page.goto('https://x.com/home');
  const post = page.locator('[data-post="101"]');
  await post.locator('[data-jev-host]').waitFor({ state: 'attached' });
  await post.evaluate(async (article) => {
    const video = document.createElement('video');
    article.append(video);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    video.poster = 'https://pbs.twimg.com/ext_tw_video_thumb/late/pu/img/poster.jpg?name=small';
  });
  await expect(post).toBeHidden({ timeout: 60_000 });
  await post.locator('video').evaluate((video) => {
    if (!(video instanceof HTMLVideoElement)) throw new Error('Expected a video poster.');
    video.poster = 'https://pbs.twimg.com/ext_tw_video_thumb/missing/pu/img/poster.jpg?name=small';
  });
  await expect(post).toBeVisible();
  await expect(
    post.getByRole('button', { name: /Retry scheduled|Not fully checked/ }),
  ).toBeVisible();
});

test('rapid credential edits survive popup close and independent windows preserve unrelated settings', async ({
  page,
  context,
  extensionId,
  worker,
}) => {
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.getByRole('tab', { name: 'Filters', exact: true }).click();
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  const input = page.locator('#gateway-key');
  await input.fill('');
  await input.pressSequentially('synthetic-fast-key', { delay: 0 });
  await expect(input).toHaveValue('synthetic-fast-key');
  await page.close();
  await expect
    .poll(async () => {
      const stored = await worker.evaluate(
        async () => (await chrome.storage.local.get('settings')).settings,
      );

      return Schema.decodeUnknownSync(SettingsSchema)(stored).providerKeys.vercel;
    })
    .toBe('synthetic-fast-key');

  const first = await context.newPage();
  const second = await context.newPage();
  await Promise.all([
    first.goto(`chrome-extension://${extensionId}/popup.html`),
    second.goto(`chrome-extension://${extensionId}/popup.html`),
  ]);
  await Promise.all([
    first.getByRole('tab', { name: 'Filters', exact: true }).click(),
    second.getByRole('tab', { name: 'Filters', exact: true }).click(),
  ]);
  await second.getByRole('switch', { name: 'Enable AI-written text', exact: true }).click();
  await expect(
    second.getByRole('spinbutton', { name: 'AI-written text threshold percent', exact: true }),
  ).toBeEnabled();
  await first.getByRole('button', { name: 'Edit', exact: true }).click();
  await Promise.all([
    first.getByRole('spinbutton', { name: 'Content filter threshold percent' }).fill('37'),
    second
      .getByRole('spinbutton', { name: 'AI-written text threshold percent', exact: true })
      .fill('48'),
  ]);
  await first.getByRole('button', { name: 'Save filter', exact: true }).click();
  await expect
    .poll(async () => {
      const stored = await worker.evaluate(
        async () => (await chrome.storage.local.get('settings')).settings,
      );

      const parsed = Schema.decodeUnknownSync(SettingsSchema)(stored);

      return {
        preset: parsed.textFilters.find((filter) => filter.id === 'preset-1')?.threshold,
        aiGenerated: parsed.thresholds.aiGenerated,
      };
    })
    .toEqual({ preset: 0.37, aiGenerated: 0.48 });
});

for (const kind of ['custom', 'builtin']) {
  for (const flush of ['blur', 'pagehide', 'debounce']) {
    test(`a stale ${kind} threshold ${flush} save preserves a newer field value before reconciliation`, async ({
      context,
      worker,
      extensionId,
      setSettings,
    }) => {
      const settings = remoteSettings();
      settings.enabled.porn = true;
      await setSettings(settings);
      const original = settings.textFilters[0]!;
      const popup = await context.newPage();
      await popup.clock.install();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);

      if (kind === 'builtin') await popup.getByRole('tab', { name: 'Images', exact: true }).click();
      await popup.evaluate(
        ({ kind, id }) => {
          const send = chrome.runtime.sendMessage.bind(chrome.runtime);
          let injected = false;
          Object.defineProperty(chrome.runtime, 'sendMessage', {
            value: async (request: {
              type: string;
              change?: { field: string; value?: unknown };
            }) => {
              const change = request.change;

              if (
                !injected &&
                request.type === 'update-settings' &&
                change?.field === (kind === 'custom' ? 'patchTextFilter' : 'threshold')
              ) {
                injected = true;
                // The delayed write is already submitted; a newer view commits before it enters the lock.
                await send({
                  type: 'update-settings',
                  change:
                    kind === 'custom'
                      ? {
                          field: 'patchTextFilter',
                          id,
                          value: {
                            threshold: 0.81,
                            enabled: false,
                            instructions: 'Newer instructions',
                          },
                        }
                      : { field: 'threshold', category: 'porn', value: 0.81 },
                });
              }

              return send(request);
            },
          });
        },
        { kind, id: original.id },
      );

      const input = popup.getByRole('spinbutton', {
        name: kind === 'custom' ? `${original.name} threshold percent` : 'Porn threshold percent',
        exact: true,
      });

      await input.fill('25');

      if (flush === 'blur') await input.press('Tab');
      else if (flush === 'pagehide')
        await popup.evaluate(() => window.dispatchEvent(new Event('pagehide')));
      else await popup.clock.fastForward(400);
      await expect
        .poll(async () => {
          const raw = await worker.evaluate(
            async () => (await chrome.storage.local.get('settings')).settings,
          );

          const saved = Schema.decodeUnknownSync(SettingsSchema)(raw);

          return kind === 'custom' ? saved.textFilters[0]?.threshold : saved.thresholds.porn;
        })
        .toBe(0.81);
      await expect(input).toHaveValue('81');

      if (kind === 'custom') {
        await expect(
          popup.getByRole('switch', { name: `Enable ${original.name}`, exact: true }),
        ).not.toBeChecked();
        await expect(popup.locator('.custom-filter')).toContainText('Newer instructions');
      }
    });
  }
}
