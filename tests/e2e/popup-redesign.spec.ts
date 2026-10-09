import { test, expect, remoteSettings } from './fixtures';
import * as Schema from 'effect/Schema';
import { SettingsSchema } from '../../src/filtering/schemas';

test('the popup keeps everyday controls in view and separates setup from filters', async ({
  context,
  extensionId,
  setSettings,
}) => {
  const settings = remoteSettings();
  settings.providerKeys.vercel = 'test-only-not-a-real-key';
  await setSettings(settings);
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 460, height: 590 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.getByRole('tab', { name: 'Filters', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(popup.getByRole('button', { name: 'Add text filter', exact: true })).toBeVisible();
  await expect(popup.getByLabel('Vercel AI Gateway API key')).toBeHidden();
  const customToggle = popup.getByRole('switch', { name: 'Enable Content filter', exact: true });
  await popup.locator('.custom-filter label').click();
  await expect(customToggle).not.toBeChecked();
  await popup.locator('.custom-filter label').click();
  await expect(customToggle).toBeChecked();
  const footer = await popup.locator('.popup-footer').boundingBox();
  for (const name of ['Content filter threshold', 'AI-written text threshold']) {
    const slider = await popup.getByRole('slider', { name, exact: true }).boundingBox();
    expect(slider!.y + slider!.height).toBeLessThanOrEqual(footer!.y);
  }
  expect(await popup.evaluate(() => document.documentElement.scrollWidth)).toBe(460);
  await popup.getByRole('tab', { name: 'Filters', exact: true }).focus();
  await popup.keyboard.press('ArrowRight');
  await expect(popup.getByRole('tab', { name: 'Images', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await popup.keyboard.press('ArrowRight');
  await expect(popup.getByLabel('Vercel AI Gateway API key')).toBeVisible();
  await expect(popup.locator('.model-card')).toHaveCount(2);
  const before = await popup.locator('.popup-header').boundingBox();
  await popup.locator('.settings-panel').hover();
  await popup.mouse.wheel(0, 800);
  expect((await popup.locator('.popup-header').boundingBox())!.y).toBe(before!.y);
  expect((await popup.locator('.popup-footer').boundingBox())!.y).toBe(footer!.y);
});

for (const count of [1, 20]) {
  test(`deleting among ${count} filters offers undo with saved controls and useful focus`, async ({
    context,
    extensionId,
    setSettings,
    worker,
  }) => {
    const settings = remoteSettings();
    const original = { ...settings.textFilters[0]!, enabled: false, threshold: 0.372 };
    settings.textFilters = [
      original,
      ...Array.from({ length: count - 1 }, (_, index) => ({
        ...original,
        id: `other-${index}`,
        name: `Other ${index}`,
      })),
    ];
    await setSettings(settings);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.getByRole('button', { name: `Delete ${original.name}`, exact: true }).click();
    await expect(popup.locator('.custom-filter')).toHaveCount(count - 1);
    await expect(popup.getByRole('button', { name: 'Undo', exact: true })).toBeFocused();
    await popup.keyboard.press('Enter');
    await expect(popup.locator('.custom-filter')).toHaveCount(count);
    await expect(
      count === 20
        ? popup.getByRole('tab', { name: 'Filters', exact: true })
        : popup.getByRole('button', { name: 'Add text filter', exact: true }),
    ).toBeFocused();
    await expect(
      popup.getByRole('switch', { name: `Enable ${original.name}`, exact: true }),
    ).not.toBeChecked();
    await expect
      .poll(async () => {
        const raw = await worker.evaluate(
          async () => (await chrome.storage.local.get('settings')).settings,
        );
        return Schema.decodeUnknownSync(SettingsSchema)(raw).textFilters;
      })
      .toEqual(expect.arrayContaining(settings.textFilters));
  });
}

test('the workspace retains the originating feed and shares saved filter controls', async ({
  page,
  context,
  extensionId,
  worker,
}) => {
  await page.goto('https://x.com/home');
  await expect(page.locator('[data-jev-host]')).toHaveCount(3);
  const tabId = await worker.evaluate(
    async () => (await chrome.tabs.query({ url: 'https://x.com/home' }))[0]!.id!,
  );
  const workspace = await context.newPage();
  await workspace.goto(`chrome-extension://${extensionId}/options.html?tab=${tabId}`);
  await expect(workspace.locator('.workspace')).toBeVisible();
  await expect(workspace.getByRole('region', { name: 'Current tab status' })).not.toContainText(
    'No filter connected',
  );
  await expect.poll(async () => workspace.locator('.counters').innerText()).toMatch(/\d+ hidden/);
  await workspace.getByRole('spinbutton', { name: 'Content filter threshold percent' }).fill('72');
  await workspace
    .getByRole('spinbutton', { name: 'Content filter threshold percent' })
    .press('Tab');
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(
    popup.getByRole('spinbutton', { name: 'Content filter threshold percent' }),
  ).toHaveValue('72');
  await workspace.getByRole('tab', { name: 'Filters', exact: true }).focus();
  await workspace.keyboard.press('ArrowDown');
  await expect(workspace.getByRole('tab', { name: 'Images', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await workspace.getByRole('tab', { name: 'Filters', exact: true }).click();
  await workspace.getByRole('button', { name: 'Add text filter' }).click();
  await workspace.getByLabel('Filter name', { exact: true }).fill('Garden');
  await workspace.getByLabel('What should be hidden?').fill('Posts about the garden');
  await expect(workspace.getByLabel('Block at probability (%)')).toHaveCount(0);
  await popup.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(workspace.getByLabel('Filter name', { exact: true })).toHaveValue('Garden');
  await workspace.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(workspace.getByRole('button', { name: 'Add text filter' })).toBeFocused();
});

test('opening the workspace without an X tab reports an unavailable feed', async ({
  context,
  extensionId,
}) => {
  const workspace = await context.newPage();
  await workspace.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(workspace.getByRole('region', { name: 'Current tab status' })).toContainText(
    'No filter connected',
  );
});

test('Undo restores the filter actually removed after a concurrent workspace edit', async ({
  context,
  extensionId,
  setSettings,
  worker,
}) => {
  const settings = remoteSettings();
  const original = settings.textFilters[0]!;
  const updated = {
    ...original,
    name: 'Edited from workspace',
    instructions: 'A newer definition from another view',
    threshold: 0.48,
    enabled: false,
  };
  await setSettings(settings);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.evaluate((filter) => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    Object.defineProperty(chrome.runtime, 'sendMessage', {
      value: async (request: { type: string; change?: { field: string } }) => {
        if (request.type === 'update-settings' && request.change?.field === 'deleteTextFilter') {
          // Commit another view's edit after Delete captured its row, before the writer removes it.
          await send({ type: 'update-settings', change: { field: 'textFilter', value: filter } });
        }
        return send(request);
      },
    });
  }, updated);
  await popup.getByRole('button', { name: `Delete ${original.name}`, exact: true }).click();
  await expect(popup.locator('.custom-filter')).toHaveCount(0);
  await popup.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect
    .poll(async () => {
      const raw = await worker.evaluate(
        async () => (await chrome.storage.local.get('settings')).settings,
      );
      return Schema.decodeUnknownSync(SettingsSchema)(raw).textFilters;
    })
    .toEqual([updated]);
});

test('a late failed Undo cannot replace a newer deletion recovery action', async ({
  context,
  extensionId,
  setSettings,
  worker,
}) => {
  const settings = remoteSettings();
  const first = { ...settings.textFilters[0]!, id: 'first-rule', name: 'First rule' };
  const second = { ...first, id: 'second-rule', name: 'Second rule', threshold: 0.42 };
  settings.textFilters = [first, second];
  await setSettings(settings);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.evaluate((id) => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    Object.defineProperty(chrome.runtime, 'sendMessage', {
      value: (request: { type: string; change?: { field: string; value?: { id: string } } }) => {
        if (
          request.type === 'update-settings' &&
          request.change?.field === 'textFilter' &&
          request.change.value?.id === id
        ) {
          return new Promise((resolve) => {
            Object.assign(globalThis, {
              failEarlierUndo: () => resolve({ ok: false, error: 'Delayed Undo failure' }),
            });
          });
        }
        return send(request);
      },
    });
  }, first.id);
  await popup.getByRole('button', { name: 'Delete First rule', exact: true }).click();
  await popup.getByRole('button', { name: 'Undo', exact: true }).click();
  await popup.getByRole('button', { name: 'Delete Second rule', exact: true }).click();
  await expect(popup.locator('.undo-notice')).toContainText('Second rule');
  await popup.evaluate('globalThis.failEarlierUndo()');
  await expect(popup.getByRole('alert')).toContainText('Delayed Undo failure');
  await expect(popup.locator('.undo-notice')).toContainText('Second rule');
  await popup.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect
    .poll(async () => {
      const raw = await worker.evaluate(
        async () => (await chrome.storage.local.get('settings')).settings,
      );
      return Schema.decodeUnknownSync(SettingsSchema)(raw).textFilters;
    })
    .toEqual([second]);
});

for (const failureOrder of ['undo-first', 'delete-first']) {
  test(`a failed newer deletion preserves the earlier Undo after ${failureOrder} failures`, async ({
    context,
    extensionId,
    setSettings,
    worker,
  }) => {
    const settings = remoteSettings();
    const first = { ...settings.textFilters[0]!, id: 'first-rule', name: 'First rule' };
    const second = { ...first, id: 'second-rule', name: 'Second rule' };
    settings.textFilters = [first, second];
    await setSettings(settings);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.evaluate(() => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      Object.defineProperty(chrome.runtime, 'sendMessage', {
        value: (request: {
          type: string;
          change?: { field: string; id?: string; value?: { id: string } };
        }) => {
          const change = request.change;
          if (
            request.type === 'update-settings' &&
            change?.field === 'textFilter' &&
            change.value?.id === 'first-rule'
          ) {
            return new Promise((resolve) =>
              Object.assign(globalThis, {
                failEarlierUndo: () => resolve({ ok: false, error: 'Delayed Undo failure' }),
              }),
            );
          }
          if (
            request.type === 'update-settings' &&
            change?.field === 'deleteTextFilter' &&
            change.id === 'second-rule'
          ) {
            return new Promise((resolve) =>
              Object.assign(globalThis, {
                failNewerDelete: () => resolve({ ok: false, error: 'Delayed delete failure' }),
              }),
            );
          }
          return send(request);
        },
      });
      Object.assign(globalThis, {
        restoreRecoveryMessages: () =>
          Object.defineProperty(chrome.runtime, 'sendMessage', { value: send }),
      });
    });
    await popup.getByRole('button', { name: 'Delete First rule', exact: true }).click();
    await popup.getByRole('button', { name: 'Undo', exact: true }).click();
    await popup.getByRole('button', { name: 'Delete Second rule', exact: true }).click();
    const firstFailure = failureOrder === 'undo-first' ? 'failEarlierUndo' : 'failNewerDelete';
    const lastFailure = failureOrder === 'undo-first' ? 'failNewerDelete' : 'failEarlierUndo';
    await popup.evaluate(`globalThis.${firstFailure}()`);
    await expect(popup.getByRole('alert')).toContainText(
      failureOrder === 'undo-first' ? 'Delayed Undo failure' : 'Delayed delete failure',
    );
    await popup.evaluate(`globalThis.${lastFailure}()`);
    await expect(popup.getByRole('alert')).toContainText(
      failureOrder === 'undo-first' ? 'Delayed delete failure' : 'Delayed Undo failure',
    );
    await expect(popup.locator('.undo-notice')).toContainText('First rule');
    await expect(
      popup.getByRole('button', { name: 'Delete Second rule', exact: true }),
    ).toBeVisible();
    await popup.evaluate('globalThis.restoreRecoveryMessages()');
    await popup.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect
      .poll(async () => {
        const raw = await worker.evaluate(
          async () => (await chrome.storage.local.get('settings')).settings,
        );
        return Schema.decodeUnknownSync(SettingsSchema)(raw).textFilters;
      })
      .toEqual(expect.arrayContaining([first, second]));
  });
}
