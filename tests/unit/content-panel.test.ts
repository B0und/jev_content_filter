// Inspector panel regressions: Open logs must go through the background
// message (never a direct extension-URL navigation), Escape closes and
// restores focus, and scan errors are shown.
import { browser } from 'wxt/browser';
import { applySettingsChange } from '../../src/filtering/settings';
import { settings } from '../../src/content/state';
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
    const panelRoot = shadowRoot(panelHost);
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

    button.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    const scrollingPanel = document.querySelector('[data-jev-panel]');
    expect(scrollingPanel).not.toBeNull();
    scrollingPanel?.shadowRoot
      ?.querySelector('.panel')
      ?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, composed: true }));
    expect(scrollingPanel?.isConnected).toBe(true);
    window.dispatchEvent(new Event('scroll'));
    expect(document.querySelector('[data-jev-panel]')).toBeNull();

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
      () => shadowRoot(panelHost).querySelectorAll('.errors li').length > 0,
      'scan errors missing from panel',
    );
    const panelText = shadowRoot(panelHost).textContent ?? '';
    expect(panelText).toContain('gateway unreachable');
    expect(panelText).toContain('Text');

    stopRuntime(test);
  });
  it('hides disabled categories from the inspector panel', async () => {
    const configured = baseSettings();
    configured.enabled.drawings = false;
    configured.textFilters = [];
    configured.enabled.aiGenerated = false;
    const test = await startRuntime({
      enabled: configured.enabled,
      textFilters: configured.textFilters,
    });
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
      const rows = [...shadowRoot(panelHost).querySelectorAll('tr')].map(
        (row) => row.textContent?.trim() ?? '',
      );
      expect(rows.some((row) => row.includes('Porn'))).toBe(true);
      expect(rows.some((row) => row.includes('Drawings / anime'))).toBe(false);
      expect(rows.some((row) => row.includes('Content filter'))).toBe(false);
      expect(rows.some((row) => row.includes('AI-written text'))).toBe(false);
    } finally {
      stopRuntime(test);
    }
  });
  it('shows text categories before image categories', async () => {
    const configured = baseSettings();
    const test = await startRuntime({ enabled: configured.enabled });
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
      const groups = [...shadowRoot(panelHost).querySelectorAll('.group-label')].map((group) =>
        group.textContent?.trim(),
      );
      expect(groups).toEqual(['Text', 'Images']);
    } finally {
      stopRuntime(test);
    }
  });
});

it.each(['body text', ''])('shows custom preview scores separately with body %j', async (text) => {
  const configured = baseSettings();
  for (const key of Object.keys(configured.enabled) as Array<keyof typeof configured.enabled>)
    configured.enabled[key] = false;
  const test = await startRuntime({
    enabled: configured.enabled,
    textFilters: [
      { id: 'garden', name: 'Gardening', instructions: 'garden', threshold: 0.65, enabled: true },
    ],
  });
  try {
    test.bg.respond = (request) => ({
      ok: true,
      custom: { garden: request.text.includes('garden') ? 0.9 : 0.1 },
    });
    const article = buildTweetArticle({ id: '5900', text, previewText: 'garden preview' });
    test.handle.discover();
    await until(() => !!article.querySelector('[data-jev-card-hidden]'), 'preview was not hidden');
    iconButton(article).dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    const root = document.querySelector('[data-jev-panel]')?.shadowRoot;
    expect(root?.textContent).toContain('Preview 90.0%');
    const row = [...(root?.querySelectorAll('tr') ?? [])].find(
      (row) => row.cells[0]?.textContent === 'Gardening',
    );
    expect(row?.cells[1]?.textContent).toBe(text ? '10.0% · Preview 90.0%' : 'Preview 90.0%');
  } finally {
    stopRuntime(test);
    clearFeed();
  }
});

function shadowRoot(host: HTMLElement): ShadowRoot {
  const root = host.shadowRoot;
  if (!root) throw new Error('panel shadow root missing');
  return root;
}

async function untilValue<T>(read: () => T | null, message: string): Promise<T> {
  let value: T | null = null;
  await until(() => {
    const current = read();
    if (current === null) return false;
    value = current;
    return true;
  }, message);
  if (value === null) throw new Error(message);
  return value;
}

it('refreshes an open inspector after custom labels and thresholds change without rescanning', async () => {
  const configured = baseSettings();
  for (const key of Object.keys(configured.enabled) as Array<keyof typeof configured.enabled>)
    configured.enabled[key] = false;
  const filter = {
    id: 'garden',
    name: 'Gardening',
    instructions: 'garden',
    threshold: 0.65,
    enabled: true,
  };
  const test = await startRuntime({ enabled: configured.enabled, textFilters: [filter] });
  try {
    test.bg.respond = () => ({ ok: true, custom: { garden: 0.9 } });
    const article = buildTweetArticle({ id: '5902', text: 'garden' });
    test.handle.discover();
    await until(() => article.hasAttribute('data-jev-hidden'));
    iconButton(article).dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    const root = document.querySelector('[data-jev-panel]')?.shadowRoot;
    expect(root?.textContent).toContain('Gardening');
    await browser.storage.local.set({
      settings: applySettingsChange(settings.current, {
        field: 'textFilter',
        value: { ...filter, name: 'Renamed filter', threshold: 0.95 },
      }),
    });
    await until(() => !article.hasAttribute('data-jev-hidden'));
    expect(root?.textContent).toContain('Renamed filter');
    expect(root?.querySelector<HTMLInputElement>('[data-jev-cat="custom:garden"]')?.value).toBe(
      '95',
    );
    expect(root?.querySelector('.head')?.textContent).toBe('Allowed');
    expect(test.bg.jevCalls).toHaveLength(1);
  } finally {
    stopRuntime(test);
    clearFeed();
  }
});

it('preserves inspector threshold drafts until that saved threshold changes', async () => {
  const filter = {
    id: 'garden',
    name: 'Gardening',
    instructions: 'garden',
    threshold: 0.65,
    enabled: true,
  };
  const test = await startRuntime({ textFilters: [filter] });
  try {
    test.bg.respond = () => ({
      ok: true,
      custom: { garden: 0.1 },
    });
    const article = buildTweetArticle({ id: '5903', text: 'garden' });
    test.handle.discover();
    await until(() => aria(iconButton(article)).includes('Allowed'));
    iconButton(article).dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    const root = document.querySelector('[data-jev-panel]')?.shadowRoot;
    const threshold = () => root?.querySelector<HTMLInputElement>('[data-jev-cat="custom:garden"]');
    const input = threshold();
    if (!input) throw new Error('threshold input missing');
    input.focus();
    input.value = '42';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await browser.storage.local.set({
      settings: applySettingsChange(settings.current, {
        field: 'textFilter',
        value: { ...filter, name: 'Renamed filter' },
      }),
    });
    await until(() => !!root?.textContent?.includes('Renamed filter'));
    expect(threshold()?.value).toBe('42');
    expect(root?.activeElement).toBe(threshold());
    await browser.storage.local.set({
      settings: applySettingsChange(settings.current, {
        field: 'textFilter',
        value: { ...settings.current.textFilters[0]!, threshold: 0.75 },
      }),
    });
    await until(() => threshold()?.value === '75');
    expect(test.bg.jevCalls).toHaveLength(1);
  } finally {
    stopRuntime(test);
    clearFeed();
  }
});
