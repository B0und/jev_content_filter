# Jev Feed Filter

A Chromium MV3 extension that filters posts and link previews on X and Twitter. Images use local NSFWJS MobileNetV2 and an Anime DBRating companion for sensitivity in drawings; AI-written text uses local E5-small q8. User-defined text filters use TypeSafe Jev through Vercel AI Gateway, TypeSafe AI, or OpenRouter. NSFWJS and E5 weights are downloaded and cached after startup; Anime DBRating weights are bundled with the extension.

## Development and installation

Use Node.js 22.13.0 or newer and npm. A current LTS release, preferably Node 24 or newer, is recommended. React Doctor requires Node 22.13.0 or newer on the Node 22 release line; MSW v3 requires at least Node 22.12.0.

```sh
npm ci
npm run dev
```

For a production build:

```sh
npm run build
```

Chromium 116 or newer is required for the offscreen inference document. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `.output/chrome-mv3`. Reload existing X tabs after installing or updating the extension. `npm run zip` creates a distributable archive.

The popup opens on **Filters**, with custom rules first and the local AI-text filter below. **Images** contains image categories, while **Settings** contains provider credentials, model downloads and privacy details. **Open workspace** opens the same controls in a full browser tab that stays open while you edit; its counters follow the X tab that opened it. Deleted custom filters can be restored with **Undo** while the view stays open. Local image and AI-text filtering need no API key. Under Text, open the Jev provider settings and enter that provider's key if you want Jev checks. Use **Add text filter** to name a rule, describe what to hide. New rules start at 65%; adjust the saved rule with its slider in 1% steps or enter a percentage. You can edit, enable, disable, or delete up to 20 rules. Filters are stored in extension-local browser storage and survive popup closure, worker restarts, and browser restarts. Each provider has its own key slot; changing providers never transfers another provider's key. Credentials come from extension settings, not build-time environment variables.

## Model selection and downloads

Enabled local models warm after background startup and settings changes while filtering is active. The popup shows download progress, readiness, errors, and retry actions. Downloads use pinned revisions and persistent browser caches; cached weights work when their origin is unavailable. First use requires network access and sufficient browser storage.

| Task              | Selected model             |    Model assets | Selection evidence                                                                                                                                                                                                                                                      |
| ----------------- | -------------------------- | --------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Images            | NSFWJS MobileNetV2         |          2.7 MB | Retained after a 25-image comparison. Both NSFWJS and binary Falconsai q4 scored 25/25; the smaller MobileNetV4 candidate scored 13/25. Falconsai required 56.8 MB and could not preserve separate image categories.                                                    |
| Anime sensitivity | Anime DBRating MobileNetV3 | 16.8 MB bundled | Reports general, sensitive, questionable, and explicit ratings. Tested on two user-reported posts; sensitive-or-higher scores were 93.0% and 93.5% for the first post's images and 95.3% for the second. These selected examples do not establish false-positive rates. |
| AI-written text   | E5-small LoRA q8           |         34.9 MB | On 120 balanced short English posts at threshold 0.50: accuracy 70.8%, F1 0.724, AUC 0.759, versus Jev accuracy 52.5%, F1 0.095, AUC 0.703. E5 was smaller and faster than the tested TMR q8 model.                                                                     |

These are diagnostic corpora, not general accuracy claims. At the preserved AI threshold of 0.65, E5 falsely flags 10/60 human examples and misses 29/60 generated examples. Scores are uncalibrated estimates, not authorship evidence. See the [text report](benchmarks/text-report.md) and [image report](benchmarks/image-model-report.md) for pinned sources, provenance, preprocessing, per-case results, and limitations.

Inference JavaScript, the ONNX WASM engine, and the Anime DBRating model are packaged. NSFWJS and E5 model data come from remote origins. No remote executable code is loaded. The catalog in `src/inference/model-catalog.ts` pins the model revisions. Total image weights are 19.6 MB, including the 16.8 MB bundled anime model.

## Effect tooling

The project uses Effect v4 release candidates with TypeScript 7 and `@effect/tsgo`. Compiler and lint integration versions are pinned in `package.json`; keep them compatible when upgrading. Import Schema from `effect/Schema`.

`npm ci` generates WXT types through `postinstall` and patches native TypeScript and Oxlint through `prepare`. If lifecycle scripts are disabled, run `npm run postinstall` and `npm run prepare` manually.

Run both `npm run compile` for TypeScript types and `npm run lint` for lint rules and Effect diagnostics. `.oxlintrc.json` extends the recommended Effect preset. The tsconfig plugin sets `diagnostics: false` to avoid duplicate reports while retaining editor refactors.

Oxlint rejects nested ternary expressions with `no-nested-ternary: error`. Use explicit branches for decisions and typed lookup records for static labels.

VS Code and Cursor settings enable the native TypeScript server at `node_modules/typescript/bin`. Enable TypeScript 7 editor support and select the workspace compiler as the sole TypeScript language server.

TypeScript configuration inherits WXT's bundled-app settings. The incremental cache lives in `.wxt/tsconfig.tsbuildinfo`; remove it after compiler upgrades if diagnostics are stale. The Effect integration uses the `@effect/language-service` plugin key and the installed `@effect/tsgo` schema.

Before writing Effect code, read `node_modules/effect/AGENTS.md` completely and follow its relevant links to bundled documentation and examples. Search `node_modules/effect/src` for public API signatures, JSDoc, and implementations when needed. Internal implementation techniques are not automatically suitable application patterns.

Prefer installed documentation and source when references differ. `AGENTS.md` contains the agent workflow.

## Runtime architecture

Effect owns asynchronous work; React and the DOM modules own rendering.

- `src/background/worker.ts` colocates `BackgroundWorker` and its Layer; `src/background/runtime.ts` builds the `ManagedRuntime` and registers browser listeners synchronously for MV3 worker wake-up. Three scoped consumers process classification jobs; admission is capped at three active requests plus 64 waiting. Semaphores serialize settings, log, status, icon, and tab-count mutations.
- `src/background/local-inference.ts` owns single-flight offscreen-document creation. The offscreen page hosts `src/inference/worker.ts`, an ES module worker with an Effect runtime and serialized inference. Image and AI graphs load independently and persist their downloaded assets through browser caches.
- Local inference admits one active request and at most eight waiting payloads. Overflow returns an error without interrupting active work. The five-minute execution deadline starts when a request is sent to the worker, covering model loading and inference. A deadline or worker error terminates the worker, rejects its pending requests, and marks model status as failed. The next request starts a replacement; late messages from the old worker are ignored.
- The offscreen page publishes model status through authenticated runtime messages; only the background writes extension storage. Offscreen documents have runtime access, not `chrome.storage`. A model-ready transition retries affected failed content checks without requiring a settings edit.
- `src/content/runtime.ts` builds a `ContentSession` Layer per WXT context. Scans and retry fibers belong to its Scope. Context invalidation restores the DOM and disposes the runtime, interrupting pending work.
- `src/content/classify.ts` composes cache reads, schema-decoded replies, independent filter/local-AI checks, scoring, and cache writes as Effects. Provider revisions and local-model identities prevent obsolete replies from reaching the cache.
- `src/platform/browser.ts` adapts native Promise APIs into interruptible Effects with `BrowserError`. Provider failures have a separate typed error; provider keys are redacted before errors leave the adapter.
- `src/entrypoints/popup/state.ts` and `src/entrypoints/logs/state.ts` expose snapshots through `useSyncExternalStore`. They own optimistic settings edits, pending log actions, storage reconciliation, and errors. React handlers call domain operations.
- Each open view scopes its reads and polling to a disposable runtime. Submitted writes run separately so closing the view does not cancel them. The background worker serializes settings changes and log clearing; unblock actions write persistent allow overrides.
- `src/filtering/schemas.ts` validates browser messages, stored log rows, status, settings acknowledgements, and tab reports before they enter application state.
- `benchmarks/storage.ts` owns the lab's serialized saves in a `BenchmarkStorage` Layer. The Vite storage plugin scopes the SQLite connection to the server lifetime and consumes request bodies through an Effect Stream.
- `benchmarks/state.ts` exposes the lab's snapshot through `useSyncExternalStore`. User edits submit serialized saves directly; hydration does not write the loaded or fallback dataset back to storage.

Promises remain at framework callbacks and native SDK adapters. Pure filtering policy, DOM discovery helpers, and benchmark metrics do not need an Effect runtime.

React follows [You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect): derived values are calculated during rendering, mutations run from user actions, and external stores use `useSyncExternalStore`. The remaining React Effects start and stop view-owned storage reads and polling. Logs tabs read the URL hash through an external-store subscription. A keyed API-key field resets visibility on provider changes without resetting the open diagnostics section.

## Filtering behavior

- Lower thresholds block more content. Thresholds are probabilities between 0 and 1; the popup displays percentages.
- Custom text filters read post text and text in attached images and link previews. English and Russian OCR runs locally with a bundled Tesseract.js core; language data is downloaded from the pinned Tesseract data host on first use and cached in the browser's IndexedDB, so adding another language does not add its traineddata to the extension package. The first use of an uncached language needs network access; later OCR uses the local cache. While filtering is active, OCR reads every discovered post and preview image, including posts without captions, even when all classifiers are disabled or no provider key is configured. Sending the extracted words to Jev still requires enabled text filters and a provider key. OCR results are cached per image. Failed extraction is reported and retried, while caption and visual checks can still complete. Small, stylized, or obscured lettering can be missed. AI-written-text checks use the caption only.
- The AI-written score is a classifier estimate, not proof of authorship.
- Drawings includes ordinary anime and illustrations, not only explicit content. Disable that category if you want ordinary illustrations to remain visible.
- Link previews have separate scores and can be hidden without hiding the post.
- The post the URL addresses is never filtered: a status permalink, or the detail view X opens over the timeline. Everything else on that page is filtered normally. Navigation triggers a render even for URL-only `pushState`, `replaceState`, and back/forward changes.
- Filtering masks posts in their original layout, including posts below the viewport. The author, avatar and native X menu/action controls remain visible. Text and media keep their native dimensions; an overlay aligns to the content column, follows native theme colors, explains the matching rule and offers **Show post**. Use the inspector to **Hide again**. Revealing changes visibility without expanding or collapsing the feed, and does not save an allow override. See [masking research](docs/filter-masking-research.md).
- Pause restores hidden posts and previews. Unblocking a post persists an allow override.
- The toolbar badge and popup totals count unique posts analyzed or blocked since page load. A post and its blocked preview count once. Timeline recycling, tab switches, unblocking, and log clearing do not subtract past blocks. Pause hides the badge without erasing the count; reloading or navigating to a new document resets it.
- Badge resets use top-frame `webNavigation.onCommitted` events. Same-document history updates and iframe navigation preserve totals. The extension requests `webNavigation` permission for this distinction.
- Failed checks do not produce a blocking score. Successfully checked parts can still block a post; previews with scan errors remain visible. Transient failures have bounded retries.
- Videos are checked through thumbnails/posters, not every frame. Thumbnail-size changes reuse the same scores; new thumbnail assets and late or replaced posters trigger another scan.
- Local image inference rejects images above 16,777,216 decoded pixels before canvas/tensor copies. The compressed download limit alone cannot bound those allocations; rejected images produce a scan error rather than a blocking score.
- Quoted-post content is included in filtering, but quoted timestamps and links do not replace the parent post's identity or its blocked-log link.

Use a post's filter control to inspect scores and change thresholds. The popup opens blocked-post and error logs. Links from the blocked log point at the post permalink, where the post stays visible on its own. The blocked log records hidden, attached content only. An opened or allowed post, or a scan completed after detachment, does not add a row.

The background worker acknowledges a clear with the rows it deleted under the log mutation lock. The page removes only those row versions, retaining posts and errors added afterward even if its next storage read fails. The page reports the read failure separately. Clearing scan errors does not clear the provider-health error.

Clearing requires the worker to read the stored rows first so its deletion receipt is accurate. If that read fails, the action reports a failure and leaves the saved rows unchanged.

## Privacy and request consistency

Post and link-preview text go to the selected provider only when text filters are enabled and the selected provider has a key. AI-written-text checks run locally. Images are downloaded without credentials from X's media hosts and processed locally. NSFWJS weights come from the pinned NSFWJS GitHub revision; E5 weights and tokenizer/config files come from the pinned Hugging Face revision. Model downloads do not include post text or images.

API keys, allow overrides, score caches, and logs are stored in extension-local browser storage. Keys are not encrypted by this application. Blocked logs contain short post snippets, so treat them as browsing data.

The background worker serializes field-level settings changes from popups and inspectors. Concurrent edits to different settings preserve each other. Classification admission and dispatch wait for earlier settings writes before reading provider credentials. Requests carry a provider and text-configuration revision: obsolete queued requests are rejected, and obsolete in-flight responses cannot update the score cache or provider health. Already-started external requests are not retroactively revoked.

Jev requests use AI SDK's experimental `experimental_decide` API with `boolean` questions and application-owned probability thresholds. Vercel uses its `decisionModel`; TypeSafe uses `@ai-sdk/typesafe-ai`. OpenRouter uses the same native Jev schema through the TypeSafe adapter with its HTTP destination set to OpenRouter's Decisions endpoint. SDK versions are pinned because this API is experimental. See the [TypeSafe provider documentation](https://ai-sdk.dev/providers/ai-sdk-providers/typesafe-ai).

Fresh installations get initial text filters from `src/filtering/presets.json`. You can edit or delete them like any other rule; deleting them stays deleted. Existing saved settings without a filter list load with no text filters, so upgrading does not enable remote text checks. All enabled filter instructions become questions in one decision call. Each rule gets a stable ID; instruction edits invalidate cached text decisions and rescan existing posts and link previews. Name and threshold edits reuse saved decisions. Failed decisions remain visible with an error instead of being hidden by a default score.

Historical single-key settings migrate into the selected provider's key slot only. The worker rewrites normalized settings without the old shared-key field. Score-cache version 7 ignores earlier entries and includes local model identity/revision and text-check type.

## Benchmark lab

```sh
npm run benchmark
```

The lab stores its state in `benchmarks/.data/benchmark.sqlite`. Keep that directory to preserve cases, labels, solutions, predictions, and reviews. Export state before making destructive changes to your corpus.

If the initial storage read fails, the lab shows the error and a Retry button. Editing and saving remain disabled until the saved dataset loads successfully.

New databases start with ten cases: two images and eight synthetic AI-authored texts covering solicitation, innuendo, arousal bait, factual health/news/relationship discussion, and ambiguous examples. Synthetic text AI-origin labels record known provenance; they are not inferred from style. Unknown labels are excluded from that task's metrics. No model predictions are prefilled.

This is a small diagnostic corpus, not evidence of production accuracy. Add representative real posts with reviewed labels and known or unknown authorship before tuning thresholds. Precision, recall, and coverage are reported separately.

**Import measured comparisons** adds the 120 text cases, 25 image cases, and seven recorded runs. It appends missing IDs without overwriting existing cases, labels, reviews, scores, or thresholds; repeated imports are idempotent. The measured corpora remain separate from the initial synthetic examples. Explicit image comparison uses `porn + hentai + sexy`, never `drawings`.

The current broad task is `contentMatch`, not the former narrow `explicit` task. During migration:

- Historical explicit-positive labels remain positive.
- Historical explicit-negative labels become unknown and need review under the broader policy.
- Historical explicit scores and their reviews are omitted rather than misrepresented as broad-policy scores. The content-match threshold resets to 0.5.
- AI-origin data, NSFWJS scores, cases, solution metadata, and unrelated thresholds are retained.

Existing databases keep their cases; the expanded initial corpus is not merged into user data automatically. New solution imports use `contentMatch` and `aiGenerated` probabilities, plus an optional `nsfwjs` object. State exports use schema version 2.

```json
{
  "name": "Reviewed Jev run",
  "type": "llm",
  "predictions": {
    "case-id": { "contentMatch": 0.78, "aiGenerated": 0.42 }
  }
}
```

## Verification

The agent browser keeps a Chromium session open and watches extension source files. It opens the real toolbar popup, collects console messages and uncaught exceptions from the popup, content script, and background worker, and automatically rebuilds and reloads after changes. Reload also refreshes the target tab so it receives the new content script.

```sh
npm run agent:browser -- start
npm run agent:browser -- doctor
npm run agent:browser -- inspect popup
npm run agent:browser -- logs background
npm run agent:browser -- verify
```

The default session serves the local X fixture with synthetic provider responses. It uses its own persistent profile and needs no login or API key. `start --headless` runs without a display. Install the bundled browser with `npx playwright install chromium` if it is missing; `EXTENSION_BROWSER_PATH` can select another Chrome/Chromium executable.

Changes under `src/` and `public/`, or to `wxt.config.ts` and package files, trigger build, reload, and smoke verification. `status` reports the latest generation, build output, and verification result. Failed builds preserve the running extension. `reload` explicitly rebuilds and reloads; `reload --no-build` loads an already-built extension. `verify` exits unsuccessfully for broken popup content or captured runtime errors.

`inspect feed` and `inspect logs` capture the target page and the extension's application log page. `logs` returns all collected console contexts; use `logs --since=N` to read entries after a previous sequence number. Screenshots, DOM snapshots, `console.jsonl`, and `verification.json` are saved under `.wxt/extension-agent/artifacts/`. Popup screenshots mask the API-key input.

The agent can also interact with the running extension:

```sh
npm run agent:browser -- click popup '[aria-label="Enable filtering"]'
npm run agent:browser -- eval background 'chrome.runtime.getManifest().version'
```

`fill <surface> <selector> <value>` edits a form control. `eval <surface> <expression>` evaluates JavaScript in `popup`, `feed`, `logs`, or `background`. `doctor` emits known messages in the actual popup, content script, and worker and requires all three collectors to receive them.

For real X browsing, stop the fixture session and start a live session:

```sh
npm run agent:browser -- stop
npm run agent:browser -- start --live
```

Sign in and configure the extension in that browser. The live profile is separate from the fixture profile. Its verification checks the popup and runtime errors; the fixture-specific injection assertion runs only in fixture mode. This debugger session keeps worker inspection attached, so use the existing lifecycle tests separately when checking idle-worker behavior. `stop` closes the browser and watcher; `start --no-watch` disables automatic rebuilds.

```sh
npm run compile
npm run lint
npm run doctor
npm run format:check
npm test
npm run test:e2e
```

`npm run check` runs these checks together. `npm run test:e2e` builds the extension and runs Chromium scenarios. Browser tests download the pinned model weights from their real origins on a cold browser profile and reuse them from the profile's caches afterwards, so the suite needs network access for its first model load. Playwright routing intercepts provider and media requests, but not requests made by the offscreen inference document or its module worker, so it cannot substitute or block model downloads. Offline coverage closes the offscreen document, recreates its inference worker and graph, and classifies again; reusing cached weights before a fetch is covered by the download unit tests. Unit tests substitute external inference while exercising policy, storage, and lifecycle transitions.

[React Doctor](https://www.react.doctor/) is installed as a development dependency. `npm run doctor` runs a full scan and fails on warnings or errors; `npm run check` includes it. Generated `.output`, `.wxt`, `playwright-report`, and `test-results` files are excluded. Source rules remain enabled. The command disables the remote score API and crash reporting with `--no-score`.

Provider HTTP tests use [MSW v3](https://mswjs.io/docs/quick-start) in the Node environment, with strict unhandled-request errors and per-test handler resets. These exercise real `fetch`, HTTP error redaction, probability decoding, network failure, and cancellation rather than replacing `fetch` with a stub. The Vercel SDK cancellation test retains its SDK mock.

Chromium tests use Playwright routing because MSW's Node interceptor does not reach the separate browser process and a page service worker cannot control the MV3 background worker's requests. Synthetic feeds cover controlled policy and recycling scenarios. `tests/e2e/x-capture.spec.ts` additionally replays authentic rendered X articles; discovery unit tests compare their extracted identities, note text, and photos with selected fields from the real `TweetDetail` response. See [capture provenance and MSW test-design notes](tests/fixtures/x/README.md). This is article replay, not a fabricated Twitter renderer or an offline copy of X.

The scrolling regression sends native wheel events through a virtualized feed, reuses article nodes, changes the URL with `history.replaceState`, and returns to earlier posts after exceeding detached-post retention. Separate navigation coverage checks iframe and top-frame commits.

Tests normally load this worktree's `.output/chrome-mv3`, not the extension configured in your regular browser. To check that installed artifact without rebuilding or overwriting it:

```sh
JEV_EXTENSION_PATH=/absolute/path/to/the/loaded/chrome-mv3 \
  npx playwright test tests/e2e/scroll.spec.ts
```

The report records the loaded path and SHA256 hashes of the manifest, background bundle, and content bundle. This launches an isolated Chromium profile; it does not attach to your logged-in X session. Reloading a different checkout's extension does not install this worktree's fixes.

The browser-loop regressions exercise the actual toolbar popup, active-tab filtering, log collection after reload, watched build changes, background exceptions, and build-failure recovery. After a build, they can also be run alone with `npm run test:agent-browser`.

## Code layout

- `src/entrypoints`: WXT wiring, popup, logs, and the offscreen inference page.
- `src/inference`: inference contracts, pinned model catalog, downloads, browser caches, graph adapters, readiness, and the module worker.
- `src/background`: classification queue, local-inference transport, provider requests, serialized settings/log mutations, image fetch proxy, and toolbar state.
- `src/content`: DOM discovery, post lifecycle, filtering policy, score cache, classification orchestration, and inspector UI.
- `src/filtering`: settings normalization and filtering category, request, and data contracts.
- `src/history`: persistent blocked-entry and scan-error logs.
- `src/platform`: native browser adaptation and the Effect bridge.
- `benchmarks`: local evaluation UI, metrics, import/export normalization, and SQLite persistence.
- `tests/unit` and `tests/e2e`: deterministic regressions and Chromium scenarios.

Modules shared by several execution contexts live with the domain that owns them, not in a generic `shared` folder. Stateful Effect services colocate their Layer; each host composes its runtime at its integration entrypoint. Keep pure helpers and schemas as ordinary modules. The [domain structure research](docs/effect-domain-structure-research.md) records the article's recommendations, installed Effect guidance, and policies deliberately not adopted.

Feed reports keep live scan statistics separate from page-load totals. Live analyzed/blocked, pending, failure, and retry statistics use attached posts. Cumulative totals retain post identities for the document lifetime, independently of the 200-detached-post retention limit. Attached posts are exempt from that limit. Evicted posts cannot apply late scan results to recycled articles.

Author exceptions are available from the blocked-post notice. The secondary **Skip a filter for @handle** action opens a confirmation dialog, with Cancel focused by default. Choose one matched category and save; other filters continue to apply. Settings → Who to filter lets you remove saved exceptions or select categories to exempt for followed accounts. Author exceptions are saved by normalized @handle in this browser. X account renames require a new exception.

Follow status comes from explicit viewer-to-author relationships in X's existing responses, with no additional API requests. Unknown status stays filtered; a confirmed unfollow restores filtering. The setting changes blocking decisions rather than deleting scores or suppressing all classification work. Follow relationships stay page-local. A per-document authenticated observer rejects page-forged updates, ambiguous directional relationships and obsolete snapshots. Exemption consumption synchronously checks the current profile identity so account transitions deny old exemptions before an asynchronous reset completes. It observes native fetch responses and privately parsed text XHR responses; JSON-mode XHR is ignored because its parsed object can be changed by page listeners. The `scripting` permission initializes that observer in the current X document; it adds no API calls or credential access. See [the trust analysis](docs/follow-observation-trust-research.md).

Drawn-content Hentai decisions now require agreement with the bundled independent explicit-rating model. Suggestive drawn-content scores use questionable/explicit ratings; sensitive alone does not trigger this stricter boundary. These are conservative model agreement scores, not calibrated probabilities. A failed verifier reports an incomplete check and omits unverified Hentai. The pipeline revision invalidates earlier image scores. See [the detector research](docs/image-detector-research.md) for sources and replacement-model tradeoffs.
