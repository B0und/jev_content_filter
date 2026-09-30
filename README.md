# Jev Feed Filter

A Chromium MV3 extension that filters posts and link previews on X and Twitter. Text is evaluated by TypeSafe Jev through Vercel AI Gateway, TypeSafe AI, or OpenRouter. Images and video posters are classified locally with bundled NSFWJS MobileNetV2 weights.

## Development and installation

Use Node.js 22.12.0 or newer and npm. A current LTS release, preferably Node 24 or newer, is recommended. MSW v3 requires at least Node 22.12.0.

```sh
npm ci
npm run dev
```

For a production build:

```sh
npm run build
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `.output/chrome-mv3`. Reload existing X tabs after installing or updating the extension. `npm run zip` creates a distributable archive.

Open the extension popup, select a text provider, and enter that provider's API key. Credentials come from extension settings, not build-time environment variables. Each provider has its own key slot; changing providers never transfers another provider's key. An unconfigured provider cannot make text requests. Image filtering needs no API key.

## Effect tooling

The project uses Effect v4 release candidates with TypeScript 7 and `@effect/tsgo`. Compiler and lint integration versions are pinned in `package.json`; keep them compatible when upgrading. Import Schema from `effect/Schema`.

`npm ci` generates WXT types through `postinstall` and patches native TypeScript and Oxlint through `prepare`. If lifecycle scripts are disabled, run `npm run postinstall` and `npm run prepare` manually.

Run both `npm run compile` for TypeScript types and `npm run lint` for lint rules and Effect diagnostics. `.oxlintrc.json` extends the recommended Effect preset. The tsconfig plugin sets `diagnostics: false` to avoid duplicate reports while retaining editor refactors.

VS Code and Cursor settings enable the native TypeScript server at `node_modules/typescript/bin`. Enable TypeScript 7 editor support and select the workspace compiler as the sole TypeScript language server.

TypeScript configuration inherits WXT's bundled-app settings. The incremental cache lives in `.wxt/tsconfig.tsbuildinfo`; remove it after compiler upgrades if diagnostics are stale. The Effect integration uses the `@effect/language-service` plugin key and the installed `@effect/tsgo` schema.

Before writing Effect code, read `node_modules/effect/AGENTS.md` completely and follow its relevant links to bundled documentation and examples. Search `node_modules/effect/src` for public API signatures, JSDoc, and implementations when needed. Internal implementation techniques are not automatically suitable application patterns.

Prefer installed documentation and source when references differ. `AGENTS.md` contains the agent workflow.

## Runtime architecture

Effect owns asynchronous work; React and the DOM modules own rendering.

- `src/background/runtime.ts` builds one `BackgroundWorker` Layer and `ManagedRuntime`. Three scoped consumers process classification jobs; admission is capped at three active requests plus 64 waiting. Semaphores serialize settings, log, status, icon, and tab-count mutations. Browser listeners still register synchronously for MV3 worker wake-up.
- `src/content/runtime.ts` builds a `ContentSession` Layer per WXT context. Scans and retry fibers belong to its Scope. Context invalidation restores the DOM and disposes the runtime, interrupting pending work.
- `src/content/classify.ts` composes cache reads, schema-decoded replies, scoring, and cache writes as Effects. A semaphore serializes local image inference. Provider revisions prevent obsolete replies from reaching the cache.
- `src/shared/browser.ts` adapts native Promise APIs into interruptible Effects with `BrowserError`. Provider failures have a separate typed error; provider keys are redacted before errors leave the adapter.
- `src/entrypoints/popup/state.ts` and `src/entrypoints/logs/state.ts` expose snapshots through `useSyncExternalStore`. They own optimistic settings edits, pending log actions, storage reconciliation, and errors. React handlers call domain operations.
- Each open view scopes its reads and polling to a disposable runtime. Submitted writes run separately so closing the view does not cancel them. The background worker serializes settings changes and log clearing; unblock actions write persistent allow overrides.
- `src/shared/schemas.ts` validates browser messages, stored log rows, status, settings acknowledgements, and tab reports before they enter application state.
- `benchmarks/storage.ts` owns the lab's serialized saves in a `BenchmarkStorage` Layer. The Vite storage plugin scopes the SQLite connection to the server lifetime and consumes request bodies through an Effect Stream.

Promises remain at framework callbacks and native SDK adapters. Pure filtering policy, DOM discovery helpers, and benchmark metrics do not need an Effect runtime.

## Filtering behavior

- Lower thresholds block more content. Thresholds are probabilities between 0 and 1; the popup displays percentages.
- Sexual-text checks include explicit sexual content, lewd innuendo, heavily implied sexual content, and engagement bait designed to arouse. Factual news, health, and relationship discussion should remain allowed.
- The AI-written score is a classifier estimate, not proof of authorship.
- Drawings includes ordinary anime and illustrations, not only sexual content. Disable that category if you want nonsexual illustrations to remain visible.
- Link previews have separate scores and can be hidden without hiding the post.
- The post the URL addresses is never filtered: a status permalink, or the detail view X opens over the timeline. Everything else on that page is filtered normally. Navigation triggers a render even for URL-only `pushState`, `replaceState`, and back/forward changes.
- Pause restores hidden posts and previews. Unblocking a post persists an allow override.
- The toolbar badge and popup totals count unique posts analyzed or blocked since page load. A post and its blocked preview count once. Timeline recycling, tab switches, unblocking, and log clearing do not subtract past blocks. Pause hides the badge without erasing the count; reloading or navigating to a new document resets it.
- Badge resets use top-frame `webNavigation.onCommitted` events. Same-document history updates and iframe navigation preserve totals. The extension requests `webNavigation` permission for this distinction.
- Failed checks do not produce a blocking score. Successfully checked parts can still block a post; previews with scan errors remain visible. Transient failures have bounded retries.
- Videos are checked through thumbnails/posters, not every frame. Thumbnail-size changes reuse the same scores; new thumbnail assets and late or replaced posters trigger another scan.
- Quoted-post content is included in filtering, but quoted timestamps and links do not replace the parent post's identity or its blocked-log link.

Use a post's filter control to inspect scores and change thresholds. The popup opens blocked-post and error logs. Links from the blocked log point at the post permalink, where the post stays visible on its own. The blocked log records hidden, attached content only. An opened or allowed post, or a scan completed after detachment, does not add a row.

## Privacy and request consistency

Text and link-preview text are sent to the selected provider. Images are downloaded without credentials from X's media hosts and processed locally. The image model is loaded from the extension package only when an uncached image needs inference; it is not remote executable code.

API keys, allow overrides, score caches, and logs are stored in extension-local browser storage. Keys are not encrypted by this application. Blocked logs contain short post snippets, so treat them as browsing data.

The background worker serializes field-level settings changes from popups and inspectors. Concurrent edits to different settings preserve each other. Classification requests carry a provider and text-configuration revision. Obsolete queued requests are rejected, and obsolete in-flight responses cannot update the score cache or provider health state.

Historical single-key settings migrate into the selected provider's key slot only. The worker rewrites the normalized settings without the old shared-key field. Score-cache version 6 ignores earlier entries, including results that may have been cached under the wrong provider.

## Benchmark lab

```sh
npm run benchmark
```

The lab stores its state in `benchmarks/.data/benchmark.sqlite`. Keep that directory to preserve cases, labels, solutions, predictions, and reviews. Export state before making destructive changes to your corpus.

New databases start with ten cases: two images and eight synthetic AI-authored texts covering solicitation, innuendo, arousal bait, factual health/news/relationship discussion, and ambiguous examples. Synthetic text AI-origin labels record known provenance; they are not inferred from style. Unknown labels are excluded from that task's metrics. No model predictions are prefilled.

This is a small diagnostic corpus, not evidence of production accuracy. Add representative real posts with reviewed labels and known or unknown authorship before tuning thresholds. Precision, recall, and coverage are reported separately.

The current broad task is `sexualContent`, not the former narrow `explicit` task. During migration:

- Historical explicit-positive labels remain positive.
- Historical explicit-negative labels become unknown and need review under the broader policy.
- Historical explicit scores and their reviews are omitted rather than misrepresented as broad-policy scores. The sexual-content threshold resets to 0.5.
- AI-origin data, NSFWJS scores, cases, solution metadata, and unrelated thresholds are retained.

Existing databases keep their cases; the expanded initial corpus is not merged into user data automatically. New solution imports use `sexualContent` and `aiGenerated` probabilities, plus an optional `nsfwjs` object. State exports use schema version 2.

```json
{
  "name": "Reviewed Jev run",
  "type": "llm",
  "predictions": {
    "case-id": { "sexualContent": 0.78, "aiGenerated": 0.42 }
  }
}
```

## Verification

```sh
npm run compile
npm run lint
npm run format:check
npm test
npm run test:e2e
```

`npm run check` runs these checks together. Browser tests load the real built extension and bundled image model, but intercept provider and media requests. Unit tests substitute external inference while exercising filtering decisions, storage, and lifecycle transitions.

Provider HTTP tests use [MSW v3](https://mswjs.io/docs/quick-start) in the Node environment, with strict unhandled-request errors and per-test handler resets. These exercise real `fetch`, HTTP error redaction, probability decoding, network failure, and cancellation rather than replacing `fetch` with a stub. The Vercel SDK cancellation test retains its SDK mock.

Chromium tests use Playwright routing because MSW's Node interceptor does not reach the separate browser process and a page service worker cannot control the MV3 background worker's requests. Synthetic feeds cover controlled policy and recycling scenarios. `tests/e2e/x-capture.spec.ts` additionally replays authentic rendered X articles; discovery unit tests compare their extracted identities, note text, and photos with selected fields from the real `TweetDetail` response. See [capture provenance and MSW test-design notes](tests/fixtures/x/README.md). This is article replay, not a fabricated Twitter renderer or an offline copy of X.

The scrolling regression sends native wheel events through a virtualized feed, reuses article nodes, changes the URL with `history.replaceState`, and returns to earlier posts after exceeding detached-post retention. Separate navigation coverage checks iframe and top-frame commits.

Tests normally load this worktree's `.output/chrome-mv3`, not the extension configured in your regular browser. To check that installed artifact without rebuilding or overwriting it:

```sh
JEV_EXTENSION_PATH=/absolute/path/to/the/loaded/chrome-mv3 \
  npx playwright test tests/e2e/scroll.spec.ts
```

The report records the loaded path and SHA256 hashes of the manifest, background bundle, and content bundle. This launches an isolated Chromium profile; it does not attach to your logged-in X session. Reloading a different checkout's extension does not install this worktree's fixes.

## Code layout

- `src/entrypoints`: WXT wiring, popup, logs, and the on-demand image-inference script.
- `src/background`: classification queue, provider requests, serialized settings/log mutations, image fetch proxy, and toolbar state.
- `src/content`: DOM discovery, post lifecycle, filtering policy, score cache, classification orchestration, and inspector UI.
- `src/shared`: settings normalization, request/data contracts, and persistent logs.
- `benchmarks`: local evaluation UI, metrics, import/export normalization, and SQLite persistence.
- `tests/unit` and `tests/e2e`: deterministic regressions and Chromium scenarios.

Feed reports keep live scan statistics separate from page-load totals. Live analyzed/blocked, pending, failure, and retry statistics use attached posts. Cumulative totals retain post identities for the document lifetime, independently of the 200-detached-post retention limit. Attached posts are exempt from that limit. Evicted posts cannot apply late scan results to recycled articles.
