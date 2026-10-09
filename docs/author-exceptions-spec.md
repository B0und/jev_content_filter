# Author exceptions and mask reliability

Source: the user's follow-ups on PR #4, 2026-10-08.

- Provide an action on a blocked post to persistently allow a selected filter category for its author. It must be hard to activate accidentally; the user requested a confirmation modal.
- Keep other categories and other authors filtered. Allow removing the saved exception in Settings. Save exceptions by normalized @handle on this browser.
- The 2026-10-09 follow-up replaces category switches with one checkbox: **Don't filter posts from accounts I follow**. It exempts confirmed followed authors from every filter, including newly created custom rules. Persist one boolean; migrate any valid legacy selection to enabled, with an explicit saved boolean taking precedence. Use explicit native X relationship state; unknown state remains filtered. Following the viewer is not the same as being followed by the viewer. A confirmed unfollow restores filtering.
- Preserve native post geometry throughout reveal, re-hide, confirmation and exception changes. Keep author and native controls accessible.
- Show the detected score and saved blocking cutoff in the notice. A filled bar reaches the detected score, with a marker at the cutoff; short replies use an inline comparison. Refresh the comparison after cutoff changes without moving the feed. Use native theme colors and readable primary/secondary buttons, with confirmation required for author exceptions.
- Fix the reported blank mask on https://x.com/1SerUnicorniano/status/2107928738227015832. Native cropped media must not move recovery controls outside the visible post column. Test actual hit targets, not just DOM existence.
- Research and repair the false Hentai 97% classification. Verify likely drawn content independently and invalidate old pipeline caches. Do not claim model accuracy or universal false-positive elimination from one example.

Exemptions control blocking decisions. Scores can still be computed and retained so removing an exception takes effect immediately. Follow relationships are page-local, never persisted across browsing sessions. The active viewer is inferred from X's own profile-navigation link. Changing or losing that identity clears both relationship buffers, and responses started under an earlier viewer epoch cannot restore exemptions. Until a fresh response confirms following for the current viewer, affected categories remain filtered. No extra X API requests or remote image providers are introduced.
