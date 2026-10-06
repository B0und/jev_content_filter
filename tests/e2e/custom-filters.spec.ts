import { test, expect, remoteSettings } from './fixtures';
import * as Schema from 'effect/Schema';
import { SettingsSchema } from '../../src/filtering/schemas';

test('custom filters can be created, edited, disabled and deleted while the feed updates', async ({
  page,
  context,
  extensionId,
  setSettings,
  worker,
}) => {
  const settings = remoteSettings();
  for (const key of Object.keys(settings.enabled) as Array<keyof typeof settings.enabled>)
    settings.enabled[key] = false;
  settings.providerKeys.vercel = 'test-only-not-a-real-key';
  await setSettings(settings);
  await page.goto('https://x.com/home');
  const garden = page.locator('[data-post="101"]');
  await expect(garden).toBeVisible();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByRole('button', { name: 'Add text filter' }).click();
  await popup.getByLabel('Filter name', { exact: true }).fill('Gardening');
  await popup.getByLabel('What should be hidden?').fill('Posts about the garden');
  await popup.getByRole('button', { name: 'Save filter' }).click();
  await expect(garden).toBeHidden();
  await popup.reload();
  await expect(popup.getByRole('switch', { name: 'Enable Gardening', exact: true })).toBeChecked();
  await popup.getByRole('button', { name: 'Edit', exact: true }).click();
  await popup.getByLabel('Block at probability (%)').fill('95');
  await popup.getByRole('button', { name: 'Save filter' }).click();
  await expect(garden).toBeVisible();
  await popup.getByRole('button', { name: 'Edit', exact: true }).click();
  await popup.getByLabel('Block at probability (%)').fill('65');
  await popup.getByRole('button', { name: 'Save filter' }).click();
  await expect(garden).toBeHidden();
  await popup.getByRole('switch', { name: 'Enable Gardening', exact: true }).click();
  await expect(garden).toBeVisible();
  await popup.getByRole('switch', { name: 'Enable Gardening', exact: true }).click();
  await expect(garden).toBeHidden();
  await popup.getByRole('button', { name: 'Edit', exact: true }).click();
  await popup.getByRole('switch', { name: 'Enable Gardening', exact: true }).click();
  await expect(garden).toBeVisible();
  await popup.getByRole('button', { name: 'Save filter' }).click();
  await expect(
    popup.getByRole('switch', { name: 'Enable Gardening', exact: true }),
  ).not.toBeChecked();
  await expect(garden).toBeVisible();
  await popup.getByRole('switch', { name: 'Enable Gardening', exact: true }).click();
  await expect(garden).toBeHidden();
  const logs = await context.newPage();
  await logs.goto(`chrome-extension://${extensionId}/logs.html`);
  await expect(logs.locator('.col-reasons').filter({ hasText: 'Gardening 90%' })).toBeVisible();
  await popup.getByRole('button', { name: 'Delete Gardening' }).click();
  await expect(garden).toBeVisible();
  await expect
    .poll(async () => {
      const stored = await worker.evaluate(
        async () => (await chrome.storage.local.get('settings')).settings,
      );
      return Schema.decodeUnknownSync(SettingsSchema)(stored).textFilters;
    })
    .toEqual([]);
});

test('a failed filter save preserves the draft for a successful retry', async ({
  context,
  extensionId,
  worker,
}) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByRole('button', { name: 'Add text filter' }).click();
  await popup.getByLabel('Filter name', { exact: true }).fill('Gardening');
  await popup.getByLabel('What should be hidden?').fill('Posts about the garden');
  await popup.getByLabel('Block at probability (%)').fill('72');
  await worker.evaluate(() => {
    const originalSet = chrome.storage.local.set.bind(chrome.storage.local);
    Object.assign(globalThis, {
      restoreCustomFilterStorage: () => {
        chrome.storage.local.set = originalSet;
      },
    });
    chrome.storage.local.set = (items) =>
      'settings' in items
        ? Promise.reject(new Error('Test storage unavailable'))
        : originalSet(items);
  });
  try {
    await popup.getByRole('button', { name: 'Save filter' }).click();
    await expect(
      popup.getByRole('alert').filter({ hasText: 'Could not save settings' }),
    ).toBeVisible();
    await expect(popup.getByLabel('Filter name', { exact: true })).toHaveValue('Gardening');
    await expect(popup.getByLabel('What should be hidden?')).toHaveValue('Posts about the garden');
    await expect(popup.getByLabel('Block at probability (%)')).toHaveValue('72');
  } finally {
    await worker.evaluate('globalThis.restoreCustomFilterStorage()');
  }
  await popup.getByRole('button', { name: 'Save filter' }).click();
  await expect(popup.getByLabel('Filter name', { exact: true })).toHaveCount(0);
  await expect(popup.getByRole('switch', { name: 'Enable Gardening', exact: true })).toBeChecked();
});
