import { useCallback, useEffect, useLayoutEffect, useId, useRef, useState } from 'react';
import { Switch } from '@base-ui/react/switch';
import {
  CATEGORY_LABELS,
  type CategoryKey,
  type Settings,
  type SettingsChange,
} from '../../filtering/types';
import type { ModelStatus } from '../../inference/contracts';

/** Show readiness where filters are controlled; move download details to Settings. */
export function EngineStatus({ status, onClick }: { status: ModelStatus; onClick: () => void }) {
  const label = {
    ready: 'On-device',
    idle: 'Not ready',
    loading: 'Preparing…',
    error: 'Needs attention',
  }[status.state];

  return (
    <button className={`engine-status engine-${status.state}`} type="button" onClick={onClick}>
      {label}
    </button>
  );
}

/** Configure one built-in filter through its enabled state and threshold. */
export function Category({
  category: key,
  settings,
  update,
  modelStatus,
  onSetup,
}: {
  category: CategoryKey;
  settings: Settings;
  update: (change: SettingsChange) => void;
  modelStatus?: ModelStatus;
  onSetup?: () => void;
}) {
  const toggleId = useId();

  const saveThreshold = useCallback(
    /** Persist the selected built-in category threshold. */
    (value: number, expectedThreshold: number) => {
      update({ field: 'threshold', category: key, value, expectedThreshold });
    },
    [key, update],
  );

  return (
    <div className={`category ${settings.enabled[key] ? '' : 'disabled'}`}>
      <div className="category-label">
        <Switch.Root
          className="switch"
          id={toggleId}
          aria-label={`Enable ${CATEGORY_LABELS[key]}`}
          checked={settings.enabled[key]}
          onCheckedChange={(checked) => update({ field: 'enabled', category: key, value: checked })}
        >
          <Switch.Thumb className="thumb" />
        </Switch.Root>
        <label htmlFor={toggleId}>
          <span className="sr-only">Enable </span>
          {CATEGORY_LABELS[key]}
        </label>
        {modelStatus && onSetup && <EngineStatus status={modelStatus} onClick={onSetup} />}
      </div>
      <Threshold
        label={CATEGORY_LABELS[key]}
        value={settings.thresholds[key]}
        enabled={settings.enabled[key]}
        save={saveThreshold}
      />
    </div>
  );
}

/** Persist threshold edits on a debounce, flushing the last edit on blur or unmount. */
export function Threshold({
  label,
  value,
  enabled,
  save,
}: {
  label: string;
  value: number;
  enabled: boolean;
  save: (value: number, expectedThreshold: number) => void;
}) {
  const hintId = useId();
  const percent = Number((value * 100).toFixed(1));
  const [draft, setDraft] = useState(String(percent));
  const [lastSyncedPercent, setLastSyncedPercent] = useState(percent);

  const pendingPercent = useRef<{ percent: number; expectedThreshold: number } | undefined>(
    undefined,
  );

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // A newer saved threshold wins over an unsaved local edit. Cancel before
  // painting it so blur/pagehide cannot flush the previous displayed value.
  useLayoutEffect(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    pendingPercent.current = undefined;
  }, [percent]);

  const flush = useCallback(
    /** Save against the captured field value so delayed flushes cannot replace newer edits. */ () => {
      clearTimeout(timer.current);
      timer.current = undefined;
      const value = pendingPercent.current;
      pendingPercent.current = undefined;

      if (value !== undefined) save(value.percent / 100, value.expectedThreshold);
    },
    [save],
  );

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

  /** Show the draft immediately and postpone persistence until edits stop. */
  const setPercent = (percent: number) => {
    setDraft(String(percent));
    pendingPercent.current = {
      percent,
      expectedThreshold: pendingPercent.current?.expectedThreshold ?? value,
    };
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 400);
  };

  const displayedPercent = draft !== '' && Number.isFinite(Number(draft)) ? Number(draft) : percent;

  return (
    <div className="threshold">
      <input
        type="range"
        min="0"
        max="100"
        step="1"
        value={displayedPercent}
        disabled={!enabled}
        aria-label={`${label} threshold`}
        aria-valuetext={`${Math.round(displayedPercent)}%`}
        aria-describedby={hintId}
        onChange={(event) => setPercent(event.target.valueAsNumber)}
      />
      <input
        type="number"
        min="0"
        max="100"
        step="0.1"
        value={draft}
        disabled={!enabled}
        aria-label={`${label} threshold percent`}
        aria-describedby={hintId}
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
          const value = pendingPercent.current?.percent ?? percent;
          flush();
          setDraft(String(value));
        }}
      />
      <span>%</span>
      <span id={hintId} className="sr-only">
        Lower thresholds hide more posts.
      </span>
    </div>
  );
}
