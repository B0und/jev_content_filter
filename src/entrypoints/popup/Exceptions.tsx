import { scoreLabel, type Settings } from '../../filtering/types';
import { popupState } from './state';

/** Configure the followed-account bypass and manage saved author exceptions. */
export function Exceptions({ settings }: { settings: Settings }) {
  return (
    <section className="filter-section" aria-labelledby="exceptions-heading">
      <h2 id="exceptions-heading">Followed accounts</h2>
      <label className="followed-policy">
        <input
          type="checkbox"
          checked={settings.skipFollowed}
          onChange={(event) =>
            popupState.update({ field: 'skipFollowed', value: event.target.checked })
          }
        />
        <span>Don't filter posts from accounts I follow</span>
      </label>
      <p className="quiet-note">
        Applies to all filters. Accounts with unknown follow status stay filtered.
      </p>
      {settings.authorExceptions.length > 0 && (
        <>
          <h3>Author exceptions</h3>
          <p className="quiet-note">
            Add an exception from a blocked post. Saved by @handle on this browser.
          </p>
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
        </>
      )}
    </section>
  );
}
