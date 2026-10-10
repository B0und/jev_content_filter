import { test, expect, remoteSettings } from '../e2e/fixtures';
import * as Schema from 'effect/Schema';
import { SettingsSchema } from '../../src/filtering/schemas';

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
