import { browser } from 'wxt/browser';
import {
  STORAGE_KEYS,
  defaultSettings,
  type FilterStatus,
  CATEGORY_KEYS,
  isTextProvider,
  type CategoryKey,
  type Settings,
} from './types';

/**
 * Settings stored by older versions carried slider positions 0..100 per
 * category. Historical stored data may still use them; they map to modern
 * thresholds as 0.95 - slider * 0.005 (slider 100 → cutoff 0.45, which blocks
 * more; slider 0 → 0.95, which blocks almost nothing).
 */
function thresholdFromLegacySlider(slider: unknown): number | undefined {
  if (typeof slider !== 'number' || !Number.isFinite(slider)) return undefined;
  return 0.95 - Math.min(100, Math.max(0, slider)) * 0.005;
}

/**
 * Normalize whatever earlier versions may have persisted into a Settings
 * object with correct types. Storage is user-writable and this seam is the
 * only place untrusted values are read, so every field is validated here —
 * never fall back to build-time env data (a gateway key is a user secret).
 */
export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(STORAGE_KEYS.settings);
  const raw = (stored[STORAGE_KEYS.settings] ?? {}) as Partial<Settings> & {
    sliders?: Partial<Record<CategoryKey, number>>;
  };
  const defaults = defaultSettings();

  const enabled = {} as Record<CategoryKey, boolean>;
  const thresholds = {} as Record<CategoryKey, number>;
  for (const key of CATEGORY_KEYS) {
    const storedEnabled = raw.enabled?.[key];
    enabled[key] = typeof storedEnabled === 'boolean' ? storedEnabled : defaults.enabled[key];
    // A non-finite stored threshold (corrupt or wrong type) falls back to the
    // legacy slider when one exists, then to the default; every value is
    // clamped to 0..1.
    const storedThreshold = raw.thresholds?.[key];
    const candidate =
      storedThreshold === undefined
        ? thresholdFromLegacySlider(raw.sliders?.[key])
        : storedThreshold;
    thresholds[key] =
      typeof candidate === 'number' && Number.isFinite(candidate)
        ? Math.min(1, Math.max(0, candidate))
        : defaults.thresholds[key];
  }
  const textProvider = isTextProvider(raw.textProvider) ? raw.textProvider : defaults.textProvider;

  return {
    masterEnabled:
      typeof raw.masterEnabled === 'boolean' ? raw.masterEnabled : defaults.masterEnabled,
    textProvider,
    // The API key comes only from stored user settings — never from env. Read
    // gatewayKey for one release so existing Vercel users migrate in place.
    gatewayKey: typeof raw.gatewayKey === 'string' ? raw.gatewayKey : defaults.gatewayKey,
    enabled,
    thresholds,
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.settings]: settings });
}

export async function loadStatus(): Promise<FilterStatus> {
  const stored = await browser.storage.local.get(STORAGE_KEYS.status);
  return (
    (stored[STORAGE_KEYS.status] as FilterStatus | undefined) ?? {
      state: 'ok',
      updatedAt: 0,
    }
  );
}

export async function saveStatus(status: FilterStatus): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.status]: status });
}
