# Authentic X captures and network-test design

## Provenance

`orca-public-thread/` was captured from the public thread at https://x.com/OrcaRouter/status/2105364729422344549 using the connected browser relay. Each HTML file is the corresponding rendered X article, not an article built from JSON by our own renderer. The three articles cover a long note tweet with a photo and quoted text, a link-only reply rendered as a card, and a text reply with a card.

`tweets.json` contains selected public tweet results from the actual `TweetDetail` GraphQL response received when that thread was loaded. It preserves the selected fields' API structure and values. It is a sanitized response extract, not the complete response envelope. Request URLs, headers, cookies, authorization, viewer state, cursors, unrelated replies, and profile metadata beyond public identity were not saved. Extension-injected elements and attributes, scripts, styles, and event-handler attributes were removed from article clones before saving.

The captures intentionally retain X's own markup, classes, inline styles, public links, counters, and media URLs. Tests do not assert counters, class names, prose wording, or timestamps. Network access in Chromium is intercepted, including media; no account credentials or real classifier keys are used.

## What the tests prove

- `content-x-capture.test.ts` runs production `readArticle` against captured markup. Public API fields independently identify the post, its author handle, full note text, and photo. This catches legacy-text truncation, wrong post identity, loss of link-only posts, and avatars incorrectly treated as filterable media. Quoted text remains included by the existing filtering policy.
- `x-capture.spec.ts` loads the built extension over those same article captures in Chromium. Controlled classifier responses let it prove that an addressed post stays visible, neighboring text hides, a link-only reply remains visible while its preview hides, and URL-only navigation moves the exemption.
- This is offline article replay, not an offline copy of X's application. We do not synthesize a Twitter renderer or make the extension call an API it does not use. Existing synthetic fixtures remain useful for deterministic recycling and error scenarios.

## MSW v3 research

The relevant official guidance was checked before adding network tests:

- [Quick start](https://mswjs.io/docs/quick-start) and [Node integration](https://mswjs.io/guides/integrations/node): `msw/http` handlers and `msw/node` interception, enabled before tests, reset between tests, closed afterward. Provider network tests run in Node rather than replacing global `fetch`.
- [Avoid request assertions](https://mswjs.io/guides/best-practices/avoid-request-assertions): assert application results, not request counts or handler calls. Request validity belongs in endpoint behavior. Strict `onUnhandledFrame: 'error'` prevents unknown Node requests from reaching live endpoints.
- [Network behavior overrides](https://mswjs.io/guides/best-practices/network-behavior-overrides): per-test `server.use` overrides take precedence; `resetHandlers` removes them so error scenarios cannot leak into subsequent tests.
- [Mocking HTTP](https://mswjs.io/docs/http/) and [mocking responses](https://mswjs.io/docs/http/mocking-responses/): use web-standard requests and `HttpResponse` responses; retain production request code rather than stub `fetch`.
- [Network errors](https://mswjs.io/docs/http/mocking-responses/network-errors): `HttpResponse.error()` models a failed fetch. It is distinct from a normal HTTP error status; throwing an arbitrary handler error is not a network-error fixture.
- [Browser setup](https://mswjs.io/api/setup-worker): browser interception requires a page-controlled service worker. Node interception does not reach the separate Chromium process, and a page worker does not control the extension's MV3 background worker. Chromium replay therefore retains Playwright routing; MSW exercises provider HTTP behavior in Node.

Actual X JSON is used as a discovery reference, not registered as an unused MSW endpoint. Provider responses remain controlled scenarios, not claimed recordings. These two inputs have different jobs and different provenance.
