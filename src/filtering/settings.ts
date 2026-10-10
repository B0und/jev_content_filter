import { flow, Option, Predicate, Effect } from 'effect';
import * as Schema from 'effect/Schema';
import { BrowserError, browserEffect } from '../platform/browser';
import { browser } from 'wxt/browser';
import {
  AuthorExceptionSchema,
  AuthorHandleSchema,
  ScoreKeySchema,
  FilterStatusSchema,
  SettingsReplySchema,
  TextFilterSchema,
} from './schemas';
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
const thresholdFromLegacySlider = flow(
  Schema.decodeUnknownOption(Schema.Finite),
  Option.map((slider) => 0.95 - Math.min(100, Math.max(0, slider)) * 0.005),
  Option.getOrUndefined,
);

/**
 * Normalize whatever earlier versions may have persisted into a Settings
 * object with correct types. Storage is user-writable and this seam is the
 * only place untrusted values are read, so every field is validated here —
 * never fall back to build-time env data (a gateway key is a user secret).
 */
const storedRecord = Schema.Record(Schema.String, Schema.Unknown);

const isSettingsReply = Schema.is(SettingsReplySchema);

const isFilterStatus = Schema.is(FilterStatusSchema);

const asRecord = flow(
  Schema.decodeUnknownOption(storedRecord),
  Option.getOrElse((): typeof storedRecord.Type => ({})),
);

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
    enabled[key] = Schema.is(Schema.Boolean)(storedEnabled) ? storedEnabled : defaults.enabled[key];
    // A non-finite stored threshold (corrupt or wrong type) falls back to the
    // legacy slider when one exists, then to the default; every value is
    // clamped to 0..1.
    const storedThreshold = storedThresholds[key];

    const candidate =
      storedThreshold === undefined
        ? thresholdFromLegacySlider(storedSliders[key])
        : storedThreshold;

    thresholds[key] =
      Predicate.isNumber(candidate) && Number.isFinite(candidate)
        ? Math.min(1, Math.max(0, candidate))
        : defaults.thresholds[key];
  }

  const textProvider = isTextProvider(raw.textProvider) ? raw.textProvider : defaults.textProvider;
  const providerKeys = { ...defaults.providerKeys };

  for (const provider of TEXT_PROVIDERS) {
    const key = storedProviderKeys[provider];

    if (Schema.is(Schema.String)(key)) providerKeys[provider] = key;
  }

  // Historical storage had one key associated with the selected provider.
  // Never copy it to any other provider, and never override a modern map.
  if (raw.providerKeys === undefined && Schema.is(Schema.String)(raw.gatewayKey)) {
    providerKeys[textProvider] = raw.gatewayKey;
  }

  const initialFilters = stored[STORAGE_KEYS.settings] === undefined ? defaults.textFilters : [];

  const textFilters = Array.isArray(raw.textFilters)
    ? raw.textFilters
        .filter(Schema.is(TextFilterSchema))
        .filter((filter, index, all) => all.findIndex((other) => other.id === filter.id) === index)
    : initialFilters;

  return {
    authorExceptions: Array.isArray(raw.authorExceptions)
      ? raw.authorExceptions.filter(Schema.is(AuthorExceptionSchema)).map((entry) => ({
          ...entry,
          handle: entry.handle.toLowerCase(),
          categories: [...new Set(entry.categories)],
        }))
      : [],
    skipFollowed: Schema.is(Schema.Boolean)(raw.skipFollowed)
      ? raw.skipFollowed
      : Array.isArray(raw.followedExemptions) &&
        raw.followedExemptions.some(Schema.is(ScoreKeySchema)),
    textFilters,
    masterEnabled: Schema.is(Schema.Boolean)(raw.masterEnabled)
      ? raw.masterEnabled
      : defaults.masterEnabled,
    textProvider,
    providerKeys,
    textConfigRevision:
      Predicate.isNumber(raw.textConfigRevision) &&
      Number.isSafeInteger(raw.textConfigRevision) &&
      raw.textConfigRevision >= 0
        ? raw.textConfigRevision
        : 0,
    enabled,
    thresholds,
  };
});

/** Apply field-scoped edits, treating obsolete delayed threshold saves as no-ops. */
export function applySettingsChange(current: Settings, change: SettingsChange): Settings {
  const next = { ...current };

  switch (change.field) {
    case 'authorException': {
      if (
        !Schema.is(AuthorHandleSchema)(change.handle) ||
        !Schema.is(ScoreKeySchema)(change.category) ||
        !Schema.is(Schema.Boolean)(change.value)
      )
        throw new Error('Invalid author exception.');
      const handle = change.handle.toLowerCase();

      const categories = new Set(
        current.authorExceptions
          .filter((entry) => entry.handle === handle)
          .flatMap((entry) => entry.categories),
      );

      if (change.value) categories.add(change.category);
      else categories.delete(change.category);
      next.authorExceptions = current.authorExceptions.filter((entry) => entry.handle !== handle);

      if (categories.size) next.authorExceptions.push({ handle, categories: [...categories] });
      break;
    }

    case 'skipFollowed': {
      if (!Schema.is(Schema.Boolean)(change.value))
        throw new Error('Invalid followed-account preference.');
      next.skipFollowed = change.value;
      break;
    }

    case 'textFilter':
    case 'patchTextFilter': {
      let value;

      if (change.field === 'patchTextFilter') {
        const existing = current.textFilters.find((filter) => filter.id === change.id);

        // A delayed edit must never recreate a rule deleted in another view.
        if (!existing) return current;

        if (
          change.expectedThreshold !== undefined &&
          existing.threshold !== change.expectedThreshold
        )
          return current;
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
      if (!Schema.is(Schema.Boolean)(change.value)) throw new Error('Invalid filtering setting.');
      next.masterEnabled = change.value;
      break;
    case 'textProvider':
      if (!isTextProvider(change.value)) throw new Error('Invalid text provider.');
      next.textProvider = change.value;
      break;
    case 'providerKey':
      if (!isTextProvider(change.provider) || !Schema.is(Schema.String)(change.value))
        throw new Error('Invalid provider credential.');
      next.providerKeys = { ...current.providerKeys, [change.provider]: change.value };
      break;
    case 'enabled':
      if (!CATEGORY_KEYS.includes(change.category) || !Schema.is(Schema.Boolean)(change.value))
        throw new Error('Invalid category setting.');
      next.enabled = { ...current.enabled, [change.category]: change.value };
      break;
    case 'threshold':
      if (
        change.expectedThreshold !== undefined &&
        current.thresholds[change.category] !== change.expectedThreshold
      )
        return current;

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

/** Validate the worker receipt for a serialized settings write. */
const requestSettingsChange = Effect.fn('requestSettingsChange')(function* (
  change: SettingsChange,
) {
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

  return reply;
});

/** The worker owns read-modify-write, even when the originating popup closes. */
export const updateSettings = Effect.fn('updateSettings')(function* (change: SettingsChange) {
  return (yield* requestSettingsChange(change)).settings;
});

/** Return the exact filter removed inside the worker's write lock for reliable Undo. */
export const deleteTextFilter = Effect.fn('deleteTextFilter')(function* (id: string) {
  const reply = yield* requestSettingsChange({ field: 'deleteTextFilter', id });

  return { settings: reply.settings, filter: reply.deletedFilter };
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
