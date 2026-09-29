import { useEffect, useRef, useState } from 'react';
import { Switch } from '@base-ui/react/switch';
import { browser } from 'wxt/browser';
import {
  applySettingsChange,
  loadSettings,
  loadStatus,
  updateSettings,
} from '../../shared/settings';
import {
  CATEGORY_LABELS,
  IMAGE_KEYS,
  TEXT_KEYS,
  TEXT_PROVIDER_LABELS,
  TEXT_PROVIDERS,
  isTextProvider,
  type CategoryKey,
  type Settings,
  type SettingsChange,
  type TextProvider,
  type FilterStatus,
  type TabReport,
} from '../../shared/types';
import './popup.css';

const PROVIDER_DETAILS: Record<
  TextProvider,
  { keyLabel: string; placeholder: string; description: string }
> = {
  vercel: {
    keyLabel: 'Vercel AI Gateway API key',
    placeholder: 'vck_…',
    description: 'Text goes to TypeSafe Jev through Vercel AI Gateway.',
  },
  typesafe: {
    keyLabel: 'TypeSafe API key',
    placeholder: 'Paste your TypeSafe key',
    description: "Text goes directly to TypeSafe's Jev Decisions API.",
  },
  openrouter: {
    keyLabel: 'OpenRouter API key',
    placeholder: 'Paste your OpenRouter key',
    description: "Text goes to TypeSafe Jev through OpenRouter's Decisions API.",
  },
};
export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [showGatewayKey, setShowGatewayKey] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  // Requests are sent immediately; the worker serializes mutations after popup close.
  const writes = useRef(Promise.resolve());
  const pendingWrites = useRef(0);
  const writeGeneration = useRef(0);
  const [status, setStatus] = useState<FilterStatus | null>(null);
  const [report, setReport] = useState<TabReport | null>(null);
  // sendMessage fails transiently while an X tab navigates; only report the
  // filter as disconnected after repeated failures, not the first blip.
  const [missingScript, setMissingScript] = useState(false);
  const probeFailures = useRef(0);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    let activeId: number | undefined;
    const refresh = async () => {
      if (activeId === undefined) return;
      try {
        const value = (await browser.tabs.sendMessage(activeId, {
          type: 'get-report',
        })) as TabReport;
        if (!alive) return;
        probeFailures.current = 0;
        setReport(value);
        setMissingScript(false);
      } catch {
        if (!alive) return;
        probeFailures.current += 1;
        if (probeFailures.current >= 2) {
          setReport(null);
          setMissingScript(true);
        }
      }
    };
    const load = async () => {
      const generation = writeGeneration.current;
      const value = await loadSettings();
      if (alive && !pendingWrites.current && generation === writeGeneration.current)
        setSettings(value);
    };
    load().catch(() => {
      if (alive) setLoadFailed(true);
    });
    loadStatus()
      .then((value) => {
        if (alive) setStatus(value);
      })
      .catch(() => {
        /* status stays unknown */
      });
    void browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      if (!alive) return;
      activeId = tabs[0]?.id;
      void refresh();
    });
    const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area !== 'local') return;
      if (changes.settings) {
        // Reconcile after our outstanding patches, without overwriting optimistic edits.
        void writes.current
          .then(() => load())
          .catch(() => {
            /* keep last known settings */
          });
      }
      if (changes.filterStatus) setStatus(changes.filterStatus.newValue as FilterStatus);
      void refresh();
    };
    browser.storage.onChanged.addListener(listener);
    const interval = setInterval(refresh, 1500);
    return () => {
      alive = false;
      clearInterval(interval);
      browser.storage.onChanged.removeListener(listener);
    };
  }, []);

  function update(change: SettingsChange) {
    writeGeneration.current++;
    setSettings((value) => (value ? applySettingsChange(value, change) : value));
    pendingWrites.current++;
    setSaving(true);
    const pending = updateSettings(change)
      .then(() => undefined)
      .catch((e) => {
        setError(`Could not save settings: ${String(e)}`);
      })
      .finally(() => {
        pendingWrites.current--;
        if (!pendingWrites.current) setSaving(false);
      });
    writes.current = Promise.all([writes.current, pending]).then(() => undefined);
  }
  if (!settings && loadFailed)
    return (
      <main className="popup">
        <p role="alert" className="warning">
          Could not load settings. Check that storage is available, then retry.
        </p>
        <button className="log-button" onClick={() => location.reload()}>
          Retry
        </button>
      </main>
    );
  if (!settings) return <main className="popup">Loading settings…</main>;
  const health = !settings.masterEnabled
    ? 'Paused. Posts are not being filtered.'
    : missingScript
      ? 'No filter connected to this tab. Open X, or reload your X tab after updating the extension.'
      : !report
        ? 'Checking this tab…'
        : report.retrying
          ? `Retrying ${report.retrying} post${report.retrying === 1 ? '' : 's'}…`
          : report.failed
            ? `${report.failed} posts were not fully checked. See the error log.`
            : report.pending
              ? `Scanning ${report.pending} posts…`
              : report.analyzed
                ? 'Filtering this tab. Use the icon under any post to inspect it.'
                : 'Waiting for posts. No completed analysis yet.';
  const providerDetails = PROVIDER_DETAILS[settings.textProvider];

  return (
    <main className="popup">
      <header className="popup-header">
        <h1>Jev Feed Filter</h1>
        <Switch.Root
          className="switch"
          aria-label="Enable filtering"
          checked={settings.masterEnabled}
          onCheckedChange={(checked) => update({ field: 'masterEnabled', value: checked })}
        >
          <Switch.Thumb className="thumb" />
        </Switch.Root>
      </header>
      <div className="popup-body">
        <output
          className={`status ${missingScript || report?.failed || status?.state === 'failing' ? 'warning' : ''}`}
        >
          {health}
        </output>
        {status?.state === 'failing' && (
          <p className="warning" role="alert">
            Text checks are failing. Details in the error log. Local image filtering runs
            separately.
          </p>
        )}
        {saving && <output className="hint">Saving…</output>}
        <section aria-label="Image filters" className="categories">
          <h2 className="category-group-label">Images</h2>
          {IMAGE_KEYS.map((key) => (
            <Category key={key} category={key} settings={settings} update={update} />
          ))}
        </section>
        <section aria-label="Text filters" className="categories">
          <h2 className="category-group-label">Text</h2>
          {TEXT_KEYS.map((key) => (
            <Category key={key} category={key} settings={settings} update={update} />
          ))}
        </section>
        <p className="hint">
          Drawings includes ordinary anime and illustrations, not just sexual content.
        </p>
        <details className="diagnostics">
          <summary>API key &amp; scan details</summary>
          {report && (
            <p>
              {report.pending} pending · {report.failed} incomplete
              <br />
              Last scan:{' '}
              {report.lastScannedAt
                ? new Date(report.lastScannedAt).toLocaleTimeString()
                : 'Not yet'}
            </p>
          )}
          <div className="provider-field">
            <label htmlFor="text-provider">Text provider</label>
            <select
              id="text-provider"
              value={settings.textProvider}
              onChange={(event) => {
                const provider = event.currentTarget.value;
                if (!isTextProvider(provider)) return;
                setShowGatewayKey(false);
                update({ field: 'textProvider', value: provider });
              }}
            >
              {TEXT_PROVIDERS.map((provider) => (
                <option key={provider} value={provider}>
                  {TEXT_PROVIDER_LABELS[provider]}
                </option>
              ))}
            </select>
          </div>
          <div className="key-field">
            <label htmlFor="gateway-key">{providerDetails.keyLabel}</label>
            <div className="key-input">
              <input
                id="gateway-key"
                type={showGatewayKey ? 'text' : 'password'}
                value={settings.providerKeys[settings.textProvider]}
                autoComplete="off"
                placeholder={providerDetails.placeholder}
                onChange={(event) =>
                  update({
                    field: 'providerKey',
                    provider: settings.textProvider,
                    value: event.target.value,
                  })
                }
              />
              <button
                type="button"
                className="key-visibility"
                aria-label={showGatewayKey ? 'Hide API key' : 'Show API key'}
                aria-pressed={showGatewayKey}
                title={showGatewayKey ? 'Hide API key' : 'Show API key'}
                onClick={() => setShowGatewayKey((visible) => !visible)}
              >
                <EyeIcon hidden={!showGatewayKey} />
              </button>
            </div>
          </div>
          <p>
            {providerDetails.description} Images are classified locally. No key means text is not
            checked.
          </p>
          <p className="hint">
            OpenCode Zen is not listed because its current catalog does not expose Jev&apos;s
            Decisions API.
          </p>
        </details>
        {error && (
          <p role="alert" className="warning">
            {error}
          </p>
        )}
        <button
          className="log-button"
          onClick={() => void browser.tabs.create({ url: browser.runtime.getURL('/logs.html') })}
        >
          Open logs
        </button>
      </div>
      <footer className="counters" aria-live="polite">
        <div>
          <strong>{report?.analyzed ?? '—'}</strong> analyzed <span>/</span>{' '}
          <strong>{report?.blocked ?? '—'}</strong> blocked
        </div>
        <div>This tab, since page load</div>
      </footer>
    </main>
  );
}
function EyeIcon({ hidden }: { hidden: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      {hidden ? <line x1="3" y1="3" x2="21" y2="21" /> : <circle cx="12" cy="12" r="3" />}
    </svg>
  );
}

function Category({
  category: key,
  settings,
  update,
}: {
  category: CategoryKey;
  settings: Settings;
  update: (change: SettingsChange) => void;
}) {
  const percent = Number((settings.thresholds[key] * 100).toFixed(1));
  const [draft, setDraft] = useState(String(percent));
  // Keep the free-typing draft in sync with external settings changes without
  // an effect (React Compiler rule: no set-state-in-effect).
  const [lastSyncedPercent, setLastSyncedPercent] = useState(percent);
  if (lastSyncedPercent !== percent) {
    setLastSyncedPercent(percent);
    setDraft(String(percent));
  }
  const setPercent = (value: number) =>
    update({ field: 'threshold', category: key, value: value / 100 });
  return (
    <div className={`category ${settings.enabled[key] ? '' : 'disabled'}`}>
      <div className="category-label">
        <Switch.Root
          className="switch"
          aria-label={`Enable ${CATEGORY_LABELS[key]}`}
          checked={settings.enabled[key]}
          onCheckedChange={(checked) => update({ field: 'enabled', category: key, value: checked })}
        >
          <Switch.Thumb className="thumb" />
        </Switch.Root>
        <span>{CATEGORY_LABELS[key]}</span>
      </div>
      <div className="threshold">
        <input
          type="range"
          min="0"
          max="100"
          step="0.1"
          value={percent}
          disabled={!settings.enabled[key]}
          aria-label={`${CATEGORY_LABELS[key]} threshold`}
          onChange={(event) => setPercent(event.target.valueAsNumber)}
        />
        <input
          type="number"
          min="0"
          max="100"
          step="0.1"
          value={draft}
          disabled={!settings.enabled[key]}
          aria-label={`${CATEGORY_LABELS[key]} threshold percent`}
          onChange={(event) => {
            setDraft(event.target.value);
            if (event.target.validity.valid && event.target.value !== '')
              setPercent(event.target.valueAsNumber);
          }}
          onBlur={() => setDraft(String(percent))}
        />
        <span>%</span>
      </div>
    </div>
  );
}
