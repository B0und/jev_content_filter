import { test, expect, remoteSettings } from './fixtures';
import * as Schema from 'effect/Schema';
import { SettingsSchema } from '../../src/filtering/schemas';

test.beforeEach(async ({ setSettings }) => {
  const configured = remoteSettings();
  configured.textFilters = [];
  await setSettings(configured);
});

for (const editThreshold of [false, true]) {
  test(`saving a popup draft ${editThreshold ? 'applies an explicitly edited threshold' : 'preserves an untouched inspector threshold'}`, async ({
    page,
    context,
    extensionId,
    setSettings,
    worker,
  }) => {
    const configured = remoteSettings();
    configured.providerKeys.vercel = 'test-only-not-a-real-key';
    await setSettings(configured);
    await page.goto('https://x.com/home');
    await page
      .locator('[data-post="101"]')
      .getByRole('button', { name: 'Allowed', exact: true })
      .click();
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.getByRole('button', { name: 'Edit', exact: true }).click();
    await popup.getByLabel('Filter name', { exact: true }).fill('Renamed rule');
    const threshold = page
      .locator('[data-jev-panel]')
      .getByRole('spinbutton', { name: 'Sexual text threshold percent' });
    await threshold.fill('40');
    await threshold.press('Tab');
    await expect(popup.locator('.custom-filter-heading')).toContainText('40%');
    if (editThreshold) {
      await popup.getByLabel('Block at probability (%)').fill('70');
      await popup.getByLabel('Block at probability (%)').fill('65');
    }
    await popup.getByRole('button', { name: 'Save filter' }).click();
    await expect
      .poll(async () => {
        const raw = await worker.evaluate(
          async () => (await chrome.storage.local.get('settings')).settings,
        );
        const filter = Schema.decodeUnknownSync(SettingsSchema)(raw).textFilters[0]!;
        return { name: filter.name, threshold: filter.threshold };
      })
      .toEqual({ name: 'Renamed rule', threshold: editThreshold ? 0.65 : 0.4 });
  });
}

test('the initial preset can become an unrelated rule and deletion stays saved', async ({
  page,
  context,
  extensionId,
  setSettings,
}) => {
  const configured = remoteSettings();
  configured.providerKeys.vercel = 'test-only-not-a-real-key';
  await setSettings(configured);
  await page.goto('https://x.com/home');
  const post = page.locator('[data-post="101"]');
  await expect(post).toBeVisible();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByRole('button', { name: 'Edit', exact: true }).click();
  await popup.getByLabel('Filter name', { exact: true }).fill('Outdoor hobbies');
  await popup.getByLabel('What should be hidden?').fill('Posts about the garden');
  await popup.getByRole('button', { name: 'Save filter' }).click();
  await expect(post).toBeHidden();
  await popup.reload();
  await expect(
    popup.getByRole('switch', { name: 'Enable Outdoor hobbies', exact: true }),
  ).toBeChecked();
  await popup.getByRole('button', { name: 'Delete Outdoor hobbies', exact: true }).click();
  await expect(post).toBeVisible();
  await popup.reload();
  await expect(popup.locator('.custom-filter')).toHaveCount(0);
});

test('custom filters can be created, edited, disabled and deleted while the feed updates', async ({
  page,
  context,
  extensionId,
  setSettings,
  worker,
}) => {
  const settings = remoteSettings();
  settings.textFilters = [];
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
  await expect(
    logs
      .locator('.row')
      .filter({ hasText: 'A calm afternoon in the garden.' })
      .locator('.col-reasons'),
  ).toHaveText('Gardening 90%');
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

test('cancelled and deleted editors clear their abandoned save errors', async ({
  context,
  extensionId,
  worker,
}) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByRole('button', { name: 'Add text filter' }).click();
  await popup.getByLabel('Filter name', { exact: true }).fill('Abandoned draft');
  await popup.getByLabel('What should be hidden?').fill('garden');
  await worker.evaluate(() => {
    const originalSet = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = (items) => {
      if (!('settings' in items)) return originalSet(items);
      chrome.storage.local.set = originalSet;
      return Promise.reject(new Error('Test storage unavailable'));
    };
  });
  await popup.getByRole('button', { name: 'Save filter' }).click();
  const error = popup.getByRole('alert').filter({ hasText: 'Could not save settings' });
  await expect(error).toBeVisible();
  await popup.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(error).toHaveCount(0);
  await popup.getByRole('button', { name: 'Add text filter' }).click();
  await popup.getByLabel('Filter name', { exact: true }).fill('Replacement');
  await popup.getByLabel('What should be hidden?').fill('garden');
  await popup.getByRole('button', { name: 'Save filter' }).click();
  await expect(
    popup.getByRole('switch', { name: 'Enable Replacement', exact: true }),
  ).toBeChecked();
  await expect(error).toHaveCount(0);
  await popup.getByRole('button', { name: 'Edit', exact: true }).click();
  await worker.evaluate(() => {
    const originalSet = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = (items) => {
      if (!('settings' in items)) return originalSet(items);
      chrome.storage.local.set = originalSet;
      return Promise.reject(new Error('Test edited filter save unavailable'));
    };
  });
  await popup.getByRole('button', { name: 'Save filter' }).click();
  await expect(error).toBeVisible();
  await popup.getByRole('button', { name: 'Delete Replacement', exact: true }).click();
  await expect(popup.getByLabel('Filter name', { exact: true })).toHaveCount(0);
  await expect(error).toHaveCount(0);
});

test('cancelling an untouched editor keeps a failed filter switch error', async ({
  context,
  extensionId,
  worker,
  setSettings,
}) => {
  const configured = remoteSettings();
  configured.textFilters = [
    { id: 'garden', name: 'Gardening', instructions: 'garden', threshold: 0.65, enabled: true },
  ];
  await setSettings(configured);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByRole('button', { name: 'Edit', exact: true }).click();
  await worker.evaluate(() => {
    const originalSet = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = (items) => {
      if (!('settings' in items)) return originalSet(items);
      chrome.storage.local.set = originalSet;
      return Promise.reject(new Error('Test switch save unavailable'));
    };
  });
  await popup.getByRole('switch', { name: 'Enable Gardening', exact: true }).click();
  const error = popup.getByRole('alert').filter({ hasText: 'Could not save settings' });
  await expect(error).toBeVisible();
  await popup.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(error).toBeVisible();
  await popup.getByRole('switch', { name: 'Enable Gardening', exact: true }).click();
  await expect(error).toHaveCount(0);
});

test('a late successful save leaves the newer editor open', async ({
  context,
  extensionId,
  worker,
  setSettings,
}) => {
  const configured = remoteSettings();
  configured.textFilters = [
    { id: 'first', name: 'First', instructions: 'garden', threshold: 0.65, enabled: true },
    { id: 'second', name: 'Second', instructions: 'crypto', threshold: 0.65, enabled: true },
  ];
  await setSettings(configured);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByRole('button', { name: 'Edit', exact: true }).nth(0).click();
  await popup.getByLabel('Filter name', { exact: true }).fill('First changed');
  await worker.evaluate(() => {
    const originalSet = chrome.storage.local.set.bind(chrome.storage.local);
    const delay = Promise.withResolvers<void>();
    Object.assign(globalThis, { releaseFilterSave: () => delay.resolve() });
    chrome.storage.local.set = (items) => {
      if (!('settings' in items)) return originalSet(items);
      chrome.storage.local.set = originalSet;
      return delay.promise.then(() => originalSet(items));
    };
  });
  await popup.getByRole('button', { name: 'Save filter' }).click();
  await expect(popup.getByText('Saving changes…', { exact: true })).toBeVisible();
  await popup.getByRole('button', { name: 'Edit', exact: true }).nth(1).click();
  await expect(popup.getByLabel('Filter name', { exact: true })).toHaveValue('Second');
  await worker.evaluate('globalThis.releaseFilterSave()');
  await expect(popup.getByText('Saving changes…', { exact: true })).toHaveCount(0);
  await expect(popup.getByLabel('Filter name', { exact: true })).toHaveValue('Second');
});
