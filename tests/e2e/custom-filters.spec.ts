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
