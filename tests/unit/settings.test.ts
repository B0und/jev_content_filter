// Regression tests for settings normalization at the load seam. Tests use the
// real storage seam (fakeBrowser.storage.local) and the public loadSettings /
// saveSettings API. Dynamic imports below are intentional module-loading
// boundary tests: the module must be re-evaluated per test because
// import.meta.env (dev-key fallback) is read at module scope and
// vi.stubEnv only affects subsequently evaluated modules.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

async function importSettings() {
  const mod = await import('../../src/shared/settings');
  return mod;
}

async function loadWithStored(stored: Record<string, unknown>) {
  await fakeBrowser.storage.local.set(stored);
  const { loadSettings } = await importSettings();
  return loadSettings();
}

beforeEach(() => {
  fakeBrowser.reset();
  vi.resetModules();
  // Placeholder only: ensures tests never observe a real key from .env files.
  vi.stubEnv('VITE_AI_GATEWAY_KEY', 'test-only-not-secret');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadSettings normalization', () => {
  it('returns defaults for empty storage', async () => {
    const { loadSettings } = await importSettings();
    const loaded = await loadSettings();
    // Light contract only: no full-defaults equality pin. The real contracts
    // under test are secret absence and corruption normalization below.
    expect(loaded.gatewayKey).toBe('');
    expect(loaded.textProvider).toBe('vercel');
    expect(loaded.thresholds.porn).toBeCloseTo(0.6, 12);
    expect(loaded.enabled.porn).toBe(true);
  });

  it('never falls back to the VITE_AI_GATEWAY_KEY secret', async () => {
    vi.stubEnv('VITE_AI_GATEWAY_KEY', 'sk-secret-leak');
    const stored = await loadWithStored({});
    expect(stored.gatewayKey).toBe('');
  });

  it('normalizes corrupt stored values to safe defaults', async () => {
    const loaded = await loadWithStored({
      settings: {
        masterEnabled: 'yes',
        gatewayKey: 12345,
        textProvider: 'unsupported',
        enabled: { porn: 'true', hentai: 0 },
        thresholds: { porn: '0.2', hentai: Number.NaN },
      },
    });
    expect(loaded.masterEnabled).toBe(true);
    expect(loaded.textProvider).toBe('vercel');
    expect(loaded.gatewayKey).toBe('');
    expect(loaded.enabled.porn).toBe(true);
    expect(loaded.enabled.hentai).toBe(true);
    expect(loaded.thresholds.porn).toBe(0.6);
    expect(loaded.thresholds.hentai).toBe(0.6);
  });

  it('keeps valid stored values and clamps thresholds to 0..1', async () => {
    const loaded = await loadWithStored({
      settings: {
        masterEnabled: false,
        gatewayKey: 'user-key',
        textProvider: 'typesafe',
        enabled: { porn: false },
        thresholds: { porn: 5, hentai: -0.2, sexy: 0.9 },
      },
    });
    expect(loaded.masterEnabled).toBe(false);
    expect(loaded.textProvider).toBe('typesafe');
    expect(loaded.gatewayKey).toBe('user-key');
    expect(loaded.enabled).toEqual({
      porn: false,
      hentai: true,
      sexy: true,
      drawings: true,
      sexualText: true,
      aiGenerated: true,
    });
    expect(loaded.thresholds.porn).toBe(1);
    expect(loaded.thresholds.hentai).toBe(0);
    expect(loaded.thresholds.sexy).toBe(0.9);
  });

  it('retains the legacy sliders migration for pre-existing stored data', async () => {
    const loaded = await loadWithStored({
      settings: { sliders: { porn: 0, sexy: 100 } },
    });
    // Slider 0 → threshold 0.95: scores must be extremely high, so almost
    // nothing is blocked. Slider 100 → threshold 0.45: the lower cutoff
    // blocks more.
    expect(loaded.thresholds.porn).toBeCloseTo(0.95, 12);
    expect(loaded.thresholds.sexy).toBeCloseTo(0.45, 12);
  });

  it('prefers modern thresholds over legacy sliders', async () => {
    const loaded = await loadWithStored({
      settings: { sliders: { porn: 0 }, thresholds: { porn: 0.7 } },
    });
    expect(loaded.thresholds.porn).toBe(0.7);
  });
});

describe('saveSettings round trip', () => {
  it('stores settings that load back intact', async () => {
    const { loadSettings, saveSettings } = await importSettings();
    const next = {
      masterEnabled: false,
      textProvider: 'openrouter' as const,
      gatewayKey: 'abc',
      enabled: {
        porn: false,
        hentai: true,
        sexy: true,
        drawings: true,
        sexualText: true,
        aiGenerated: false,
      },
      thresholds: {
        porn: 0.5,
        hentai: 0.6,
        sexy: 0.65,
        drawings: 0.7,
        sexualText: 0.65,
        aiGenerated: 0.65,
      },
    };
    await saveSettings(next);
    await expect(loadSettings()).resolves.toEqual(next);
  });
});
