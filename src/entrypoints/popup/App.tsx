import { useEffect, useState, useSyncExternalStore } from 'react';
import { Switch } from '@base-ui/react/switch';
import { Tabs } from '@base-ui/react/tabs';
import {
  IMAGE_KEYS,
  TEXT_PROVIDER_LABELS,
  TEXT_PROVIDERS,
  isTextProvider,
  type Settings,
  type TextProvider,
  type TabReport,
} from '../../filtering/types';
import { SELECTED_MODELS } from '../../inference/model-catalog';
import type { ModelKind, ModelStatus } from '../../inference/contracts';
import { popupState } from './state';
import { CustomTextFilters } from './TextFilters';
import { Category, EngineStatus } from './FilterControls';
import './popup.css';

const PROVIDER_DETAILS: Record<
  TextProvider,
  { keyLabel: string; placeholder: string; description: string }
> = {
  vercel: {
    keyLabel: 'Vercel AI Gateway API key',
    placeholder: 'vck_…',
    description:
      'Post text and words read locally from images are sent to Jev through Vercel AI Gateway to check your text filters.',
  },
  typesafe: {
    keyLabel: 'TypeSafe API key',
    placeholder: 'Paste your TypeSafe key',
    description:
      "Post text and words read locally from images are sent to Jev's Decisions API to check your text filters.",
  },
  openrouter: {
    keyLabel: 'OpenRouter API key',
    placeholder: 'Paste your OpenRouter key',
    description:
      "Post text and words read locally from images are sent to Jev through OpenRouter's Decisions API to check your text filters.",
  },
};

/** Keep everyday filter controls in the popup and share them with the persistent workspace. */
export function App({ workspace = false }: { workspace?: boolean }) {
  const state = useSyncExternalStore(
    popupState.subscribe,
    popupState.getSnapshot,
    popupState.getSnapshot,
  );
  const { settings, loadFailed, status, report, missingScript, error, saving, models } = state;
  const [view, setView] = useState('filters');
  const narrow = useSyncExternalStore(subscribeLayout, isNarrowLayout, () => false);
  useEffect(() => popupState.start(), []);

  if (!settings)
    return (
      <main className={`popup popup-message-view${workspace ? ' workspace' : ''}`}>
        <header className="popup-header">
          <Brand />
        </header>
        <section className="popup-message">
          {loadFailed ? (
            <>
              <h2>Settings are unavailable</h2>
              <p role="alert">
                Could not load settings. Check that storage is available, then retry.
              </p>
              <button type="button" onClick={() => location.reload()}>
                Retry
              </button>
            </>
          ) : (
            <output>Loading your filters…</output>
          )}
        </section>
      </main>
    );

  const health = scanHealth(settings.masterEnabled, missingScript, report);
  const scanFailed = missingScript || Boolean(report?.failed) || status?.state === 'failing';
  return (
    <main className={`popup${workspace ? ' workspace' : ''}`}>
      <header className="popup-header">
        <Brand />
        <div className="master-control">
          <span>{settings.masterEnabled ? 'Filtering on' : 'Paused'}</span>
          <Switch.Root
            className="switch master-switch"
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
        className={`scan-strip${scanFailed ? ' is-warning' : ''}${!settings.masterEnabled ? ' is-paused' : ''}`}
        aria-label="Current tab status"
      >
        <span className="scan-mark" aria-hidden="true" />
        <div className="scan-copy">
          <output aria-live="polite">{health}</output>
        </div>
      </section>
      <Tabs.Root
        value={view}
        orientation={workspace && !narrow ? 'vertical' : 'horizontal'}
        onValueChange={(value) => setView(String(value))}
        className="filter-tabs"
      >
        <Tabs.List className="popup-tabs" aria-label="Filter controls" activateOnFocus>
          <Tabs.Tab value="filters">Filters</Tabs.Tab>
          <Tabs.Tab value="images">Images</Tabs.Tab>
          <Tabs.Tab value="settings">Settings</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="filters" className="tab-panel" keepMounted>
          <CustomTextFilters settings={settings} onSetup={() => setView('settings')} />
          <section className="filter-section local-filter-section" aria-label="On-device filter">
            <Category
              category="aiGenerated"
              settings={settings}
              update={popupState.update}
              modelStatus={models.aiText}
              onSetup={() => setView('settings')}
            />
            <details className="explanation">
              <summary>How reliable is this?</summary>
              <p>
                Short text can be falsely flagged. Scores are estimates, not proof of authorship.
              </p>
            </details>
          </section>
        </Tabs.Panel>
        <Tabs.Panel value="images" className="tab-panel" keepMounted>
          <section className="filter-section" aria-labelledby="images-heading">
            <div className="section-heading">
              <div>
                <h2 id="images-heading">Image filters</h2>
                <p>Hide posts based on their images.</p>
              </div>
              <EngineStatus status={models.image} onClick={() => setView('settings')} />
            </div>
            <p className="threshold-intro">
              Lower thresholds hide more. Images stay on your device.
            </p>
            <div className="category-list">
              {IMAGE_KEYS.map((key) => (
                <Category key={key} category={key} settings={settings} update={popupState.update} />
              ))}
            </div>
            <p className="quiet-note">
              Drawings includes illustrations of any kind, not just explicit ones.
            </p>
          </section>
        </Tabs.Panel>
        <Tabs.Panel value="settings" className="tab-panel settings-panel" keepMounted>
          <section className="filter-section">
            <div className="section-heading">
              <div>
                <h2>Connections & privacy</h2>
                <p>Choose how your custom filters check posts.</p>
              </div>
            </div>
            <ProviderSettings settings={settings} />
          </section>
          <section className="filter-section">
            <div className="section-heading">
              <div>
                <h2>On-device models</h2>
                <p>Downloaded once, then checked locally.</p>
              </div>
            </div>
            <ModelCard kind="aiText" status={models.aiText} />
            <ModelCard kind="image" status={models.image} />
          </section>
          {status?.state === 'failing' && (
            <p className="notice" role="alert">
              Jev text checks are failing. Open logs for details. Local checks run separately.
            </p>
          )}
        </Tabs.Panel>
      </Tabs.Root>
      <PopupFooter
        report={report}
        saving={saving}
        error={error}
        workspace={workspace}
        onWorkspace={popupState.openWorkspace}
      />
    </main>
  );
}

/** A compact wordmark identifies the toolbar and workspace without consuming a heading row. */
function Brand() {
  return (
    <div className="brand">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 5h16M7 12h10M10 19h4" />
      </svg>
      <h1>
        Jev <span>Feed filter</span>
      </h1>
    </div>
  );
}

/** Describe feed progress without treating unavailable or partially checked feeds as healthy. */
function scanHealth(enabled: boolean, missingScript: boolean, report: TabReport | null): string {
  if (!enabled) return 'Filtering is paused.';
  if (missingScript)
    return 'No filter connected to this tab. Open X, or reload your X tab after updating the extension.';
  if (!report) return 'Connecting to this feed…';
  if (report.retrying)
    return `Retrying ${report.retrying} post${report.retrying === 1 ? '' : 's'}…`;
  if (report.failed) return `${report.failed} posts were not fully checked. See the error log.`;
  if (report.pending) return `Checking ${report.pending} post${report.pending === 1 ? '' : 's'}…`;
  return report.analyzed ? 'Active on this feed.' : 'Ready. Waiting for posts.';
}

/** Configure text-provider routing and explain which content leaves the device. */
function ProviderSettings({ settings }: { settings: Settings }) {
  const providerDetails = PROVIDER_DETAILS[settings.textProvider];
  const update = popupState.update;
  return (
    <div className="diagnostics">
      <p className="provider-scope">
        Custom filters use a provider. AI-text and image checks stay on this device.
      </p>
      <div className="provider-field">
        <label htmlFor="text-provider">Provider for Jev text filters</label>
        <select
          id="text-provider"
          value={settings.textProvider}
          onChange={(event) => {
            const provider = event.currentTarget.value;
            if (isTextProvider(provider)) void update({ field: 'textProvider', value: provider });
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
        {providerDetails.description} Without a key, these text filters are not checked.
      </p>
    </div>
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

/** Show model readiness with download controls and optional technical details. */
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
        </div>
        <span className="model-state">{statusLabel}</span>
      </div>
      <details className="model-details">
        <summary>Model details</summary>
        <p className="model-description">{model.description}</p>
        <p className="model-revision">
          {model.id} · {model.revision}
        </p>
      </details>
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

/** Keep save feedback and secondary actions visible while the filter list scrolls. */
function PopupFooter({
  report,
  saving,
  error,
  workspace,
  onWorkspace,
}: {
  report: TabReport | null;
  saving: boolean;
  error: string;
  workspace: boolean;
  onWorkspace: () => void;
}) {
  return (
    <footer className="popup-footer">
      <div className="footer-main">
        <div
          className="counters"
          aria-label="This tab, since page load"
          title="Since this page loaded"
        >
          <span className="counter-scope">This tab</span>
          <strong>{report?.pageBlocked ?? '—'}</strong> hidden{' '}
          <span className="count-separator">/</span> {report?.pageAnalyzed ?? '—'} checked
        </div>
        <button type="button" className="text-button" onClick={popupState.openLogs}>
          Open logs
        </button>
      </div>
      <div className="footer-bottom">
        <output className="footer-message" aria-live="polite">
          {saving ? 'Saving changes…' : 'Changes save automatically'}
        </output>
        {!workspace && (
          <button type="button" className="text-button workspace-button" onClick={onWorkspace}>
            Open workspace <span aria-hidden="true">↗</span>
          </button>
        )}
      </div>
      {error && (
        <p className="footer-message warning" role="alert">
          {error}
        </p>
      )}
    </footer>
  );
}

/** Match the workspace tab semantics to its horizontal layout on small screens. */
function subscribeLayout(listener: () => void): () => void {
  const query = window.matchMedia('(max-width: 640px)');
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

/** Read the same media query used by the responsive workspace navigation. */
function isNarrowLayout(): boolean {
  return window.matchMedia('(max-width: 640px)').matches;
}
