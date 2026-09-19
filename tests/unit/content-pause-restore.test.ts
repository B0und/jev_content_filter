// Focused regression: pausing must restore what the filter hid — both the
// classified post and its blocked link preview. Driven through the runtime
// lifecycle with WXT fake storage and mocked classifier responses.
import { afterEach, describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';
import { STORAGE_KEYS, type Settings } from '../../src/shared/types';
import {
  baseSettings,
  buildTweetArticle,
  clearFeed,
  startRuntime,
  stopRuntime,
  until,
} from './support';

describe('pause restore', () => {
  afterEach(() => {
    clearFeed();
  });

  it('unhides a classified post and its blocked link preview when filtering is paused', async () => {
    const test = await startRuntime();
    try {
      test.bg.respond = () => ({ ok: true, sexual: 0.9, ai: 0.01 });
      const article = buildTweetArticle({
        id: '1001',
        text: 'explicit text content',
        previewText: 'preview page about explicit things',
      });
      test.handle.discover();

      await until(
        () => article.hasAttribute('data-jev-hidden'),
        'post was not hidden after classification',
      );
      const card = article.querySelector('[data-testid="card.wrapper"]') as HTMLElement;
      await until(() => card.hasAttribute('data-jev-card-hidden'), 'link preview was not hidden');
      await until(
        () => article.querySelector('[data-jev-card-link]') != null,
        'card link placeholder missing',
      );
      const postBlocked = test.bg.blockedEntries.filter((entry) => entry.target === 'post');
      expect(postBlocked).toHaveLength(1);

      // Pause through the settings channel, like the popup does.
      const paused: Settings = baseSettings({ masterEnabled: false });
      await browser.storage.local.set({ [STORAGE_KEYS.settings]: paused });

      await until(
        () => !article.hasAttribute('data-jev-hidden'),
        'post stayed hidden while paused',
      );
      await until(
        () => !card.hasAttribute('data-jev-card-hidden'),
        'preview stayed hidden while paused',
      );
      await until(
        () => article.querySelector('[data-jev-card-link]') == null,
        'card link placeholder stayed',
      );
      await until(
        () => article.querySelector('[data-jev-host]') == null,
        'filter UI stayed while paused',
      );
      expect(test.handle.report().blocked).toBe(0);
    } finally {
      stopRuntime(test);
    }
  });
});
