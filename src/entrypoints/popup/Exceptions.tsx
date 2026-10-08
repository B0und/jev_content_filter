import { Switch } from '@base-ui/react/switch';
import { CATEGORY_KEYS, scoreLabel, type Settings, type ScoreKey } from '../../filtering/types';
import { popupState } from './state';

/** Manage persistent per-author allowances and category-specific followed-account policy. */
export function Exceptions({ settings }: { settings: Settings }) {
  const categories: ScoreKey[] = [
    ...CATEGORY_KEYS,
    ...settings.textFilters.map((filter) => `custom:${filter.id}` as const),
  ];
  const followed = new Set(settings.followedExemptions);
  return (
    <section className="filter-section" aria-labelledby="exceptions-heading">
      <div className="section-heading">
        <div>
          <h2 id="exceptions-heading">Who to filter</h2>
          <p>Keep selected filters off for accounts you follow.</p>
        </div>
      </div>
      <p className="quiet-note">
        Only applies when X confirms you follow the post’s author. Unknown accounts stay filtered.
      </p>
      <div className="category-list">
        {categories.map((category) => (
          <div className="category-label" key={category}>
            <Switch.Root
              className="switch"
              aria-label={
                'Skip ' + scoreLabel(category, settings.textFilters) + ' for followed accounts'
              }
              checked={followed.has(category)}
              onCheckedChange={(value) =>
                popupState.update({ field: 'followedExemption', category, value })
              }
            >
              <Switch.Thumb className="thumb" />
            </Switch.Root>
            <span>{scoreLabel(category, settings.textFilters)}</span>
          </div>
        ))}
      </div>
      <h3>Author exceptions</h3>
      <p className="quiet-note">
        Add an exception from a blocked post. Saved by @handle on this browser.
      </p>
      {!settings.authorExceptions.length && <p className="quiet-note">No author exceptions.</p>}
      <div className="author-exceptions">
        {settings.authorExceptions.flatMap((entry) =>
          entry.categories.map((category) => (
            <div className="author-exception" key={entry.handle + ':' + category}>
              <span>
                <strong>@{entry.handle}</strong>
                <br />
                {scoreLabel(category, settings.textFilters)}
              </span>
              <button
                type="button"
                aria-label={
                  'Remove ' +
                  scoreLabel(category, settings.textFilters) +
                  ' exception for @' +
                  entry.handle
                }
                onClick={() =>
                  popupState.update({
                    field: 'authorException',
                    handle: entry.handle,
                    category,
                    value: false,
                  })
                }
              >
                Remove
              </button>
            </div>
          )),
        )}
      </div>
    </section>
  );
}
