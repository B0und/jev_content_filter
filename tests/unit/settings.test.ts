import { Effect } from 'effect';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { applySettingsChange, loadSettings } from '../../src/filtering/settings';
import { defaultSettings } from '../../src/filtering/types';

beforeEach(() => {
  fakeBrowser.reset();
  vi.stubEnv('VITE_AI_GATEWAY_KEY', 'synthetic-build-secret');
});

afterEach(() => vi.unstubAllEnvs());

describe('settings storage normalization', () => {
  it('seeds the preset as ordinary editable initial data and never restores a deleted preset', async () => {
    const initial = await Effect.runPromise(loadSettings());
    expect(initial.textFilters).toEqual(defaultSettings().textFilters);
    const preset = initial.textFilters[0]!;

    const edited = applySettingsChange(initial, {
      field: 'textFilter',
      value: { ...preset, name: 'Sports', instructions: 'Sports results', threshold: 0.4 },
    });

    await fakeBrowser.storage.local.set({ settings: edited });
    expect((await Effect.runPromise(loadSettings())).textFilters).toEqual(edited.textFilters);
    await fakeBrowser.storage.local.set({
      settings: applySettingsChange(edited, { field: 'deleteTextFilter', id: preset.id }),
    });
    expect((await Effect.runPromise(loadSettings())).textFilters).toEqual([]);
  });

  it('restores stored rules without adding presets and ignores unknown category keys', async () => {
    const rules = Array.from({ length: 20 }, (_, index) => ({
      id: `rule-${index}`,
      name: `Rule ${index}`,
      instructions: `Topic ${index}`,
      enabled: true,
      threshold: 0.5,
    }));

    await fakeBrowser.storage.local.set({
      settings: {
        enabled: { unknownCategory: false },
        thresholds: { unknownCategory: 0.37 },
        textFilters: rules,
      },
    });
    const migrated = await Effect.runPromise(loadSettings());
    expect(migrated.textFilters).toEqual(rules);
    expect(migrated.enabled).not.toHaveProperty('unknownCategory');
    expect(migrated.thresholds).not.toHaveProperty('unknownCategory');
    await fakeBrowser.storage.local.set({ settings: migrated });
    expect((await Effect.runPromise(loadSettings())).textFilters).toEqual(migrated.textFilters);
  });

  it('does not enable remote text filters when saved settings have no filter list', async () => {
    await fakeBrowser.storage.local.set({
      settings: {
        enabled: { unknownCategory: false },
        textProvider: 'vercel',
        providerKeys: { vercel: 'synthetic-saved-key', typesafe: '', openrouter: '' },
      },
    });
    const loaded = await Effect.runPromise(loadSettings());
    expect(loaded.textFilters).toEqual([]);
    expect(loaded.providerKeys.vercel).toBe('synthetic-saved-key');
    await fakeBrowser.storage.local.set({ settings: loaded });
    expect((await Effect.runPromise(loadSettings())).textFilters).toEqual([]);
  });

  it('does not obtain credentials from build-time environment values', async () => {
    const loaded = await Effect.runPromise(loadSettings());
    expect(Object.values(loaded.providerKeys)).toEqual(['', '', '']);
  });

  it('migrates a historical key only to its selected provider', async () => {
    await fakeBrowser.storage.local.set({
      settings: { textProvider: 'typesafe', gatewayKey: 'synthetic-typesafe-key' },
    });
    const loaded = await Effect.runPromise(loadSettings());
    expect(loaded.providerKeys).toEqual({
      vercel: '',
      typesafe: 'synthetic-typesafe-key',
      openrouter: '',
    });
    expect('gatewayKey' in loaded).toBe(false);
  });

  it('never restores a historical key over an explicitly empty modern map', async () => {
    await fakeBrowser.storage.local.set({
      settings: { gatewayKey: 'revoked-key', providerKeys: { vercel: '', typesafe: 123 } },
    });
    expect(Object.values((await Effect.runPromise(loadSettings())).providerKeys)).toEqual([
      '',
      '',
      '',
    ]);
  });

  it('normalizes corrupt credentials, revisions and category settings', async () => {
    await fakeBrowser.storage.local.set({
      settings: {
        masterEnabled: 'yes',
        textProvider: 'unsupported',
        textConfigRevision: -5,
        providerKeys: { vercel: 123, typesafe: null },
        enabled: { porn: 'true', hentai: 0 },
        thresholds: { porn: '0.2', hentai: Number.NaN },
      },
    });
    const loaded = await Effect.runPromise(loadSettings());
    expect(Object.values(loaded.providerKeys)).toEqual(['', '', '']);
    expect(loaded.textConfigRevision).toBe(0);
    expect(loaded.masterEnabled).toEqual(expect.any(Boolean));
    expect(loaded.enabled.porn).toEqual(expect.any(Boolean));
    expect(Number.isFinite(loaded.thresholds.hentai)).toBe(true);
  });

  it('clamps stored thresholds and migrates legacy sliders without overriding modern cutoffs', async () => {
    await fakeBrowser.storage.local.set({
      settings: {
        thresholds: { porn: 5, hentai: -0.2, sexy: 0.7 },
        sliders: { sexy: 0, drawings: 100 },
      },
    });
    const loaded = await Effect.runPromise(loadSettings());
    expect(loaded.thresholds.porn).toBe(1);
    expect(loaded.thresholds.hentai).toBe(0);
    expect(loaded.thresholds.sexy).toBe(0.7);
    expect(loaded.thresholds.drawings).toBeCloseTo(0.45, 12);
  });
});

describe('field-level settings changes', () => {
  it('merges independent filter edits and never recreates a deleted filter', () => {
    const original = defaultSettings();
    const id = original.textFilters[0]!.id;

    const threshold = applySettingsChange(original, {
      field: 'patchTextFilter',
      id,
      value: { threshold: 0.4 },
    });

    const renamed = applySettingsChange(threshold, {
      field: 'patchTextFilter',
      id,
      value: { name: 'Renamed rule', instructions: 'Sports results' },
    });

    const toggled = applySettingsChange(renamed, {
      field: 'patchTextFilter',
      id,
      value: { enabled: false },
    });

    expect(toggled.textFilters[0]).toEqual({
      ...original.textFilters[0],
      name: 'Renamed rule',
      instructions: 'Sports results',
      threshold: 0.4,
      enabled: false,
    });
    const deleted = applySettingsChange(toggled, { field: 'deleteTextFilter', id });
    expect(
      applySettingsChange(deleted, {
        field: 'patchTextFilter',
        id,
        value: { threshold: 0.3 },
      }).textFilters,
    ).toEqual([]);
  });

  it('isolates provider credentials and changes revision only for active text configuration', () => {
    const original = defaultSettings();

    const vercel = applySettingsChange(original, {
      field: 'providerKey',
      provider: 'vercel',
      value: 'v-key',
    });

    const inactive = applySettingsChange(vercel, {
      field: 'providerKey',
      provider: 'typesafe',
      value: 't-key',
    });

    expect(inactive.textConfigRevision).toBe(vercel.textConfigRevision);
    const selected = applySettingsChange(inactive, { field: 'textProvider', value: 'typesafe' });
    expect(selected.providerKeys).toEqual({ vercel: 'v-key', typesafe: 't-key', openrouter: '' });
    expect(selected.textConfigRevision).toBe(vercel.textConfigRevision + 1);
    expect(original.providerKeys.vercel).toBe('');

    const threshold = applySettingsChange(selected, {
      field: 'threshold',
      category: 'porn',
      value: 0.2,
    });

    expect(threshold.textConfigRevision).toBe(selected.textConfigRevision);
  });

  it.each([-1, 1.1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid threshold %s',
    (value) => {
      expect(() =>
        applySettingsChange(defaultSettings(), { field: 'threshold', category: 'porn', value }),
      ).toThrow();
    },
  );
});

describe('custom text filters', () => {
  const filter = {
    id: 'garden',
    name: 'Gardening',
    instructions: 'Posts about gardening',
    enabled: true,
    threshold: 0.65,
  };

  it('persists independently named rules and restores them from storage', async () => {
    let settings = applySettingsChange(defaultSettings(), { field: 'textFilter', value: filter });
    settings = applySettingsChange(settings, {
      field: 'textFilter',
      value: { ...filter, id: 'news', name: 'News', instructions: 'Political news' },
    });
    await fakeBrowser.storage.local.set({ settings });
    const restored = await Effect.runPromise(loadSettings());
    expect(restored.textFilters).toEqual(settings.textFilters);
    expect(restored.textConfigRevision).toBe(2);

    const disabled = applySettingsChange(restored, {
      field: 'textFilter',
      value: { ...filter, enabled: false },
    });

    expect(disabled.textFilters[2]).toEqual(restored.textFilters[2]);
    expect(disabled.textConfigRevision).toBe(3);
    expect(
      applySettingsChange(disabled, { field: 'deleteTextFilter', id: filter.id }).textFilters,
    ).toEqual([restored.textFilters[0], restored.textFilters[2]]);
  });
  it('ignores corrupt and duplicate stored rules without losing valid ones', async () => {
    await fakeBrowser.storage.local.set({
      settings: {
        textFilters: [
          filter,
          { ...filter, name: 'Duplicate' },
          { ...filter, id: 'bad', threshold: 3 },
          { ...filter, id: '__proto__' },
        ],
      },
    });
    expect((await Effect.runPromise(loadSettings())).textFilters).toEqual([filter]);
  });
  it('rejects blank instructions and too many rules', () => {
    expect(() =>
      applySettingsChange(defaultSettings(), {
        field: 'textFilter',
        value: { ...filter, instructions: '  ' },
      }),
    ).toThrow();

    const settings = {
      ...defaultSettings(),
      textFilters: Array.from({ length: 20 }, (_, index) => ({ ...filter, id: `rule-${index}` })),
    };

    expect(() => applySettingsChange(settings, { field: 'textFilter', value: filter })).toThrow(
      '20',
    );
  });
});

it('persists case-normalized author exceptions, merges category edits and migrates old settings', async () => {
  await fakeBrowser.storage.local.set({ settings: { masterEnabled: true } });
  const migrated = await Effect.runPromise(loadSettings());
  expect(migrated.authorExceptions).toEqual([]);
  expect(migrated.skipFollowed).toBe(false);

  const first = applySettingsChange(migrated, {
    field: 'authorException',
    handle: 'Reader',
    category: 'hentai',
    value: true,
  });

  const second = applySettingsChange(first, {
    field: 'authorException',
    handle: 'READER',
    category: 'sexy',
    value: true,
  });

  await fakeBrowser.storage.local.set({ settings: second });
  const saved = await Effect.runPromise(loadSettings());
  expect(saved.authorExceptions).toEqual([{ handle: 'reader', categories: ['hentai', 'sexy'] }]);

  const removed = applySettingsChange(saved, {
    field: 'authorException',
    handle: 'reader',
    category: 'hentai',
    value: false,
  });

  expect(removed.authorExceptions).toEqual([{ handle: 'reader', categories: ['sexy'] }]);
  expect(
    applySettingsChange(removed, {
      field: 'authorException',
      handle: 'reader',
      category: 'sexy',
      value: false,
    }).authorExceptions,
  ).toEqual([]);
});

it('migrates followed-account selections to one persisted checkbox, with explicit false taking precedence', async () => {
  await fakeBrowser.storage.local.set({ settings: { followedExemptions: ['hentai'] } });
  const migrated = await Effect.runPromise(loadSettings());
  expect(migrated.skipFollowed).toBe(true);
  const disabled = applySettingsChange(migrated, { field: 'skipFollowed', value: false });
  await fakeBrowser.storage.local.set({
    settings: { ...disabled, followedExemptions: ['hentai'] },
  });
  expect((await Effect.runPromise(loadSettings())).skipFollowed).toBe(false);
});
