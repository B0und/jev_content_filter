# Effect structure by domain: research and local fit

Research checked 2026-10-06. The installed package is `effect@4.0.0-rc.118` (`node_modules/effect/package.json:4`). I checked the article against its cited posts, the article's pinned Effect source links, the installed `node_modules/effect/AGENTS.md`, and the installed `ai-docs` for services, Layers, schemas, runtimes, scopes, and tests.

## What the article recommends, and what Effect requires

The [article](https://ratstack.sh/lore/structure-effect-by-domain) draws its folder and per-file advice from [Sam Goodwin's post](https://x.com/samgoodwin89/status/2107204053151428850): organize by domain rather than mechanism, colocate a service and Layer, and assemble dependencies at an entrypoint. [Justin Bennett's question](https://x.com/just_be_dev/status/2107194260860613059) explicitly leaves the layout dependent on product and complexity. These are useful conventions, not Effect folder rules.

Effect's installed [service guidance](../node_modules/effect/AGENTS.md) calls `Context.Service` the default and recommends services for behavior. Its [service example](../node_modules/effect/ai-docs/src/01_effect/03_services/01_service.ts) puts the service and `static layer` together. The installed [Layer composition guide](../node_modules/effect/ai-docs/src/01_effect/03_services/20_layer-composition.ts) composes focused Layers with `Layer.provide` or `Layer.provideMerge`. Neither document mandates a directory layout or one service per file. The article's pinned [Context.Service source](https://github.com/Effect-TS/effect/blob/67ba4e46a11ccda0b6761578bfd22c04ae00167d/ai-docs/src/01_effect/03_services/01_service.ts) and [Layer source](https://github.com/Effect-TS/effect/blob/67ba4e46a11ccda0b6761578bfd22c04ae00167d/ai-docs/src/01_effect/03_services/20_layer-composition.ts) distinguish a service contract from the Layer that supplies it.

## The domain moves here

This is a relocation, not a redesign. The ownership map is:

| Move                                                                                                       | Why it fits                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shared/types.ts`, `shared/schemas.ts`, `shared/settings.ts` → `filtering/`                                | These define filtering settings and category/message contracts. Keep their accepted values, validation, storage compatibility, and request/reply shapes unchanged. |
| `shared/log.ts` → `history/log.ts`                                                                         | It owns the blocked-entry and scan-error history.                                                                                                                  |
| `shared/inference.ts` → `inference/contracts.ts`; `shared/model-catalog.ts` → `inference/model-catalog.ts` | The former defines inference worker/status schemas and types; the latter owns model metadata.                                                                      |
| `shared/browser.ts` → `platform/browser.ts`                                                                | It adapts the browser API, rather than defining filtering or inference policy.                                                                                     |

Migrate imports to the new owners without compatibility re-exports. `Schema` remains the boundary for settings, background requests/replies, reports, and inference-worker messages. The installed schema guide describes schemas as runtime validators and static models (`node_modules/effect/ai-docs/src/01_effect/02_schema/10_schema-basics.ts:9-33`). Moving those definitions does not call for changing their wire formats or validation.

Keep credential behavior with the settings/provider flow. The settings code preserves per-provider keys and only maps the historical single `gatewayKey` to its selected provider; provider errors redact the key before reporting. The move must not add environment-key fallbacks or transfer credentials between providers (`src/filtering/settings.ts:28-38,69-85`; `src/background/text-provider.ts:113-123`).

## Service, Layer, and runtime boundaries

`src/background/worker.ts` now owns `BackgroundWorker` and its `static layer`; `src/background/runtime.ts` stays the WXT/MV3 integration root. This matches Effect's service example without moving browser event wiring into the service. `startBackground` registers MV3 listeners synchronously before invoking initialization effects. The worker Layer owns its settings/state and admission controls, including three active classification jobs and at most 64 waiting jobs.

Effect's [ManagedRuntime guide](https://github.com/Effect-TS/effect/blob/67ba4e46a11ccda0b6761578bfd22c04ae00167d/ai-docs/src/04_integration/10_managed-runtime.ts) describes a runtime as a bridge for imperative framework handlers, shared across that host, with disposal when the host shuts down. The installed counterpart is `node_modules/effect/ai-docs/src/04_integration/10_managed-runtime.ts:60-69,118-128`. Here each integration owns its runtime; do not turn `Effect.provide` into a per-module requirement. The content script already has its own root: `startContentFilter` builds `ContentSession.layer(ctx)`, disposes the runtime on context invalidation, and returns only while that content context is valid (`src/content/runtime.ts:83-117,629-660`).

The content session's `Scope` owns scan, reporting, and retry fibers via `Effect.forkIn`; canceled retries are interrupted in that scope. Runtime disposal therefore closes work with its content-script owner. Keep this lifecycle and the worker's existing concurrency bounds intact. The installed resource guidance shows that Layer scopes own resource release (`node_modules/effect/ai-docs/src/01_effect/05_resources/10_acquire-release.ts:28-44`; `20_layer-side-effects.ts:20-27`).

## Policies not to import wholesale

- **No XState migration.** The article labels XState lifecycle machines as rat-stack policy, not an Effect requirement. These moves add no new finite mode/event protocol; the content script already ties child work to a `Scope` and invalidates it with its WXT context.
- **No cartridges.** The article's cartridge/capability projections are its package architecture, not an Effect service or Layer requirement. This change specifies module ownership inside one WXT extension, not a new capability package boundary.
- **No universal mock ban.** The installed Layer-testing guide demonstrates test Layers and shared Layer lifetime (`node_modules/effect/ai-docs/src/09_testing/20_layer-tests.ts:84-117`), but does not require replacing every fake or mock. This repo tests through `fakeBrowser` and mocks the external AI provider while keeping extension decisions and storage real (`tests/unit/background.test.ts:1-29`). Popup behavior already has an explicit dependency seam (`tests/unit/popup-state.test.ts:39-53`). Preserve those tests and use the seam that fits each boundary.
- **No blanket service-wrapper migration.** `AGENTS.md` recommends services for behavior, but that is not a direction to wrap every schema, pure helper, or Effect-returning function in `Context.Service`. Apply the pattern when a named behavior owns dependencies or state that benefit from construction-time capture and Layer substitution. The module moves alone are not a reason to add service tags or more runtimes.

The distinction is practical: use the domain folders to make ownership visible, colocate the existing worker service and Layer, and leave WXT listener registration, schema behavior, credentials, and scoped work at their current boundaries.
