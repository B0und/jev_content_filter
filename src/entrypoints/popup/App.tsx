import { useEffect, useState } from 'react';
import { Field } from '@base-ui-components/react/field';
import { Input } from '@base-ui-components/react/input';
import { Slider } from '@base-ui-components/react/slider';
import { Switch } from '@base-ui-components/react/switch';
import { loadSettings, loadStatus, saveSettings } from '../../shared/settings';
import {
  CATEGORY_LABELS,
  type CategoryKey,
  type FilterStatus,
  type Settings,
} from '../../shared/types';
import './popup.css';

const CATEGORY_ORDER: CategoryKey[] = [
  'porn',
  'hentai',
  'sexy',
  'drawings',
  'sexualText',
  'aiGenerated',
];

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<FilterStatus | null>(null);

  useEffect(() => {
    void (async () => {
      setSettings(await loadSettings());
      setStatus(await loadStatus());
    })();
  }, []);

  async function update(patch: Partial<Settings>): Promise<void> {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    await saveSettings(next);
  }

  if (!settings) {
    return <div className="popup">Loading…</div>;
  }

  return (
    <div className="popup">
      <header className="popup-header">
        <h1>Jev Feed Filter</h1>
        <Switch.Root
          checked={settings.masterEnabled}
          onCheckedChange={(checked) => update({ masterEnabled: checked })}
        >
          <Switch.Thumb />
        </Switch.Root>
      </header>

      <p className={`status ${status?.state === 'failing' ? 'status-failing' : 'status-ok'}`}>
        {status?.state === 'failing'
          ? `Filter offline: ${status.reason ?? 'unknown error'} — showing everything`
          : 'Connected — filtering active'}
      </p>

      <div className="sliders">
        {CATEGORY_ORDER.map((key) => (
          <label className="slider-row" key={key}>
            <span className="slider-label">{CATEGORY_LABELS[key]}</span>
            <Slider.Root
              value={settings.sliders[key]}
              onValueChange={(value) =>
                update({ sliders: { ...settings.sliders, [key]: value as number } })
              }
            >
              <Slider.Control>
                <Slider.Track>
                  <Slider.Indicator />
                  <Slider.Thumb />
                </Slider.Track>
              </Slider.Control>
            </Slider.Root>
            <span className="slider-value">{settings.sliders[key]}</span>
          </label>
        ))}
      </div>

      <Field.Root className="key-field">
        <Field.Label>AI Gateway API key</Field.Label>
        <Input
          type="password"
          value={settings.gatewayKey}
          onChange={(event) => update({ gatewayKey: (event.target as HTMLInputElement).value })}
          placeholder="vck_…"
        />
      </Field.Root>

      <a href="/logs.html" target="_blank" rel="noreferrer" className="logs-link">
        Open blocked log
      </a>
    </div>
  );
}
