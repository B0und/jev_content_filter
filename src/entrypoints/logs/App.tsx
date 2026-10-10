import * as Schema from 'effect/Schema';
import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { Button } from '@base-ui/react/button';
import { Select } from '@base-ui/react/select';
import { Tabs } from '@base-ui/react/tabs';
import type { VirtualItem } from '@tanstack/react-virtual';
import { createVirtualRows } from './virtual-rows';
import {
  CATEGORY_KEYS,
  CATEGORY_LABELS,
  scoreLabel,
  type BlockedEntry,
} from '../../filtering/types';
import { logsState, type ErrorRow } from './state';
import './logs.css';

type Tab = 'blocked' | 'errors';

type ReasonFilter = string;

const TABS: readonly Tab[] = ['blocked', 'errors'];

const REASON_OPTIONS: Array<{ value: ReasonFilter; label: string }> = [
  { value: 'all', label: 'All reasons' },
  ...CATEGORY_KEYS.map((key) => ({ value: key, label: CATEGORY_LABELS[key] })),
];

function isTab(value: string): value is Tab {
  return TABS.some((tab) => tab === value);
}

function subscribeHash(listener: () => void) {
  window.addEventListener('hashchange', listener);

  return () => window.removeEventListener('hashchange', listener);
}

function currentTab(): Tab {
  return location.hash === '#errors' ? 'errors' : 'blocked';
}

function switchTab(next: Tab) {
  const hash = `#${next}`;

  if (location.hash === hash) return;
  const oldURL = location.href;
  history.replaceState(null, '', hash);
  window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: location.href }));
}

/** Every entry with an ID links to its permalink, which is never hidden. */
function postUrl(entry: { tweetId?: string; handle?: string }): string | null {
  if (!entry.tweetId) return null;

  return entry.handle
    ? `https://x.com/${entry.handle}/status/${entry.tweetId}`
    : `https://x.com/i/status/${entry.tweetId}`;
}

function BlockedRow(props: {
  vRow: VirtualItem;
  entry: BlockedEntry;
  unblocked: ReadonlySet<string>;
  unblocking: ReadonlySet<string>;
  onUnblock: (tweetId: string) => void;
  measure: (node: Element | null) => void;
}) {
  const { vRow, entry, unblocked, unblocking, onUnblock, measure } = props;
  const url = postUrl(entry);
  const preview = entry.target === 'preview';
  const isUnblocked = unblocked.has(entry.tweetId);
  const isUnblocking = unblocking.has(entry.tweetId);
  let action: React.ReactNode;

  if (isUnblocking)
    action = (
      <button className="unblock-btn" disabled>
        Unblocking…
      </button>
    );
  else if (isUnblocked) action = <span className="unblocked-badge">Unblocked</span>;
  else
    action = (
      <button className="unblock-btn" onClick={() => onUnblock(entry.tweetId)}>
        Unblock
      </button>
    );

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
          .map((r) => `${r.label ?? scoreLabel(r.key)} ${(r.score * 100).toFixed(0)}%`)
          .join(', ')}
      </span>
      <span className="col-snippet">{entry.snippet}</span>
      <span className="col-action">{action}</span>
    </div>
  );
}

function ErrorRowView(props: {
  vRow: VirtualItem;
  entry: ErrorRow;
  measure: (node: Element | null) => void;
}) {
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

function VirtualList(props: {
  rows: Array<{
    key: string;
    node: (vRow: VirtualItem, measure: (node: Element | null) => void) => React.ReactNode;
  }>;
}) {
  const [store] = useState(createVirtualRows);
  const attach = useCallback((node: HTMLDivElement | null) => store.attach(node), [store]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useLayoutEffect(() => {
    store.setKeys(props.rows.map((row) => row.key));
  }, [store, props.rows]);

  return (
    <div className="virtual-scroll" ref={attach}>
      <div className="virtual-inner" style={{ height: snapshot.height, position: 'relative' }}>
        {snapshot.items.map((vRow) => {
          const row = props.rows[vRow.index];

          if (!row) return null;

          return <div key={vRow.key}>{row.node(vRow, store.measure)}</div>;
        })}
      </div>
    </div>
  );
}

function logReasonOptions(log: BlockedEntry[]) {
  const storedReasons = new Map<string, string>();

  for (const entry of log)
    for (const reason of entry.reasons)
      if (!REASON_OPTIONS.some((option) => option.value === reason.key))
        storedReasons.set(reason.key, reason.label ?? scoreLabel(reason.key));

  return [...REASON_OPTIONS, ...Array.from(storedReasons, ([value, label]) => ({ value, label }))];
}

export function App() {
  const tab = useSyncExternalStore(subscribeHash, currentTab, currentTab);
  const [filter, setFilter] = useState<ReasonFilter>('all');

  const snapshot = useSyncExternalStore(
    logsState.subscribe,
    logsState.getSnapshot,
    logsState.getSnapshot,
  );

  const { log, errors, unblocked, unblocking, loadError, actionError, busyAction } = snapshot;
  useEffect(() => logsState.start(), []);

  const reasonOptions = logReasonOptions(log);

  const filtered =
    filter === 'all' ? log : log.filter((entry) => entry.reasons.some((r) => r.key === filter));

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
        onUnblock={logsState.unblock}
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
          if (Schema.is(Schema.String)(value) && isTab(value)) switchTab(value);
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
                items={reasonOptions}
                value={filter}
                onValueChange={(value) => {
                  if (
                    Schema.is(Schema.String)(value) &&
                    reasonOptions.some((option) => option.value === value)
                  )
                    setFilter(value);
                }}
              >
                <Select.Trigger className="filter-trigger" aria-label="Filter by reason">
                  <Select.Value />
                </Select.Trigger>
                <Select.Portal>
                  <Select.Positioner className="filter-positioner">
                    <Select.Popup className="filter-popup">
                      {reasonOptions.map((option) => (
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
                onClick={() => logsState.clear('clear-log')}
              >
                {busyAction === 'clear-log' ? 'Clearing…' : 'Clear all'}
              </Button>
            )}
            {tab === 'errors' && (
              <Button
                className="action-btn"
                disabled={busyAction !== null}
                onClick={() => logsState.clear('clear-errors')}
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
