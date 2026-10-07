import { useEffect, useRef, useState, useCallback, useId } from 'react';
import { Switch } from '@base-ui/react/switch';
import type { Settings, TextFilter, SettingsChange } from '../../filtering/types';
import { popupState } from './state';
import { Threshold } from './FilterControls';

/** Put custom filters first and keep creation above the list with immediate save feedback. */
export function CustomTextFilters({
  settings,
  onSetup,
}: {
  settings: Settings;
  onSetup: () => void;
}) {
  const [editing, setEditing] = useState<TextFilter | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleted, setDeleted] = useState<TextFilter | null>(null);
  const removal = useRef(0);
  const undoButton = useRef<HTMLButtonElement>(null);
  const focusUndo = useRef(false);
  useEffect(() => {
    if (deleted && focusUndo.current) {
      undoButton.current?.focus();
      focusUndo.current = false;
    }
  }, [deleted]);
  const returnFocus = useRef<HTMLElement | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const rememberFocus = () => {
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };
  return (
    <section className="filter-section custom-section" aria-labelledby="custom-text-heading">
      <div className="section-heading">
        <div>
          <h2 id="custom-text-heading">
            Your filters <span className="filter-count">{settings.textFilters.length}</span>
          </h2>
        </div>
        <button
          className="primary-button add-filter"
          ref={addButton}
          type="button"
          disabled={settings.textFilters.length >= 20}
          onClick={() => {
            rememberFocus();
            setEditing(null);
            setCreating(true);
          }}
        >
          Add text filter
        </button>
      </div>
      {!settings.providerKeys[settings.textProvider] && (
        <div className="setup-notice">
          <div>
            <strong>Connect a provider to start filtering</strong>
            <p>You can create filters now. Add your API key in Settings to run them.</p>
          </div>
          <button type="button" onClick={onSetup}>
            Set up
          </button>
        </div>
      )}
      {creating || editing ? (
        <div className="editor-view">
          <div className="editor-heading">
            <h3>{editing ? 'Edit filter' : 'New filter'}</h3>
            <p>Describe the topic or kind of post. Jev checks the meaning, not just keywords.</p>
          </div>
          <TextFilterEditor
            key={editing?.id ?? 'new'}
            filter={editing}
            onClose={() => {
              setEditing(null);
              setCreating(false);
              (returnFocus.current?.isConnected ? returnFocus.current : addButton.current)?.focus();
            }}
          />
        </div>
      ) : null}
      {deleted && (
        <output className="undo-notice">
          <span>Deleted “{deleted.name}”</span>
          <button
            ref={undoButton}
            type="button"
            onClick={async () => {
              // Undo can refill the list and disable Add at the 20-filter limit.
              if (settings.textFilters.length >= 19)
                document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
              else addButton.current?.focus();
              const filter = deleted;
              removal.current++;
              setDeleted(null);
              const restored = await popupState.update({ field: 'textFilter', value: filter });
              if (!restored) setDeleted(filter);
            }}
          >
            Undo
          </button>
        </output>
      )}
      {settings.textFilters.length > 0 ? (
        <>
          <p className="threshold-intro">Lower thresholds hide more posts.</p>
          <div className="custom-filter-list">
            {settings.textFilters.map((filter) => (
              <CustomFilter
                key={filter.id}
                filter={filter}
                onEdit={() => {
                  rememberFocus();
                  setEditing(filter);
                  setCreating(false);
                }}
                onDelete={async (restoreFocus) => {
                  const token = ++removal.current;
                  const saved = await popupState.update({
                    field: 'deleteTextFilter',
                    id: filter.id,
                  });
                  if (saved && token === removal.current) {
                    focusUndo.current = restoreFocus && document.activeElement === document.body;
                    setDeleted(filter);
                  }
                  if (saved && editing?.id === filter.id) setEditing(null);
                }}
              />
            ))}
          </div>
        </>
      ) : (
        !creating && (
          <div className="empty-filters">
            <svg viewBox="0 0 48 48" aria-hidden="true">
              <path d="M10 12h28M15 24h18M20 36h8" />
            </svg>
            <h3>A feed with fewer distractions</h3>
            <p>
              Add a filter for topics you would rather skip. Start with something specific, like
              crypto promotions.
            </p>
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                rememberFocus();
                setCreating(true);
              }}
            >
              Create your first filter
            </button>
          </div>
        )
      )}
      {settings.textFilters.length >= 20 && (
        <p className="notice">20 filters saved. Delete a filter to add another.</p>
      )}
    </section>
  );
}

/** Use the same enable and threshold controls as built-in filters. */
function CustomFilter({
  filter,
  onEdit,
  onDelete,
}: {
  filter: TextFilter;
  onEdit: () => void;
  onDelete: (restoreFocus: boolean) => void;
}) {
  const toggleId = useId();
  const saveThreshold = useCallback(
    /** Persist only this filter threshold so concurrent edits keep their other fields. */
    (value: number) => {
      void popupState.update({
        field: 'patchTextFilter',
        id: filter.id,
        value: { threshold: value },
      });
    },
    [filter.id],
  );
  return (
    <article className={`custom-filter category ${filter.enabled ? '' : 'disabled'}`}>
      <div className="custom-filter-heading category-label">
        <Switch.Root
          className="switch"
          id={toggleId}
          aria-label={`Enable ${filter.name}`}
          checked={filter.enabled}
          onCheckedChange={(enabled) =>
            popupState.update({ field: 'patchTextFilter', id: filter.id, value: { enabled } })
          }
        >
          <Switch.Thumb className="thumb" />
        </Switch.Root>
        <label htmlFor={toggleId}>
          <span className="sr-only">Enable </span>
          <strong>{filter.name}</strong>
        </label>
      </div>
      <Threshold
        label={filter.name}
        value={filter.threshold}
        enabled={filter.enabled}
        save={saveThreshold}
      />
      <p>{filter.instructions}</p>
      <div className="custom-filter-actions">
        <button type="button" onClick={onEdit}>
          Edit
        </button>
        <button
          type="button"
          aria-label={`Delete ${filter.name}`}
          onClick={(event) => onDelete(document.activeElement === event.currentTarget)}
        >
          Delete
        </button>
      </div>
    </article>
  );
}

/** Create or edit filter instructions without resetting the saved threshold. */
function TextFilterEditor({ filter, onClose }: { filter: TextFilter | null; onClose: () => void }) {
  const [id] = useState(() => filter?.id ?? crypto.randomUUID());
  const [editorId] = useState(() => crypto.randomUUID());
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      popupState.dismissEditorError(editorId);
    };
  }, [editorId]);
  const [saving, setSaving] = useState(false);
  const editedFields = useRef({ name: false, instructions: false });
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameInput.current?.focus();
  }, []);
  const [name, setName] = useState(filter?.name ?? '');
  const [instructions, setInstructions] = useState(filter?.instructions ?? '');
  return (
    <form
      className="text-filter-editor"
      onSubmit={async (event) => {
        event.preventDefault();
        if (saving || !name.trim() || !instructions.trim()) return;
        setSaving(true);
        try {
          const value = {
            name: name.trim(),
            instructions: instructions.trim(),
            threshold: 0.65,
          };
          const change: SettingsChange = filter
            ? {
                field: 'patchTextFilter',
                id,
                value: {
                  ...(editedFields.current.name ? { name: value.name } : {}),
                  ...(editedFields.current.instructions
                    ? { instructions: value.instructions }
                    : {}),
                },
              }
            : { field: 'textFilter', value: { id, ...value, enabled: true } };
          const saved = await popupState.update(change, editorId);
          if (saved && active.current) onClose();
        } finally {
          if (active.current) setSaving(false);
        }
      }}
    >
      <label htmlFor="filter-name">Filter name</label>
      <input
        id="filter-name"
        ref={nameInput}
        required
        disabled={saving}
        maxLength={80}
        value={name}
        onChange={(event) => {
          editedFields.current.name = true;
          setName(event.target.value);
        }}
        placeholder="Crypto promotions"
      />
      <label htmlFor="filter-instructions">What should be hidden?</label>
      <textarea
        id="filter-instructions"
        required
        disabled={saving}
        maxLength={2000}
        rows={3}
        value={instructions}
        onChange={(event) => {
          editedFields.current.instructions = true;
          setInstructions(event.target.value);
        }}
        placeholder="Posts promoting crypto tokens or get-rich-quick investment schemes"
      />
      <div className="custom-filter-actions">
        <button className="primary-button" type="submit" disabled={saving}>
          {saving ? 'Saving filter…' : 'Save filter'}
        </button>
        <button type="button" disabled={saving} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
