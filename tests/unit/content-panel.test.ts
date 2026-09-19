// Inspector panel regressions: Open logs must go through the background
// message (never a direct extension-URL navigation), Escape closes and
// restores focus, and scan errors are shown.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearFeed,
  buildTweetArticle,
  iconButton,
  startRuntime,
  stopRuntime,
  until,
  aria,
  baseSettings,
} from './support';

describe('inspector panel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearFeed();
  });

  it('opens on click, opens logs via background message, closes on Escape with focus back on the button', async () => {
    const test = await startRuntime();
    const article = buildTweetArticle({ id: '5001', text: 'clean text' });
    test.handle.discover();
    await until(() => aria(iconButton(article)).includes('Allowed'), 'button not ready');

    const button = iconButton(article);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    const panelHost = await untilValue(
      () => document.querySelector<HTMLElement>('[data-jev-panel]'),
      'panel did not open',
    );
    const panelRoot = panelHost.shadowRoot as ShadowRoot;
    const logsLink = panelRoot.querySelector('a');
    expect(logsLink?.textContent).toBe('Open logs');

    // Clicking the link must ask the background to open the page — a page
    // context cannot navigate to a chrome-extension:// URL itself.
    logsLink?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }),
    );
    await until(() => test.bg.openLogs.length === 1, 'open-logs message not sent');
    expect(test.bg.openLogs[0]?.errors).toBe(false);

    // Escape dismisses and hands focus back to the icon button.
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }),
    );
    await until(
      () => document.querySelector('[data-jev-panel]') == null,
      'Escape did not close the panel',
    );
    const host = article.querySelector<HTMLElement>('[data-jev-host]');
    expect(document.activeElement === host || host?.shadowRoot?.activeElement === button).toBe(
      true,
    );

    // Outside click also dismisses.
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    const reopened = await untilValue(
      () => document.querySelector<HTMLElement>('[data-jev-panel]'),
      'panel did not reopen',
    );
    const outside = document.createElement('div');
    document.body.append(outside);
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    await until(() => !reopened.isConnected, 'outside click did not close the panel');

    stopRuntime(test);
  });

  it('shows scan errors and preview reasons in the panel', async () => {
    const test = await startRuntime();
    const article = buildTweetArticle({ id: '5002', text: 'some text' });
    test.bg.respond = () => ({ ok: false, error: 'gateway unreachable' });
    test.handle.discover();
    await until(
      () =>
        aria(iconButton(article)).includes('Not fully checked') ||
        aria(iconButton(article)).includes('Retry'),
      'failure state not shown',
    );

    iconButton(article).dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    const panelHost = await untilValue(
      () => document.querySelector<HTMLElement>('[data-jev-panel]'),
      'panel did not open',
    );
    await until(
      () => (panelHost.shadowRoot as ShadowRoot).querySelectorAll('.errors li').length > 0,
      'scan errors missing from panel',
    );
    const panelText = (panelHost.shadowRoot as ShadowRoot).textContent ?? '';
    expect(panelText).toContain('gateway unreachable');
    expect(panelText).toContain('Text');

    stopRuntime(test);
  });
  it('hides disabled categories from the inspector panel', async () => {
    const configured = baseSettings();
    configured.enabled.drawings = false;
    configured.enabled.sexualText = false;
    configured.enabled.aiGenerated = false;
    const test = await startRuntime({ enabled: configured.enabled });
    try {
      const article = buildTweetArticle({
        id: '5003',
        text: 'clean text',
        images: ['https://pbs.twimg.com/media/landscape.png'],
      });
      test.handle.discover();
      await until(() => aria(iconButton(article)).includes('Allowed'), 'button not ready');

      iconButton(article).dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
      const panelHost = await untilValue(
        () => document.querySelector<HTMLElement>('[data-jev-panel]'),
        'panel did not open',
      );
      const rows = [...(panelHost.shadowRoot as ShadowRoot).querySelectorAll('tr')].map(
        (row) => row.textContent?.trim() ?? '',
      );
      expect(rows.some((row) => row.includes('Porn'))).toBe(true);
      expect(rows.some((row) => row.includes('Drawings / anime'))).toBe(false);
      expect(rows.some((row) => row.includes('Sexual text'))).toBe(false);
      expect(rows.some((row) => row.includes('AI-written text'))).toBe(false);
    } finally {
      stopRuntime(test);
    }
  });
  it('shows text categories before image categories', async () => {
    const test = await startRuntime();
    try {
      const article = buildTweetArticle({
        id: '5004',
        text: 'clean text',
        images: ['https://pbs.twimg.com/media/landscape.png'],
      });
      test.handle.discover();
      await until(() => aria(iconButton(article)).includes('Allowed'), 'button not ready');

      iconButton(article).dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
      const panelHost = await untilValue(
        () => document.querySelector<HTMLElement>('[data-jev-panel]'),
        'panel did not open',
      );
      const groups = [...(panelHost.shadowRoot as ShadowRoot).querySelectorAll('.group-label')].map(
        (group) => group.textContent?.trim(),
      );
      expect(groups).toEqual(['Text', 'Images']);
    } finally {
      stopRuntime(test);
    }
  });
});

async function untilValue<T>(read: () => T | null, message: string): Promise<T> {
  let value: T | null = null;
  await until(() => (value = read()) != null, message);
  return value as T;
}
