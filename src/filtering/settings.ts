import { Effect } from 'effect';
import * as Schema from 'effect/Schema';
import { BrowserError, browserEffect } from '../platform/browser';
import { browser } from 'wxt/browser';
import { FilterStatusSchema, SettingsReplySchema, TextFilterSchema } from './schemas';
import {
  STORAGE_KEYS,
  defaultSettings,
  textDecisionSignature,
  type FilterStatus,
  CATEGORY_KEYS,
  isTextProvider,
  TEXT_PROVIDERS,
  type Settings,
  type SettingsChange,
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
const storedRecord = Schema.Record(Schema.String, Schema.Unknown);
const isStoredRecord = Schema.is(storedRecord);
const isSettingsReply = Schema.is(SettingsReplySchema);
const isFilterStatus = Schema.is(FilterStatusSchema);
const asRecord = (value: unknown): Record<string, unknown> => (isStoredRecord(value) ? value : {});

export const loadSettings = Effect.fn('loadSettings')(function* () {
  const stored = yield* browserEffect('load settings', () =>
    browser.storage.local.get(STORAGE_KEYS.settings),
  );
  const raw = asRecord(stored[STORAGE_KEYS.settings]);
  const storedEnabledMap = asRecord(raw.enabled);
  const storedThresholds = asRecord(raw.thresholds);
  const storedSliders = asRecord(raw.sliders);
  const storedProviderKeys = asRecord(raw.providerKeys);
  const defaults = defaultSettings();

  const enabled = defaults.enabled;
  const thresholds = defaults.thresholds;
  for (const key of CATEGORY_KEYS) {
    const storedEnabled = storedEnabledMap[key];
    enabled[key] = typeof storedEnabled === 'boolean' ? storedEnabled : defaults.enabled[key];
    // A non-finite stored threshold (corrupt or wrong type) falls back to the
    // legacy slider when one exists, then to the default; every value is
    // clamped to 0..1.
    const storedThreshold = storedThresholds[key];
    const candidate =
      storedThreshold === undefined
        ? thresholdFromLegacySlider(storedSliders[key])
        : storedThreshold;
    thresholds[key] =
      typeof candidate === 'number' && Number.isFinite(candidate)
        ? Math.min(1, Math.max(0, candidate))
        : defaults.thresholds[key];
  }
  const textProvider = isTextProvider(raw.textProvider) ? raw.textProvider : defaults.textProvider;
  const providerKeys = { ...defaults.providerKeys };
  for (const provider of TEXT_PROVIDERS) {
    const key = storedProviderKeys[provider];
    if (typeof key === 'string') providerKeys[provider] = key;
  }
  // Historical storage had one key associated with the selected provider.
  // Never copy it to any other provider, and never override a modern map.
  if (raw.providerKeys === undefined && typeof raw.gatewayKey === 'string') {
    providerKeys[textProvider] = raw.gatewayKey;
  }

  const textFilters = Array.isArray(raw.textFilters)
    ? raw.textFilters
        .filter(Schema.is(TextFilterSchema))
        .filter((filter, index, all) => all.findIndex((other) => other.id === filter.id) === index)
    : defaults.textFilters;

  return {
    textFilters,
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
});

export function applySettingsChange(current: Settings, change: SettingsChange): Settings {
  const next = { ...current };
  switch (change.field) {
    case 'textFilter':
    case 'patchTextFilter': {
      let value;
      if (change.field === 'patchTextFilter') {
        const existing = current.textFilters.find((filter) => filter.id === change.id);
        // A delayed edit must never recreate a rule deleted in another view.
        if (!existing) return current;
        value = { ...existing, ...change.value };
      } else value = change.value;
      if (!Schema.is(TextFilterSchema)(value) || !value.name.trim() || !value.instructions.trim())
        throw new Error('Enter a filter name and instructions.');
      const filter = {
        ...value,
        name: value.name.trim(),
        instructions: value.instructions.trim(),
      };
      const exists = current.textFilters.some((item) => item.id === filter.id);
      if (!exists && current.textFilters.length >= 20)
        throw new Error('You can save up to 20 text filters.');
      next.textFilters = exists
        ? current.textFilters.map((item) => (item.id === filter.id ? filter : item))
        : [...current.textFilters, filter];
      break;
    }
    case 'deleteTextFilter':
      next.textFilters = current.textFilters.filter((item) => item.id !== change.id);
      break;
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
    textDecisionSignature(next.textFilters) !== textDecisionSignature(current.textFilters) ||
    next.textProvider !== current.textProvider ||
    next.providerKeys[next.textProvider] !== current.providerKeys[current.textProvider]
  )
    next.textConfigRevision++;
  return next;
}

/** The worker owns read-modify-write, even when the originating popup closes. */
export const updateSettings = Effect.fn('updateSettings')(function* (change: SettingsChange) {
  const reply: unknown = yield* browserEffect('update settings', () =>
    browser.runtime.sendMessage({ type: 'update-settings', change }),
  );
  if (!isSettingsReply(reply))
    return yield* new BrowserError({
      operation: 'update settings',
      cause: 'Invalid settings response.',
    });
  if (!reply.ok)
    return yield* new BrowserError({
      operation: 'update settings',
      cause: reply.error,
    });
  return reply.settings;
});

export const loadStatus = Effect.fn('loadStatus')(function* (): Effect.fn.Return<
  FilterStatus,
  BrowserError
> {
  const stored = yield* browserEffect('load status', () =>
    browser.storage.local.get(STORAGE_KEYS.status),
  );
  const status: unknown = stored[STORAGE_KEYS.status];
  return isFilterStatus(status) ? status : { state: 'ok', updatedAt: 0 };
});

export const saveStatus = (status: FilterStatus) =>
  browserEffect('save status', () => browser.storage.local.set({ [STORAGE_KEYS.status]: status }));
