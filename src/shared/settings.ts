import { browser } from 'wxt/browser';
import {
  STORAGE_KEYS,
  defaultSettings,
  type FilterStatus,
  CATEGORY_KEYS,
  isTextProvider,
  TEXT_PROVIDERS,
  type CategoryKey,
  type Settings,
  type SettingsChange,
  type SettingsReply,
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
  const value: unknown = stored[STORAGE_KEYS.settings];
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Partial<Settings> & {
    gatewayKey?: unknown;
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
  const providerKeys = { ...defaults.providerKeys };
  for (const provider of TEXT_PROVIDERS) {
    const key = raw.providerKeys?.[provider];
    if (typeof key === 'string') providerKeys[provider] = key;
  }
  // Historical storage had one key associated with the selected provider.
  // Never copy it to any other provider, and never override a modern map.
  if (raw.providerKeys === undefined && typeof raw.gatewayKey === 'string') {
    providerKeys[textProvider] = raw.gatewayKey;
  }

  return {
    masterEnabled:
      typeof raw.masterEnabled === 'boolean' ? raw.masterEnabled : defaults.masterEnabled,
    textProvider,
    providerKeys,
    textConfigRevision:
      typeof raw.textConfigRevision === 'number' &&
      Number.isSafeInteger(raw.textConfigRevision) &&
      raw.textConfigRevision >= 0
        ? raw.textConfigRevision
        : 0,
    enabled,
    thresholds,
  };
}

export function applySettingsChange(current: Settings, change: SettingsChange): Settings {
  const next = { ...current };
  switch (change.field) {
    case 'masterEnabled':
      if (typeof change.value !== 'boolean') throw new Error('Invalid filtering setting.');
      next.masterEnabled = change.value;
      break;
    case 'textProvider':
      if (!isTextProvider(change.value)) throw new Error('Invalid text provider.');
      next.textProvider = change.value;
      break;
    case 'providerKey':
      if (!isTextProvider(change.provider) || typeof change.value !== 'string')
        throw new Error('Invalid provider credential.');
      next.providerKeys = { ...current.providerKeys, [change.provider]: change.value };
      break;
    case 'enabled':
      if (!CATEGORY_KEYS.includes(change.category) || typeof change.value !== 'boolean')
        throw new Error('Invalid category setting.');
      next.enabled = { ...current.enabled, [change.category]: change.value };
      break;
    case 'threshold':
      if (
        !CATEGORY_KEYS.includes(change.category) ||
        !Number.isFinite(change.value) ||
        change.value < 0 ||
        change.value > 1
      )
        throw new Error('Invalid category threshold.');
      next.thresholds = { ...current.thresholds, [change.category]: change.value };
      break;
    default:
      throw new Error('Unknown settings field.');
  }
  if (
    next.textProvider !== current.textProvider ||
    next.providerKeys[next.textProvider] !== current.providerKeys[current.textProvider]
  )
    next.textConfigRevision++;
  return next;
}

/** The worker owns read-modify-write, even when the originating popup closes. */
export async function updateSettings(change: SettingsChange): Promise<Settings> {
  const reply = (await browser.runtime.sendMessage({
    type: 'update-settings',
    change,
  })) as SettingsReply;
  if (!reply?.ok) throw new Error(reply?.error ?? 'No settings response.');
  return reply.settings;
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
