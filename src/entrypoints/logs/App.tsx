import { useEffect, useRef, useState } from 'react';
import { Button } from '@base-ui/react/button';
import { Select } from '@base-ui/react/select';
import { Tabs } from '@base-ui/react/tabs';
import { browser } from 'wxt/browser';
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual';
import { type ScanErrorEntry } from '../../shared/log';
import {
  CATEGORY_LABELS,
  STORAGE_KEYS,
  type BlockedEntry,
  type CategoryKey,
  type FilterStatus,
} from '../../shared/types';
import './logs.css';

type Tab = 'blocked' | 'errors';
type ReasonFilter = 'all' | CategoryKey;
type ErrorRow = ScanErrorEntry & { source: string };

const TABS: readonly Tab[] = ['blocked', 'errors'];
const OVERRIDES_PREFIX = `${STORAGE_KEYS.overrides}:`;

const REASON_OPTIONS: Array<{ value: ReasonFilter; label: string }> = [
  { value: 'all', label: 'All reasons' },
  ...(Object.entries(CATEGORY_LABELS) as Array<[CategoryKey, string]>).map(([key, label]) => ({
    value: key,
    label,
  })),
];

/** Every entry with an ID opens in review mode so the linked post stays visible. */
function postUrl(entry: { tweetId?: string; handle?: string }): string | null {
  if (!entry.tweetId) return null;
  const base = entry.handle
    ? `https://x.com/${entry.handle}/status/${entry.tweetId}`
    : `https://x.com/i/status/${entry.tweetId}`;
  return `${base}?jev=review`;
}

// The virtualizer manages its own refs/effects and is incompatible with React
// Compiler memoization, so the row list is an isolated component marked with
// 'use no memo'; everything above stays compiler-optimized.
function BlockedRow(props: {
  vRow: VirtualItem;
  entry: BlockedEntry;
  unblocked: Set<string>;
  unblocking: Set<string>;
  onUnblock: (tweetId: string) => void;
  measure: (node: Element | null) => void;
}) {
  'use no memo';
  const { vRow, entry, unblocked, unblocking, onUnblock, measure } = props;
  const url = postUrl(entry);
  const preview = entry.target === 'preview';
  const isUnblocked = unblocked.has(entry.tweetId);
  const isUnblocking = unblocking.has(entry.tweetId);
  return (
    <div
      className={preview ? 'row preview-row' : 'row'}
      data-index={vRow.index}
      ref={measure}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        transform: `translateY(${vRow.start}px)`,
      }}
    >
      <span className="col-time">{new Date(entry.ts).toLocaleString()}</span>
      <span className="col-author">
        <a href={url ?? undefined} target="_blank" rel="noreferrer">
          {entry.author}
        </a>
        {preview && (
          <span
            className="preview-chip"
            title="Only the media preview was hidden; the post itself stays visible"
          >
            Preview
          </span>
        )}
      </span>
      <span className="col-reasons">
        {entry.reasons
          .map((r) => `${CATEGORY_LABELS[r.key]} ${(r.score * 100).toFixed(0)}%`)
          .join(', ')}
      </span>
      <span className="col-snippet">{entry.snippet}</span>
      <span className="col-action">
        {isUnblocked ? (
          <span className="unblocked-badge">Unblocked</span>
        ) : (
          <button
            className="unblock-btn"
            disabled={isUnblocking}
            onClick={() => onUnblock(entry.tweetId)}
          >
            Unblock
          </button>
        )}
      </span>
    </div>
  );
}

function ErrorRowView(props: {
  vRow: VirtualItem;
  entry: ErrorRow;
  measure: (node: Element | null) => void;
}) {
  'use no memo';
  const { vRow, entry, measure } = props;
  const url = postUrl(entry);
  return (
    <div
      className="row error-row"
      data-index={vRow.index}
      ref={measure}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        transform: `translateY(${vRow.start}px)`,
      }}
    >
      <span className="col-time">{new Date(entry.ts).toLocaleString()}</span>
      <span className="col-source">{entry.source}</span>
      <span className="col-snippet">{entry.message}</span>
      <span className="col-link">
        {url && (
          <a href={url} target="_blank" rel="noreferrer">
            View post ↗
          </a>
        )}
      </span>
    </div>
  );
}

/** Virtualizer instance for one tab's rows; refs inside, so it opts out of the compiler. */
function VirtualList(props: {
  rows: Array<{
    key: string;
    node: (vRow: VirtualItem, measure: (node: Element | null) => void) => React.ReactNode;
  }>;
}) {
  'use no memo';
  const scrollRef = useRef<HTMLDivElement>(null);
  // TanStack Virtual's API returns functions that cannot be memoized; the
  // compiler directive above skips this component, and this rule disable
  // records that decision (isolated here, per the audit's instruction to
  // not broadly suppress compiler rules).
  // oxlint-disable-next-line react/incompatible-library react-compiler/incompatible-library
  const virtualizer = useVirtualizer({
    count: props.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 8,
    getItemKey: (index) => props.rows[index]?.key ?? String(index),
  });
  return (
    <div className="virtual-scroll" ref={scrollRef}>
      <div
        className="virtual-inner"
        style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
      >
        {virtualizer.getVirtualItems().map((vRow) => {
          const row = props.rows[vRow.index];
          if (!row) return null;
          return <div key={vRow.key}>{row.node(vRow, virtualizer.measureElement)}</div>;
        })}
      </div>
    </div>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>(() => (location.hash === '#errors' ? 'errors' : 'blocked'));
  const [log, setLog] = useState<BlockedEntry[]>([]);
  const [errors, setErrors] = useState<ErrorRow[]>([]);
  const [filter, setFilter] = useState<ReasonFilter>('all');
  const [unblocked, setUnblocked] = useState<Set<string>>(new Set());
  const [unblocking, setUnblocking] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busyAction, setBusyAction] = useState<'clear-log' | 'clear-errors' | null>(null);

  const refresh = async () => {
    try {
      // Only the keys this page renders: log, scan errors, filter status, plus
      // per-tweet allow overrides for the tweets currently in the log.
      const stored = await browser.storage.local.get([
        STORAGE_KEYS.log,
        STORAGE_KEYS.scanErrors,
        STORAGE_KEYS.status,
      ]);
      const storedLog = (stored[STORAGE_KEYS.log] as BlockedEntry[] | undefined) ?? [];
      const scanErrors = (stored[STORAGE_KEYS.scanErrors] as ScanErrorEntry[] | undefined) ?? [];
      const status = (stored[STORAGE_KEYS.status] as FilterStatus | undefined) ?? {
        state: 'ok' as const,
        updatedAt: 0,
      };
      setLog(storedLog);
      const rows: ErrorRow[] = scanErrors.map((entry) => ({ ...entry, source: 'Scan' }));
      if (status.state === 'failing' && status.reason) {
        rows.unshift({ ts: status.updatedAt, message: status.reason, source: 'Text API' });
      }
      setErrors(rows);
      setLoadError('');
      const overrideKeys = storedLog.map((entry) => `${OVERRIDES_PREFIX}${entry.tweetId}`);
      if (overrideKeys.length === 0) {
        setUnblocked(new Set());
        return;
      }
      const overrides = await browser.storage.local.get(overrideKeys);
      setUnblocked(
        new Set(
          Object.entries(overrides)
            .filter(([, value]) => value === 'allow')
            .map(([key]) => key.slice(OVERRIDES_PREFIX.length)),
        ),
      );
    } catch (e) {
      // Storage reads can fail (quota, worker restart): surface it honestly
      // instead of showing a quietly empty log.
      setLoadError(`Could not load the log: ${String(e)}`);
    }
  };

  useEffect(() => {
    // The initial refresh is the effect synchronizing with the storage
    // external system; its setState calls happen after awaits, not
    // synchronously in the effect body.
    // oxlint-disable-next-line react/set-state-in-effect react-compiler/set-state-in-effect
    void refresh();
    const listener = (
      changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
      area: string,
    ) => {
      if (area !== 'local') return;
      const keys = Object.keys(changes);
      if (
        keys.some(
          (k) =>
            k === STORAGE_KEYS.log || k === STORAGE_KEYS.scanErrors || k === STORAGE_KEYS.status,
        )
      ) {
        void refresh();
        return;
      }
      const overrideKeys = keys.filter((k) => k.startsWith(OVERRIDES_PREFIX));
      if (overrideKeys.length === 0) return; // Unrelated change (settings, …): leave the page alone.
      setUnblocked((prev) => {
        const next = new Set(prev);
        for (const key of overrideKeys) {
          const id = key.slice(OVERRIDES_PREFIX.length);
          if (changes[key]?.newValue === 'allow') next.add(id);
          else next.delete(id);
        }
        return next;
      });
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  }, []);

  /** Tab clicks and hash edits stay in sync without polluting session history. */
  function switchTab(next: Tab) {
    setTab(next);
    const hash = `#${next}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }

  // Sync hash for direct open-logs links.
  useEffect(() => {
    const handler = () => setTab(location.hash === '#errors' ? 'errors' : 'blocked');
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  const filtered =
    filter === 'all' ? log : log.filter((entry) => entry.reasons.some((r) => r.key === filter));

  async function onUnblock(tweetId: string) {
    setActionError('');
    setUnblocking((prev) => new Set(prev).add(tweetId));
    try {
      await browser.storage.local.set({ [`${OVERRIDES_PREFIX}${tweetId}`]: 'allow' });
      // The storage.onChanged listener also records this; setting it here
      // covers environments where change events are unreliable. The badge
      // only appears once the write has actually succeeded.
      setUnblocked((prev) => new Set(prev).add(tweetId));
    } catch (e) {
      setActionError(`Could not unblock this post: ${String(e)}`);
    } finally {
      setUnblocking((prev) => {
        const next = new Set(prev);
        next.delete(tweetId);
        return next;
      });
    }
  }

  async function onClear() {
    setActionError('');
    setBusyAction('clear-log');
    try {
      // Serialized through the background log queue so an in-flight append
      // cannot resurrect entries right after the clear.
      const reply = (await browser.runtime.sendMessage({ type: 'clear-log' })) as
        | { ok?: boolean }
        | undefined;
      if (!reply?.ok) throw new Error('background did not confirm the clear');
      setLog([]);
      setActionError('');
    } catch (e) {
      setActionError(`Could not clear the log: ${String(e)}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function onClearErrors() {
    setActionError('');
    setBusyAction('clear-errors');
    try {
      const reply = (await browser.runtime.sendMessage({ type: 'clear-errors' })) as
        | { ok?: boolean }
        | undefined;
      if (!reply?.ok) throw new Error('background did not confirm the clear');
      setErrors((prev) => prev.filter((row) => row.source !== 'Scan'));
      setActionError('');
    } catch (e) {
      setActionError(`Could not clear scan errors: ${String(e)}`);
    } finally {
      setBusyAction(null);
    }
  }

  // Stable identity for virtualizer rows: blocked rows key on tweet id, error
  // rows on timestamp + tweet id + message so same-message entries from
  // different posts keep distinct identities.
  const blockedRows = filtered.map((entry) => ({
    key: `b:${entry.tweetId}`,
    node: (vRow: VirtualItem, measure: (node: Element | null) => void) => (
      <BlockedRow
        vRow={vRow}
        entry={entry}
        unblocked={unblocked}
        unblocking={unblocking}
        onUnblock={(tweetId) => void onUnblock(tweetId)}
        measure={measure}
      />
    ),
  }));
  const errorRows = errors.map((entry) => ({
    key: `e:${entry.ts}:${entry.tweetId ?? ''}:${entry.message}`,
    node: (vRow: VirtualItem, measure: (node: Element | null) => void) => (
      <ErrorRowView vRow={vRow} entry={entry} measure={measure} />
    ),
  }));

  return (
    <main className="logs">
      <Tabs.Root
        value={tab}
        onValueChange={(value) => {
          if (typeof value === 'string' && TABS.includes(value as Tab)) switchTab(value as Tab);
        }}
      >
        <header className="logs-header">
          <Tabs.List className="tabs" aria-label="Log sections">
            {TABS.map((key) => (
              <Tabs.Tab key={key} value={key} className={tab === key ? 'tab active' : 'tab'}>
                {key === 'blocked' ? 'Blocked' : 'Errors'}
                <span className="tab-count">
                  {key === 'blocked' ? filtered.length : errors.length}
                </span>
              </Tabs.Tab>
            ))}
          </Tabs.List>
          <div className="logs-controls">
            {tab === 'blocked' && (
              <Select.Root<ReasonFilter>
                items={REASON_OPTIONS}
                value={filter}
                onValueChange={(value) => {
                  if (value !== null) setFilter(value as ReasonFilter);
                }}
              >
                <Select.Trigger className="filter-trigger" aria-label="Filter by reason">
                  <Select.Value />
                </Select.Trigger>
                <Select.Portal>
                  <Select.Positioner className="filter-positioner">
                    <Select.Popup className="filter-popup">
                      {REASON_OPTIONS.map((option) => (
                        <Select.Item
                          key={option.value}
                          value={option.value}
                          className="filter-item"
                        >
                          <Select.ItemText>{option.label}</Select.ItemText>
                        </Select.Item>
                      ))}
                    </Select.Popup>
                  </Select.Positioner>
                </Select.Portal>
              </Select.Root>
            )}
            {tab === 'blocked' && (
              <Button
                className="action-btn"
                disabled={busyAction !== null}
                onClick={() => void onClear()}
              >
                {busyAction === 'clear-log' ? 'Clearing…' : 'Clear all'}
              </Button>
            )}
            {tab === 'errors' && (
              <Button
                className="action-btn"
                disabled={busyAction !== null}
                onClick={() => void onClearErrors()}
              >
                {busyAction === 'clear-errors' ? 'Clearing…' : 'Clear errors'}
              </Button>
            )}
          </div>
        </header>
        {(loadError || actionError) && (
          <p role="alert" className="logs-error">
            {actionError || loadError}
          </p>
        )}

        <Tabs.Panel value="blocked" keepMounted className="logs-panel">
          {blockedRows.length === 0 ? (
            <p className="logs-empty">
              {filter !== 'all' && log.length > 0
                ? 'No blocked posts match this filter.'
                : "No blocked posts. Posts appear here as they're filtered."}
            </p>
          ) : (
            <VirtualList rows={blockedRows} />
          )}
        </Tabs.Panel>

        <Tabs.Panel value="errors" keepMounted className="logs-panel">
          {errorRows.length === 0 ? (
            <p className="logs-empty">No scan errors. Errors appear here if scanning fails.</p>
          ) : (
            <VirtualList rows={errorRows} />
          )}
        </Tabs.Panel>
      </Tabs.Root>
    </main>
  );
}
