import { test, expect, remoteSettings } from './fixtures';
import * as Schema from 'effect/Schema';
import { SettingsSchema } from '../../src/shared/schemas';

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
      json: { answers: { sexual: { probability: 0.01 } } },
    });
  });
  await page.goto('https://x.com/home');
  const post = page.locator('[data-post="101"]');
  await expect(post.getByRole('button', { name: 'Allowed', exact: true })).toBeVisible();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByRole('tab', { name: 'Text', exact: true }).click();
  await popup.getByText('Jev provider and scan details', { exact: true }).click();
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
  settings.enabled.sexualText = false;
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
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  await page.getByText('Jev provider and scan details', { exact: true }).click();
  const input = page.locator('#gateway-key');
  await input.fill('');
  await input.pressSequentially('synthetic-fast-key', { delay: 0 });
  await expect(input).toHaveValue('synthetic-fast-key');
  await page.close();
  await expect
    .poll(() =>
      worker.evaluate(async () => {
        const stored = (await chrome.storage.local.get('settings')).settings;
        if (!stored || typeof stored !== 'object' || !('providerKeys' in stored))
          throw new Error('Missing provider credentials.');
        const keys = stored.providerKeys;
        if (!keys || typeof keys !== 'object' || !('vercel' in keys))
          throw new Error('Missing Vercel key slot.');
        return keys.vercel;
      }),
    )
    .toBe('synthetic-fast-key');

  const first = await context.newPage();
  const second = await context.newPage();
  await Promise.all([
    first.goto(`chrome-extension://${extensionId}/popup.html`),
    second.goto(`chrome-extension://${extensionId}/popup.html`),
  ]);
  await Promise.all([
    first.getByRole('tab', { name: 'Text', exact: true }).click(),
    second.getByRole('tab', { name: 'Text', exact: true }).click(),
  ]);
  await second.getByRole('switch', { name: 'Enable AI-written text', exact: true }).click();
  await expect(
    second.getByRole('spinbutton', { name: 'AI-written text threshold percent', exact: true }),
  ).toBeEnabled();
  await Promise.all([
    first
      .getByRole('spinbutton', { name: 'Sexual text threshold percent', exact: true })
      .fill('37'),
    second
      .getByRole('spinbutton', { name: 'AI-written text threshold percent', exact: true })
      .fill('48'),
  ]);
  await expect
    .poll(() =>
      worker.evaluate(async () => {
        const stored = (await chrome.storage.local.get('settings')).settings;
        if (!stored || typeof stored !== 'object' || !('thresholds' in stored))
          throw new Error('Missing thresholds.');
        const thresholds = stored.thresholds;
        if (
          !thresholds ||
          typeof thresholds !== 'object' ||
          !('sexualText' in thresholds) ||
          !('aiGenerated' in thresholds)
        )
          throw new Error('Missing text thresholds.');
        return {
          sexualText: thresholds.sexualText,
          aiGenerated: thresholds.aiGenerated,
        };
      }),
    )
    .toEqual({ sexualText: 0.37, aiGenerated: 0.48 });
});
