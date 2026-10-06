import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Switch } from '@base-ui/react/switch';
import { Tabs } from '@base-ui/react/tabs';
import {
  CATEGORY_LABELS,
  IMAGE_KEYS,
  TEXT_PROVIDER_LABELS,
  TEXT_PROVIDERS,
  isTextProvider,
  type CategoryKey,
  type Settings,
  type SettingsChange,
  type TextProvider,
  type TabReport,
} from '../../filtering/types';
import { SELECTED_MODELS } from '../../inference/model-catalog';
import type { ModelKind, ModelStatus } from '../../inference/contracts';
import { popupState } from './state';
import './popup.css';

const PROVIDER_DETAILS: Record<
  TextProvider,
  { keyLabel: string; placeholder: string; description: string }
> = {
  vercel: {
    keyLabel: 'Vercel AI Gateway API key',
    placeholder: 'vck_…',
    description:
      'Post text and text read locally from images are sent to Jev through Vercel AI Gateway for sexual-content checks.',
  },
  typesafe: {
    keyLabel: 'TypeSafe API key',
    placeholder: 'Paste your TypeSafe key',
    description:
      "Post text and text read locally from images are sent to Jev's Decisions API for sexual-content checks.",
  },
  openrouter: {
    keyLabel: 'OpenRouter API key',
    placeholder: 'Paste your OpenRouter key',
    description:
      "Post text and text read locally from images are sent to Jev through OpenRouter's Decisions API for sexual-content checks.",
  },
};

export function App() {
  const state = useSyncExternalStore(
    popupState.subscribe,
    popupState.getSnapshot,
    popupState.getSnapshot,
  );
  const { settings, loadFailed, status, report, missingScript, error, saving, models } = state;

  useEffect(() => popupState.start(), []);

  if (!settings && loadFailed) {
    return (
      <main className="popup popup-message-view">
        <header className="popup-header">
          <h1>Jev feed filter</h1>
        </header>
        <section className="popup-message">
          <p role="alert" className="warning">
            Could not load settings. Check that storage is available, then retry.
          </p>
          <button type="button" onClick={() => location.reload()}>
            Retry
          </button>
        </section>
        <footer className="popup-footer popup-message-footer">
          <button type="button" className="log-button" onClick={popupState.openLogs}>
            Open logs
          </button>
        </footer>
      </main>
    );
  }

  if (!settings) {
    return (
      <main className="popup popup-message-view">
        <header className="popup-header">
          <h1>Jev feed filter</h1>
        </header>
        <output className="popup-message">Loading settings…</output>
      </main>
    );
  }

  const health = scanHealth(settings.masterEnabled, missingScript, report);
  const scanFailed = missingScript || Boolean(report?.failed) || status?.state === 'failing';

  return (
    <main className="popup">
      <header className="popup-header">
        <h1>Jev feed filter</h1>
        <div className="master-control">
          <span>Filtering</span>
          <Switch.Root
            className="switch"
            aria-label="Enable filtering"
            checked={settings.masterEnabled}
            onCheckedChange={(checked) =>
              popupState.update({ field: 'masterEnabled', value: checked })
            }
          >
            <Switch.Thumb className="thumb" />
          </Switch.Root>
        </div>
      </header>

      <section
        className={`scan-strip${scanFailed ? ' is-warning' : ''}`}
        aria-label="Current tab status"
      >
        <span className="scan-mark" aria-hidden="true" />
        <div className="scan-copy">
          <span className="scan-label">Current tab</span>
          <output aria-live="polite">{health}</output>
          {status?.state === 'failing' && (
            <p className="warning" role="alert">
              Sexual-text checks are failing. See Open logs for details. Local AI-text and image
              checks run separately.
            </p>
          )}
        </div>
      </section>

      <Tabs.Root defaultValue="text" className="filter-tabs">
        <Tabs.List className="popup-tabs" aria-label="Filter type" activateOnFocus>
          <Tabs.Tab value="text">Text</Tabs.Tab>
          <Tabs.Tab value="images">Images</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="text" className="tab-panel" keepMounted>
          <section className="filter-section" aria-labelledby="ai-text-heading">
            <div className="section-heading">
              <h2 id="ai-text-heading">AI-written text</h2>
              <p>Model files come from Hugging Face; AI checks do not upload post text.</p>
            </div>
            <ModelCard kind="aiText" status={models.aiText} />
            <div className="category-list">
              <Category category="aiGenerated" settings={settings} update={popupState.update} />
            </div>
            <p className="notice">
              Short text can be falsely flagged. AI scores are estimates, not proof of authorship.
            </p>
          </section>

          <section
            className="filter-section sexual-text-section"
            aria-labelledby="sexual-text-heading"
          >
            <div className="section-heading">
              <h2 id="sexual-text-heading">Sexual-text checks</h2>
              <p>
                These checks use Jev and the provider key below. They do not control AI-written-text
                checks.
              </p>
            </div>
            <div className="category-list">
              <Category category="sexualText" settings={settings} update={popupState.update} />
            </div>
            <ProviderSettings settings={settings} report={report} />
          </section>
        </Tabs.Panel>

        <Tabs.Panel value="images" className="tab-panel" keepMounted>
          <section className="filter-section" aria-labelledby="images-heading">
            <div className="section-heading">
              <h2 id="images-heading">Images</h2>
              <p>Model files come from the NSFWJS repository. Images are checked on this device.</p>
            </div>
            <ModelCard kind="image" status={models.image} />
            <p className="notice">
              An illustration is not automatically sexual. Set each image category separately.
            </p>
            <div className="threshold-intro">Lower thresholds block more.</div>
            <div className="category-list">
              {IMAGE_KEYS.map((key) => (
                <Category key={key} category={key} settings={settings} update={popupState.update} />
              ))}
            </div>
          </section>
        </Tabs.Panel>
      </Tabs.Root>

      <footer className="popup-footer">
        <div className="footer-main">
          <div className="counters" aria-live="polite">
            <div className="count-line">
              <strong>{report?.pageAnalyzed ?? '—'}</strong> analyzed
              <span className="count-separator" aria-hidden="true">
                /
              </span>
              <strong>{report?.pageBlocked ?? '—'}</strong> blocked
            </div>
            <p>This tab, since page load</p>
          </div>
          <button type="button" className="log-button" onClick={popupState.openLogs}>
            Open logs
          </button>
        </div>
        {saving && (
          <output className="footer-message" aria-live="polite">
            Saving changes…
          </output>
        )}
        {error && (
          <p className="footer-message warning" role="alert">
            {error}
          </p>
        )}
        {!saving && !error && (
          <output className="footer-message" aria-live="polite">
            Changes save automatically
          </output>
        )}
      </footer>
    </main>
  );
}

function scanHealth(enabled: boolean, missingScript: boolean, report: TabReport | null): string {
  if (!enabled) return 'Paused. Posts are not being filtered.';
  if (missingScript)
    return 'No filter connected to this tab. Open X, or reload your X tab after updating the extension.';
  if (!report) return 'Checking this tab…';
  if (report.retrying)
    return `Retrying ${report.retrying} post${report.retrying === 1 ? '' : 's'}…`;
  if (report.failed) return `${report.failed} posts were not fully checked. See the error log.`;
  if (report.pending) return `Scanning ${report.pending} posts…`;
  return report.analyzed
    ? 'Filtering this tab. Use the icon under any post to inspect it.'
    : 'Waiting for posts. No completed analysis yet.';
}

function ProviderSettings({ settings, report }: { settings: Settings; report: TabReport | null }) {
  const providerDetails = PROVIDER_DETAILS[settings.textProvider];
  const update = popupState.update;
  return (
    <details className="diagnostics">
      <summary>Jev provider and scan details</summary>
      <p className="provider-scope">
        Sexual-text checks include words in images (English and Russian). Only these checks use this
        provider and key. AI-written-text checks run locally.
      </p>
      {report && (
        <p className="scan-details">
          {report.pending} pending · {report.failed} incomplete
          <br />
          Last scan:{' '}
          {report.lastScannedAt ? new Date(report.lastScannedAt).toLocaleTimeString() : 'Not yet'}
        </p>
      )}
      <div className="provider-field">
        <label htmlFor="text-provider">Provider for sexual-text checks</label>
        <select
          id="text-provider"
          value={settings.textProvider}
          onChange={(event) => {
            const provider = event.currentTarget.value;
            if (isTextProvider(provider)) update({ field: 'textProvider', value: provider });
          }}
        >
          {TEXT_PROVIDERS.map((provider) => (
            <option key={provider} value={provider}>
              {TEXT_PROVIDER_LABELS[provider]}
            </option>
          ))}
        </select>
      </div>
      <ProviderKey key={settings.textProvider} settings={settings} />
      <p className="provider-description">
        {providerDetails.description} Without a key, sexual text is not checked.
      </p>
    </details>
  );
}

function ProviderKey({ settings }: { settings: Settings }) {
  const [showGatewayKey, setShowGatewayKey] = useState(false);
  const providerDetails = PROVIDER_DETAILS[settings.textProvider];
  const update = popupState.update;
  return (
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

function ModelCard({ kind, status }: { kind: ModelKind; status: ModelStatus }) {
  const model = SELECTED_MODELS[kind];
  const totalBytes = status.total > 0 ? status.total : model.downloadBytes;
  const loadedBytes =
    totalBytes > 0 ? Math.min(Math.max(status.loaded, 0), totalBytes) : Math.max(status.loaded, 0);
  const statusLabel = {
    ready: 'Ready on this device',
    loading: 'Downloading and preparing',
    error: 'Could not load model',
    idle: 'Not loaded yet',
  }[status.state];

  return (
    <article className={`model-card model-${status.state}`} aria-labelledby={`model-${kind}-title`}>
      <div className="model-card-heading">
        <div className="model-identity">
          <a
            className="model-title"
            id={`model-${kind}-title`}
            href={model.sourceUrl}
            target="_blank"
            rel="noreferrer"
          >
            {model.title}
          </a>
          <span className="model-revision">
            {model.id} · {model.revision}
          </span>
        </div>
        <span className="model-state">{statusLabel}</span>
      </div>
      <p className="model-description">{model.description}</p>
      {status.state === 'loading' && (
        <div className="model-loading">
          <progress
            aria-label={`${model.title} loading progress`}
            value={totalBytes > 0 ? loadedBytes : undefined}
            max={totalBytes > 0 ? totalBytes : undefined}
          />
          <span>
            {formatMegabytes(loadedBytes)}
            {totalBytes > 0 ? ` / ${formatMegabytes(totalBytes)}` : ' loaded'}
          </span>
        </div>
      )}
      {status.state === 'error' && (
        <div className="model-error" role="alert">
          <p>{status.error || 'The model could not be loaded.'}</p>
          <button type="button" onClick={() => popupState.retryModel(kind)}>
            Retry
          </button>
        </div>
      )}
      {status.state === 'idle' && (
        <p className="model-idle">
          Models download after startup when their filters are enabled, then stay cached locally.
        </p>
      )}
    </article>
  );
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
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
  const [lastSyncedPercent, setLastSyncedPercent] = useState(percent);
  const pendingPercent = useRef<number | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // A newer saved threshold wins over an unsaved local edit. Cancel before
  // painting it so blur/pagehide cannot flush the previous displayed value.
  useLayoutEffect(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    pendingPercent.current = undefined;
  }, [percent]);
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    const value = pendingPercent.current;
    pendingPercent.current = undefined;
    if (value !== undefined) update({ field: 'threshold', category: key, value: value / 100 });
  }, [key, update]);
  useEffect(() => {
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [flush]);
  if (lastSyncedPercent !== percent) {
    setLastSyncedPercent(percent);
    setDraft(String(percent));
  }
  const setPercent = (value: number) => {
    setDraft(String(value));
    pendingPercent.current = value;
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 400);
  };
  const displayedPercent = draft !== '' && Number.isFinite(Number(draft)) ? Number(draft) : percent;
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
          value={displayedPercent}
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
            else {
              clearTimeout(timer.current);
              pendingPercent.current = undefined;
            }
          }}
          onBlur={() => {
            const value = pendingPercent.current ?? percent;
            flush();
            setDraft(String(value));
          }}
        />
        <span>%</span>
      </div>
    </div>
  );
}
