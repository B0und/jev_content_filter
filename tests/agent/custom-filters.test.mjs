import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ExtensionSession } from '../../scripts/extension-session.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

async function waitUntil(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await delay(50);
  }

  throw new Error('Custom filter state was not reached');
}

void test(
  'saved custom text filters still hide matching posts after a full browser restart',
  { timeout: 60_000 },
  async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jev-filter-restart-'));

    const options = {
      root,
      output: path.join(root, '.output/chrome-mv3'),
      profile: path.join(directory, 'profile'),
      artifacts: path.join(directory, 'artifacts'),
      headless: true,
    };

    let session = new ExtensionSession(options);
    t.after(async () => {
      await session.close();
      await rm(directory, { recursive: true, force: true });
    });
    await session.start({ build: false });
    const popup = await session.popup();
    await popup.click('button[aria-label="Delete Content filter"]');
    await popup.click('button ::-p-text(Add text filter)');
    await popup.type('#filter-name', 'Gardening');
    await popup.type('#filter-instructions', 'Posts about the garden');
    await popup.click('button[type="submit"]');
    await waitUntil(
      async () =>
        (await (
          await session.worker()
        ).evaluate(
          async () => (await chrome.storage.local.get('settings')).settings.textFilters.length,
        )) === 1,
    );

    const hidden = async () =>
      (await session.page('feed')).$eval(
        '[data-post="101"] [data-testid="tweetText"]',
        (post) => getComputedStyle(post).visibility === 'hidden',
      );

    await waitUntil(hidden);
    await session.close();
    session = new ExtensionSession(options);
    await session.start({ build: false });

    const restored = await (
      await session.worker()
    ).evaluate(async () => (await chrome.storage.local.get('settings')).settings.textFilters);

    assert.equal(restored.length, 1);
    assert.equal(restored[0].name, 'Gardening');
    assert.equal(restored[0].enabled, true);
    await waitUntil(hidden);
    assert.equal((await session.verify()).ok, true);
  },
);
