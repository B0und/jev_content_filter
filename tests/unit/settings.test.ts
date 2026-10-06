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
    expect(typeof loaded.masterEnabled).toBe('boolean');
    expect(typeof loaded.enabled.porn).toBe('boolean');
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
    expect(disabled.textFilters[1]).toEqual(restored.textFilters[1]);
    expect(disabled.textConfigRevision).toBe(3);
    expect(
      applySettingsChange(disabled, { field: 'deleteTextFilter', id: filter.id }).textFilters,
    ).toEqual([restored.textFilters[1]]);
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
