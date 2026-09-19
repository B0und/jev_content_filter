// Enabling a category must trigger the checks that were skipped while it
// was off — for posts and link previews alike — and blocked previews must
// be logged and unblockable through the existing override contract.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { STORAGE_KEYS, type Settings } from '../../src/shared/types';
import {
  baseSettings,
  buildTweetArticle,
  clearFeed,
  iconButton,
  startRuntime,
  stopRuntime,
  until,
  aria,
} from './support';

describe('category enable transitions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearFeed();
  });

  it('rescans post text and link preview text when sexual text is enabled', async () => {
    const test = await startRuntime({
      enabled: { ...baseSettings().enabled, sexualText: false, aiGenerated: false },
    });
    const article = buildTweetArticle({
      id: '3001',
      text: 'innocuous text',
      previewText: 'preview page title',
    });
    test.handle.discover();
    await until(
      () => aria(iconButton(article)) === 'Not scanned',
      'post scanned while text was disabled',
    );
    expect(test.bg.jevCalls).toHaveLength(0);

    // Assign the classifier reply before the settings write: the runtime
    // scans immediately when the change lands.
    test.bg.respond = () => ({ ok: true, sexual: 0.9, ai: 0.01 });
    const enabled: Settings = baseSettings({ gatewayKey: 'test-key' });
    await browser.storage.local.set({ [STORAGE_KEYS.settings]: enabled });

    await until(
      () => article.hasAttribute('data-jev-hidden'),
      'post not re-checked after enabling sexual text',
    );
    await until(
      () => test.bg.jevCalls.length >= 2,
      `link preview text not re-checked after enabling (${JSON.stringify(test.bg.jevCalls)}; hidden=${article.hasAttribute('data-jev-hidden')})`,
    );
    expect(test.bg.jevCalls.some((call) => call.text === 'preview page title')).toBe(true);

    stopRuntime(test);
  });

  it('logs blocked previews and unblocks them through the override contract', async () => {
    const test = await startRuntime({ enabled: { ...baseSettings().enabled, aiGenerated: false } });
    test.bg.respond = (request) =>
      request.text === 'preview page about explicit things'
        ? { ok: true, sexual: 0.9, ai: 0.01 }
        : { ok: true, sexual: 0.01, ai: 0.01 };
    const article = buildTweetArticle({
      id: '3002',
      text: 'clean text',
      previewText: 'preview page about explicit things',
    });
    test.handle.discover();

    await until(
      () =>
        article
          .querySelector('[data-testid="card.wrapper"]')
          ?.hasAttribute('data-jev-card-hidden') ?? false,
      'preview not hidden',
    );
    await until(
      () => test.bg.blockedEntries.some((entry) => entry.target === 'preview'),
      'blocked preview not logged',
    );
    const entry = test.bg.blockedEntries.find((entry) => entry.target === 'preview');
    expect(entry?.tweetId).toBe('3002');
    expect(article.hasAttribute('data-jev-hidden')).toBe(false);
    expect(test.bg.blockedEntries.some((entry) => entry.target === 'post')).toBe(false);

    // The logs page unblocks by writing an override — the preview restores.
    await browser.storage.local.set({ [`${STORAGE_KEYS.overrides}:3002`]: 'allow' });
    const card = article.querySelector('[data-testid="card.wrapper"]') as HTMLElement;
    await until(
      () => !card.hasAttribute('data-jev-card-hidden'),
      'preview stayed hidden after override',
    );
    await until(
      () => article.querySelector('[data-jev-card-link]') == null,
      'placeholder stayed after override',
    );

    stopRuntime(test);
  });
});
