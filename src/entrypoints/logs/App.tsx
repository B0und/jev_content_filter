import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@base-ui-components/react/button';
import { Select } from '@base-ui-components/react/select';
import { clearLog, loadLog } from '../../shared/log';
import {
  CATEGORY_LABELS,
  type BlockedEntry,
  type CategoryKey,
} from '../../shared/types';
import './logs.css';

type ReasonFilter = 'all' | CategoryKey;

const REASON_OPTIONS: Array<{ value: ReasonFilter; label: string }> = [
  { value: 'all', label: 'All reasons' },
  ...(Object.entries(CATEGORY_LABELS) as Array<[CategoryKey, string]>).map(
    ([key, label]) => ({ value: key, label }),
  ),
];

export function App() {
  const [log, setLog] = useState<BlockedEntry[]>([]);
  const [filter, setFilter] = useState<ReasonFilter>('all');

  useEffect(() => {
    void loadLog().then(setLog);
    const listener = () => void loadLog().then(setLog);
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
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

  return (
    <main className="logs">
      <header className="logs-header">
        <h1>Blocked log ({filtered.length})</h1>
        <div className="logs-controls">
          <Select.Root<ReasonFilter>
            value={filter}
            onValueChange={(value) => setFilter(value as ReasonFilter)}
          >
            <Select.Trigger>{REASON_OPTIONS.find((o) => o.value === filter)?.label}</Select.Trigger>
            <Select.Portal>
              <Select.Positioner>
                <Select.Popup>
                  {REASON_OPTIONS.map((option) => (
                    <Select.Item key={option.value} value={option.value}>
                      <Select.ItemText>{option.label}</Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
          <Button onClick={() => void onClear()}>Clear all</Button>
        </div>
      </header>

      <table className="logs-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Author</th>
            <th>Surface</th>
            <th>Reasons</th>
            <th>Snippet</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((entry) => (
            <tr key={entry.tweetId}>
              <td>{new Date(entry.ts).toLocaleString()}</td>
              <td>{entry.author}</td>
              <td>{entry.surface}</td>
              <td>
                {entry.reasons
                  .map((r) => `${CATEGORY_LABELS[r.key]} ${(r.score * 100).toFixed(0)}%`)
                  .join(', ')}
              </td>
              <td className="logs-snippet">{entry.snippet}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
