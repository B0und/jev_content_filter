# Author exceptions and mask reliability

Source: the user's follow-ups on PR #4, 2026-10-08.

- Provide an action on a blocked post to persistently allow a selected filter category for its author. It must be hard to activate accidentally; the user requested a confirmation modal.
- Keep other categories and other authors filtered. Allow removing the saved exception in Settings. Save exceptions by normalized @handle on this browser.
- Settings can exempt selected categories for authors the viewer follows. Use explicit native X relationship state; unknown state remains filtered. Following the viewer is not the same as being followed by the viewer. A confirmed unfollow restores filtering.
- Preserve native post geometry throughout reveal, re-hide, confirmation and exception changes. Keep author and native controls accessible.
- Fix the reported blank mask on https://x.com/1SerUnicorniano/status/2107928738227015832. Native cropped media must not move recovery controls outside the visible post column. Test actual hit targets, not just DOM existence.
- Research and repair the false Hentai 97% classification. Verify likely drawn content independently and invalidate old pipeline caches. Do not claim model accuracy or universal false-positive elimination from one example.

Exemptions control blocking decisions. Scores can still be computed and retained so removing an exception takes effect immediately. Follow relationships are page-local, never persisted across browsing sessions. No extra X API requests or remote image providers are introduced.
