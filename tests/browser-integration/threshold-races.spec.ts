import { test, expect, remoteSettings } from '../e2e/fixtures';
import * as Schema from 'effect/Schema';
import { SettingsSchema } from '../../src/filtering/schemas';

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
