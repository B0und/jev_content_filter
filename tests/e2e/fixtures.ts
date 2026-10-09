import {
  test as base,
  chromium,
  expect,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';
import { readFile } from 'node:fs/promises';
import * as Schema from 'effect/Schema';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { defaultSettings, type Settings } from '../../src/filtering/types';

const isEvaluationRequest = Schema.is(
  Schema.Struct({
    state: Schema.Struct({ tweet_text: Schema.String }),
    questions: Schema.Record(Schema.String, Schema.Struct({ instructions: Schema.String })),
  }),
);

export function remoteSettings(): Settings {
  const settings = defaultSettings();
  settings.enabled.aiGenerated = false;

  return settings;
}

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
  context: async ({ browserName, headless }, provide, testInfo) => {
    if (browserName !== 'chromium') throw new Error('Extension E2E requires Chromium');
    const extension = path.resolve(process.env.JEV_EXTENSION_PATH ?? '.output/chrome-mv3');
    testInfo.annotations.push({ type: 'extension-path', description: extension });

    if (process.env.JEV_EXTENSION_PATH) console.info(`Testing installed bundle: ${extension}`);

    for (const file of ['manifest.json', 'background.js', 'content-scripts/content.js']) {
      const bytes = await readFile(path.join(extension, file));
      const hash = createHash('sha256').update(bytes).digest('hex');
      testInfo.annotations.push({ type: `extension-sha256:${file}`, description: hash });

      if (process.env.JEV_EXTENSION_PATH) console.info(`${file} SHA256: ${hash}`);
    }

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
        const request: unknown = route.request().postDataJSON();

        if (!isEvaluationRequest(request))
          return route.fulfill({ status: 400, json: { error: 'Missing tweet text' } });
        const text = request.state.tweet_text;

        if (text.includes('API_FAILURE'))
          return route.fulfill({ status: 401, json: { error: 'Invalid test API key' } });
        const textWords = new Set(text.toLowerCase().match(/\p{L}{4,}/gu) ?? []);

        // Deterministic fake provider: shared content words match, and the
        // BLOCK_TEXT fixture marker forces a match for every requested rule.
        const matchesQuestion = (instructions: string) =>
          text.includes('BLOCK_TEXT') ||
          (
            (instructions.split('\n').slice(1).join('\n') || instructions)
              .toLowerCase()
              .match(/\p{L}{4,}/gu) ?? []
          ).some((word) => !['posts', 'about', 'content'].includes(word) && textWords.has(word));

        return route.fulfill({
          json: {
            answers: Object.fromEntries(
              Object.entries(request.questions)
                .filter(([key]) => key.startsWith('custom:'))
                .map(([key, question]) => [
                  key,
                  {
                    type: 'boolean',
                    probability: matchesQuestion(question.instructions) ? 0.9 : 0.01,
                  },
                ]),
            ),
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

      if (
        url.hostname === 'raw.githubusercontent.com' &&
        url.pathname.includes('/naptha/tessdata/')
      ) {
        const language = path.basename(url.pathname).replace('.traineddata.gz', '');

        if (!['eng', 'rus'].includes(language)) return route.abort();

        return route.fulfill({
          contentType: 'application/gzip',
          body: await readFile(
            `node_modules/@tesseract.js-data/${language}/4.0.0_best_int/${language}.traineddata.gz`,
          ),
        });
      }

      return route.abort();
    });
    await provide(context);
    await context.close();
  },
  worker: async ({ context }, provide) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const settings = remoteSettings();
    settings.providerKeys.vercel = 'test-only-not-a-real-key';

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
