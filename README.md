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
npm run format:check
npm test
npm run test:e2e
```

The browser-loop regressions exercise the actual toolbar popup, active-tab filtering, log collection after reload, watched build changes, background exceptions, and build-failure recovery. After a build, they can also be run alone with `npm run test:agent-browser`.

`npm run check` runs these checks together. Browser tests load the real built extension and bundled image model, but intercept provider and media requests. Unit tests substitute external inference while exercising filtering decisions, storage, and lifecycle transitions.

## Code layout

- `src/entrypoints`: WXT wiring, popup, logs, and the on-demand image-inference script.
- `src/background`: classification queue, provider requests, serialized settings/log mutations, image fetch proxy, and toolbar state.
- `src/content`: DOM discovery, post lifecycle, filtering policy, score cache, classification orchestration, and inspector UI.
- `src/shared`: settings normalization, request/data contracts, and persistent logs.
- `benchmarks`: local evaluation UI, metrics, import/export normalization, and SQLite persistence.
- `tests/unit` and `tests/e2e`: deterministic regressions and Chromium scenarios.

Feed reports use attached posts rather than the entire browsing history. Up to 200 detached posts are retained; attached posts are exempt from that limit. Evicted posts cannot apply late scan results to recycled articles.
