import {
  STORAGE_KEYS,
  defaultSettings,
  type FilterStatus,
  CATEGORY_KEYS,
  type CategoryKey,
  type Settings,
} from './types';

const DEV_KEY = import.meta.env.VITE_AI_GATEWAY_KEY as string | undefined;

export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(STORAGE_KEYS.settings);
  const saved = (stored[STORAGE_KEYS.settings] as (Partial<Settings> & {
    sliders?: Partial<Record<CategoryKey, number>>;
  }) | undefined) ?? {};
  const defaults = defaultSettings();
  const thresholds = { ...defaults.thresholds };
  for (const key of CATEGORY_KEYS) {
    const legacy = saved.sliders?.[key];
    const value = saved.thresholds?.[key] ??
      (typeof legacy === 'number' ? 0.95 - Math.min(100, Math.max(0, legacy)) * 0.005 : defaults.thresholds[key]);
    thresholds[key] = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : defaults.thresholds[key];
  }
  return {
    masterEnabled: saved.masterEnabled ?? defaults.masterEnabled,
    gatewayKey: saved.gatewayKey ?? DEV_KEY ?? defaults.gatewayKey,
    enabled: { ...defaults.enabled, ...saved.enabled },
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
