import {
  test as base,
  chromium,
  expect,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultSettings, type Settings } from '../../src/shared/types';

export const test = base.extend<{
  context: BrowserContext;
  worker: Worker;
  extensionId: string;
  setSettings: (settings: Settings) => Promise<void>;
  runtimeErrors: void;
}>({
  runtimeErrors: [
    async ({ context }, provide) => {
      const errors: string[] = [];
      const watch = (page: Page) => {
        page.on('pageerror', (error) => errors.push(error.message));
      };
      context.pages().forEach(watch);
      context.on('page', watch);
      await provide();
      expect(errors, 'Uncaught extension or page errors').toEqual([]);
    },
    { auto: true },
  ],
  context: async ({ browserName, headless }, provide) => {
    if (browserName !== 'chromium') throw new Error('Extension E2E requires Chromium');
    const extension = path.resolve('.output/chrome-mv3');
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    // No test may send posts or credentials to a real endpoint.
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === 'chrome-extension:') return route.continue();
      if (url.hostname === 'ai-gateway.vercel.sh') {
        const request = route.request().postDataJSON() as {
          state?: { tweet_text?: string };
        } | null;
        const text = request?.state?.tweet_text ?? '';
        if (text.includes('API_FAILURE'))
          return route.fulfill({ status: 401, json: { error: 'Invalid test API key' } });
        return route.fulfill({
          json: {
            answers: {
              sexual: { type: 'boolean', probability: text.includes('BLOCK_TEXT') ? 0.99 : 0.01 },
              ai: { type: 'boolean', probability: 0.02 },
            },
          },
        });
      }
      if (url.hostname === 'x.com' || url.hostname === 'twitter.com') {
        return route.fulfill({
          contentType: 'text/html',
          body: await readFile('tests/e2e/feed.html', 'utf8'),
        });
      }
      if (url.hostname === 'pbs.twimg.com') {
        return route.fulfill({
          contentType: 'image/png',
          body: await readFile('mock/pbs.twimg.com/media/landscape.png'),
        });
      }
      return route.abort();
    });
    await provide(context);
    await context.close();
  },
  worker: async ({ context }, provide) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const settings = defaultSettings();
    settings.gatewayKey = 'test-only-not-a-real-key';
    for (const key of ['porn', 'hentai', 'sexy', 'drawings'] as const)
      settings.enabled[key] = false;
    await worker.evaluate(async (value) => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({ settings: value });
    }, settings);
    await provide(worker);
  },
  extensionId: async ({ worker }, provide) => {
    await provide(new URL(worker.url()).host);
  },
  setSettings: async ({ worker }, provide) => {
    await provide(async (settings) => {
      await worker.evaluate(async (value) => {
        await chrome.storage.local.set({ settings: value });
      }, settings);
    });
  },
});

export { expect };
