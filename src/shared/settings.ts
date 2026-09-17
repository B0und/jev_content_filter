import {
  STORAGE_KEYS,
  defaultSettings,
  type FilterStatus,
  type Settings,
} from './types';

const DEV_KEY = import.meta.env.VITE_AI_GATEWAY_KEY as string | undefined;

export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(STORAGE_KEYS.settings);
  const saved = (stored[STORAGE_KEYS.settings] as Partial<Settings> | undefined) ?? {};
  const defaults = defaultSettings();
  return {
    masterEnabled: saved.masterEnabled ?? defaults.masterEnabled,
    gatewayKey: saved.gatewayKey || DEV_KEY || defaults.gatewayKey,
    sliders: { ...defaults.sliders, ...saved.sliders },
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
