import { useEffect, useRef, useState } from 'react';
import { Switch } from '@base-ui-components/react/switch';
import { loadSettings, loadStatus, saveSettings } from '../../shared/settings';
import { CATEGORY_LABELS, IMAGE_KEYS, TEXT_KEYS, type CategoryKey, type Settings, type FilterStatus, type TabReport } from '../../shared/types';
import './popup.css';

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const current = useRef<Settings | null>(null);
  const writes = useRef(Promise.resolve());
  const [status, setStatus] = useState<FilterStatus | null>(null);
  const [report, setReport] = useState<TabReport | null>(null);
  const [missingScript, setMissingScript] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    let activeId: number | undefined;
    const refresh = async () => {
      if (activeId === undefined) return;
      try {
        const value = await browser.tabs.sendMessage(activeId, { type: 'get-report' }) as TabReport;
        if (alive) { setReport(value); setMissingScript(false); }
      } catch { if (alive) { setReport(null); setMissingScript(true); } }
    };
    const load = async () => {
      const value = await loadSettings();
      if (alive) { current.current = value; setSettings(value); }
    };
    void load().catch(e => setError(String(e)));
    void loadStatus().then(value => { if (alive) setStatus(value); });
    void browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
      activeId = tabs[0]?.id;
      void refresh();
    });
    const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area !== 'local') return;
      if (changes.settings) void writes.current.then(load);
      if (changes.filterStatus) setStatus(changes.filterStatus.newValue as FilterStatus);
      void refresh();
    };
    browser.storage.onChanged.addListener(listener);
    const interval = setInterval(refresh, 1500);
    return () => { alive = false; clearInterval(interval); browser.storage.onChanged.removeListener(listener); };
  }, []);

  function update(change: (value: Settings) => Settings) {
    if (!current.current) return;
    const next = change(current.current);
    current.current = next;
    setSettings(next);
    setError('');
    // Start each write immediately; closing a popup must not discard a debounce.
    writes.current = writes.current.then(() => saveSettings(next)).catch(e => setError(`Could not save: ${String(e)}`));
  }
  if (!settings) return <main className="popup">Loading settings…</main>;
  const health = !settings.masterEnabled ? 'Paused. Posts are not being filtered.'
    : missingScript ? 'No filter connected to this tab. Open X, or reload your X tab after updating the extension.'
    : !report ? 'Checking this tab…'
    : report.retrying ? `Retrying ${report.retrying} post${report.retrying === 1 ? '' : 's'}…`
    : report.failed ? `${report.failed} posts were not fully checked. See the error log.`
    : report.pending ? `Scanning ${report.pending} posts…`
    : report.analyzed ? 'Filtering this tab. Use the icon under any post to inspect it.'
    : 'Waiting for posts. No completed analysis yet.';

  return <main className="popup">
    <header className="popup-header">
      <h1>Jev Feed Filter</h1>
      <Switch.Root className="switch" aria-label="Enable filtering" checked={settings.masterEnabled}
        onCheckedChange={checked => update(value => ({ ...value, masterEnabled: checked }))}><Switch.Thumb className="thumb" /></Switch.Root>
    </header>
    <div className="popup-body">
      <p className={`status ${missingScript || report?.failed ? 'warning' : ''}`} role="status">{health}</p>
      <section aria-label="Image filters" className="categories">
        <h2 className="category-group-label">Images</h2>
        {IMAGE_KEYS.map(key => <Category key={key} category={key} settings={settings} update={update} />)}
      </section>
      <section aria-label="Text filters" className="categories">
        <h2 className="category-group-label">Text</h2>
        {TEXT_KEYS.map(key => <Category key={key} category={key} settings={settings} update={update} />)}
      </section>
      <p className="hint">Drawings includes ordinary anime and illustrations, not just sexual content.</p>
      <details className="diagnostics">
        <summary>API key &amp; scan details</summary>
        {report && <p>{report.pending} pending · {report.failed} incomplete<br />
          Last scan: {report.lastScannedAt ? new Date(report.lastScannedAt).toLocaleTimeString() : 'Not yet'}</p>}
        {status?.state === 'failing' && <p>Text checks are failing. Details in the error log. Local image filtering runs separately.</p>}
        <label className="key-field">AI Gateway API key
          <input type="password" value={settings.gatewayKey} autoComplete="off" placeholder="vck_…"
            onChange={event => update(value => ({ ...value, gatewayKey: event.target.value }))} />
        </label>
        <p>Text goes to the AI Gateway. Images are classified locally. No key means text is not checked.</p>
      </details>
      {error && <p role="alert" className="warning">{error}</p>}
      <button className="log-button" onClick={() => void browser.tabs.create({ url: browser.runtime.getURL('/logs.html') })}>Open logs</button>
    </div>
    <footer className="counters" aria-live="polite">
      <div><strong>{report?.analyzed ?? '—'}</strong> analyzed <span>/</span> <strong>{report?.blocked ?? '—'}</strong> blocked</div>
      <div>This tab, since page load</div>
    </footer>
  </main>;
}
function Category({ category: key, settings, update }: {
  category: CategoryKey; settings: Settings; update: (change: (value: Settings) => Settings) => void;
}) {
  const percent = Number((settings.thresholds[key] * 100).toFixed(1));
  const [draft, setDraft] = useState(String(percent));
  useEffect(() => setDraft(String(percent)), [percent]);
  const setPercent = (value: number) => update(settings => ({ ...settings, thresholds: { ...settings.thresholds, [key]: value / 100 } }));
  return <div className={`category ${settings.enabled[key] ? '' : 'disabled'}`}>
    <div className="category-label">
      <Switch.Root className="switch" aria-label={`Enable ${CATEGORY_LABELS[key]}`} checked={settings.enabled[key]}
        onCheckedChange={checked => update(settings => ({ ...settings, enabled: { ...settings.enabled, [key]: checked } }))}><Switch.Thumb className="thumb" /></Switch.Root>
      <span>{CATEGORY_LABELS[key]}</span>
    </div>
    <div className="threshold">
      <input type="range" min="0" max="100" step="0.1" value={percent} disabled={!settings.enabled[key]}
        aria-label={`${CATEGORY_LABELS[key]} threshold`} onChange={event => setPercent(event.target.valueAsNumber)} />
      <input type="number" min="0" max="100" step="0.1" value={draft} disabled={!settings.enabled[key]}
        aria-label={`${CATEGORY_LABELS[key]} threshold percent`}
        onChange={event => { setDraft(event.target.value); if (event.target.validity.valid && event.target.value !== '') setPercent(event.target.valueAsNumber); }}
        onBlur={() => setDraft(String(percent))} /><span>%</span>
    </div>
  </div>;
}
