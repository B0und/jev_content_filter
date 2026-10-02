# Extension verification

For extension changes, use the persistent browser loop described in README.md.

- Run `node scripts/extension-agent.mjs status`. If no session is running, start it with `node scripts/extension-agent.mjs start` (or `--headless` when there is no display).
- The default session uses a local X fixture and synthetic provider responses. Use that for deterministic checks. `--live` uses a separate persistent profile for real X browsing.
- Source changes automatically build, reload the extension, refresh the target tab, and verify the actual toolbar popup. Wait until `status.lastCheck` refers to the new generation. A failed build leaves the old extension loaded and must be fixed before claiming success.
- Use `inspect popup`, `inspect feed`, `inspect logs`, and `logs` to inspect results. `doctor` proves log collection works in popup, content-script, and background contexts. Recheck it after changes to this harness.
- Restart the session after editing `scripts/extension-*.mjs`; the watcher rebuilds extension code, while the server loads its own code at startup.
- Use `click`, `fill`, or `eval` to exercise the changed behavior. Popup screenshots and DOM snapshots are under `.wxt/extension-agent/artifacts/`.
- Run `verify` after interactions and examine background and content errors as well as popup errors. Smoke verification does not replace assertions for the behavior you changed.
- `npm run test:e2e` builds the extension and runs both the Playwright suite and the browser-loop regressions. Run compile/lint/format checks for code changes.
- Never load `.env` credentials into the fixture session. Keep credentials out of screenshots, snapshots, and terminal output.
