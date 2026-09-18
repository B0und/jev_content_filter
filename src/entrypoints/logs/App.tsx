import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@base-ui-components/react/button';
import { Select } from '@base-ui-components/react/select';
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual';
import { clearLog, clearScanErrors, type ScanErrorEntry } from '../../shared/log';
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
  ...(Object.entries(CATEGORY_LABELS) as Array<[CategoryKey, string]>).map(
    ([key, label]) => ({ value: key, label }),
  ),
];

/** Every entry with an ID links to the post; older handle-less entries use the canonical URL. */
function postUrl(entry: { tweetId?: string; handle?: string }): string | null {
  if (!entry.tweetId) return null;
  return entry.handle
    ? `https://x.com/${entry.handle}/status/${entry.tweetId}`
    : `https://x.com/i/status/${entry.tweetId}`;
}

function BlockedRow(props: {
  vRow: VirtualItem;
  entry: BlockedEntry;
  unblocked: Set<string>;
  onUnblock: (tweetId: string) => void;
  measure: (node: Element | null) => void;
}) {
  const { vRow, entry, unblocked, onUnblock, measure } = props;
  const url = postUrl(entry);
  const preview = entry.target === 'preview';
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
        <a href={url ?? undefined} target="_blank" rel="noreferrer">{entry.author}</a>
        {preview && (
          <span className="preview-chip" title="Only the media preview was hidden; the post itself stays visible">
            Preview
          </span>
        )}
      </span>
      <span className="col-reasons">
        {entry.reasons.map((r) => `${CATEGORY_LABELS[r.key]} ${(r.score * 100).toFixed(0)}%`).join(', ')}
      </span>
      <span className="col-snippet">{entry.snippet}</span>
      <span className="col-action">
        {unblocked.has(entry.tweetId) ? (
          <span className="unblocked-badge">Unblocked</span>
        ) : (
          <button className="unblock-btn" onClick={() => onUnblock(entry.tweetId)}>Unblock</button>
        )}
      </span>
    </div>
  );
}

function ErrorRowView(props: { vRow: VirtualItem; entry: ErrorRow; measure: (node: Element | null) => void }) {
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
        {url && <a href={url} target="_blank" rel="noreferrer">View post ↗</a>}
      </span>
    </div>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>(() => (location.hash === '#errors' ? 'errors' : 'blocked'));
  const [log, setLog] = useState<BlockedEntry[]>([]);
  const [errors, setErrors] = useState<ErrorRow[]>([]);
  const [filter, setFilter] = useState<ReasonFilter>('all');
  const [unblocked, setUnblocked] = useState<Set<string>>(new Set());
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

  const refresh = useCallback(() => {
    void (async () => {
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
    })();
  }, []);

  useEffect(() => {
    refresh();
    const listener = (changes: Record<string, { newValue?: unknown; oldValue?: unknown }>, area: string) => {
      if (area !== 'local') return;
      const keys = Object.keys(changes);
      if (keys.some((k) => k === STORAGE_KEYS.log || k === STORAGE_KEYS.scanErrors || k === STORAGE_KEYS.status)) {
        refresh();
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
  }, [refresh]);

  /** Tab clicks and hash edits stay in sync without polluting session history. */
  const switchTab = useCallback((next: Tab) => {
    setTab(next);
    const hash = `#${next}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }, []);

  // Sync hash for direct open-logs links.
  useEffect(() => {
    const handler = () => setTab(location.hash === '#errors' ? 'errors' : 'blocked');
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  const filtered = useMemo(
    () =>
      filter === 'all'
        ? log
        : log.filter((entry) => entry.reasons.some((r) => r.key === filter)),
    [log, filter],
  );

  const onClear = useCallback(async () => {
    await clearLog();
    setLog([]);
  }, []);

  const onClearErrors = useCallback(async () => {
    await clearScanErrors();
    setErrors([]);
  }, []);

  const onUnblock = useCallback(async (tweetId: string) => {
    setUnblocked((prev) => new Set(prev).add(tweetId));
    await browser.storage.local.set({ [`${OVERRIDES_PREFIX}${tweetId}`]: 'allow' });
  }, []);

  const onTabKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const index = TABS.indexOf(tab);
      let next: number | null = null;
      if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
      else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = TABS.length - 1;
      if (next === null) return;
      event.preventDefault();
      const nextTab = TABS[next];
      if (!nextTab) return;
      switchTab(nextTab);
      tabRefs.current[nextTab]?.focus();
    },
    [switchTab, tab],
  );

  const list: readonly (BlockedEntry | ErrorRow)[] = tab === 'blocked' ? filtered : errors;

  // Virtual list for BOTH tabs; rows are measured as rendered, so varied
  // content, resizes, filter changes and tab switches never overlap.
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: list.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 8,
    getItemKey: (index) => {
      const item = list[index];
      return tab === 'blocked'
        ? `b:${(item as BlockedEntry).tweetId}`
        : `e:${(item as ErrorRow).source}:${(item as ErrorRow).message}`;
    },
  });

  // A new tab or filter starts at the top of its list.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [tab, filter]);

  const emptyMessage =
    tab === 'errors'
      ? 'No scan errors. Errors appear here if scanning fails.'
      : filter !== 'all' && log.length > 0
        ? 'No blocked posts match this filter.'
        : "No blocked posts. Posts appear here as they're filtered.";

  return (
    <main className="logs">
      <header className="logs-header">
        <div className="tabs" role="tablist" aria-label="Log sections" onKeyDown={onTabKeyDown}>
          {TABS.map((key) => (
            <button
              key={key}
              ref={(node) => {
                tabRefs.current[key] = node;
              }}
              type="button"
              role="tab"
              id={`tab-${key}`}
              aria-selected={tab === key}
              aria-controls={`panel-${key}`}
              tabIndex={tab === key ? 0 : -1}
              className={tab === key ? 'tab active' : 'tab'}
              onClick={() => switchTab(key)}
            >
              {key === 'blocked' ? 'Blocked' : 'Errors'}
              <span className="tab-count">{key === 'blocked' ? filtered.length : errors.length}</span>
            </button>
          ))}
        </div>
        <div className="logs-controls">
          {tab === 'blocked' && (
            <Select.Root<ReasonFilter>
              value={filter}
              onValueChange={(value) => setFilter(value as ReasonFilter)}
            >
              <Select.Trigger className="filter-trigger" aria-label="Filter by reason">
                {REASON_OPTIONS.find((o) => o.value === filter)?.label}
              </Select.Trigger>
              <Select.Portal>
                <Select.Positioner>
                  <Select.Popup className="filter-popup">
                    {REASON_OPTIONS.map((option) => (
                      <Select.Item key={option.value} value={option.value} className="filter-item">
                        <Select.ItemText>{option.label}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.Popup>
                </Select.Positioner>
              </Select.Portal>
            </Select.Root>
          )}
          {tab === 'blocked' && <Button className="action-btn" onClick={() => void onClear()}>Clear all</Button>}
          {tab === 'errors' && <Button className="action-btn" onClick={() => void onClearErrors()}>Clear errors</Button>}
        </div>
      </header>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {list.length === 0 ? (
          <p className="logs-empty">{emptyMessage}</p>
        ) : (
          <div className="virtual-scroll" ref={scrollRef}>
            <div className="virtual-inner" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((vRow) => {
                const item = list[vRow.index];
                if (!item) return null;
                return tab === 'blocked' ? (
                  <BlockedRow
                    key={vRow.key}
                    vRow={vRow}
                    entry={item as BlockedEntry}
                    unblocked={unblocked}
                    onUnblock={(tweetId) => void onUnblock(tweetId)}
                    measure={virtualizer.measureElement}
                  />
                ) : (
                  <ErrorRowView key={vRow.key} vRow={vRow} entry={item as ErrorRow} measure={virtualizer.measureElement} />
                );
              })}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
