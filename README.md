# Jev Feed Filter

A Chromium MV3 extension that filters posts and link previews on X and Twitter. Text is evaluated by TypeSafe Jev through Vercel AI Gateway, TypeSafe AI, or OpenRouter. Images and video posters are classified locally with bundled NSFWJS MobileNetV2 weights.

## Development and installation

Use a current Node.js LTS release, preferably Node 24 or newer, and npm.

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
- Popup polling and log-page reads run through disposable runtimes. Settings writes and log actions cross into Effect at React event handlers; the background worker remains the owner of persistent mutations.
- `benchmarks/storage.ts` owns the lab's serialized saves in a `BenchmarkStorage` Layer. The Vite storage plugin scopes the SQLite connection to the server lifetime and consumes request bodies through an Effect Stream.

Promises remain at framework callbacks and native SDK adapters. Pure filtering policy, DOM discovery helpers, and benchmark metrics do not need an Effect runtime.

## Filtering behavior

- Lower thresholds block more content. Thresholds are probabilities between 0 and 1; the popup displays percentages.
- Sexual-text checks include explicit sexual content, lewd innuendo, heavily implied sexual content, and engagement bait designed to arouse. Factual news, health, and relationship discussion should remain allowed.
- The AI-written score is a classifier estimate, not proof of authorship.
- Drawings includes ordinary anime and illustrations, not only sexual content. Disable that category if you want nonsexual illustrations to remain visible.
- Link previews have separate scores and can be hidden without hiding the post.
- Pause restores hidden posts and previews. Unblocking a post persists an allow override.
- Failed checks do not produce a blocking score. Successfully checked parts can still block a post; previews with scan errors remain visible. Transient failures have bounded retries.
- Videos are checked through thumbnails/posters, not every frame. Thumbnail-size changes reuse the same scores; new thumbnail assets and late or replaced posters trigger another scan.
- Quoted-post content is included in filtering, but quoted timestamps and links do not replace the parent post's identity or its blocked-log link.

Use a post's filter control to inspect scores and change thresholds. The popup opens blocked-post and error logs. Links from the blocked log use review mode so the selected post remains visible.

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

## Code layout

- `src/entrypoints`: WXT wiring, popup, logs, and the on-demand image-inference script.
- `src/background`: classification queue, provider requests, serialized settings/log mutations, image fetch proxy, and toolbar state.
- `src/content`: DOM discovery, post lifecycle, filtering policy, score cache, classification orchestration, and inspector UI.
- `src/shared`: settings normalization, request/data contracts, and persistent logs.
- `benchmarks`: local evaluation UI, metrics, import/export normalization, and SQLite persistence.
- `tests/unit` and `tests/e2e`: deterministic regressions and Chromium scenarios.

Feed reports use attached posts rather than the entire browsing history. Up to 200 detached posts are retained; attached posts are exempt from that limit. Evicted posts cannot apply late scan results to recycled articles.
