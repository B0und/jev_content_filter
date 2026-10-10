# Observing follow state

We trust X page scripts. The previous assumption that X might tamper with the extension is no longer part of this design. The observer has no signing key, background bootstrap, captured native methods, custom serializer or scripting permission.

The MAIN-world content script observes existing fetch and XHR responses from X API URLs. It leaves the page's requests intact and makes no extra API requests. Successful JSON responses go through a schema-backed extractor. Modern users carry a handle in `core.screen_name` and viewer-relative follow status in `relationship_perspectives.following`. Legacy users carry those fields in `legacy`, or directly on the user object. Modern values take precedence when both formats are present. Other fields are ignored. Directional `relationship.source` and `relationship.target` records are excluded because their source need not be the logged-in viewer.

The extractor emits `{ handle, following }` records with lowercase handles. Unrelated new response fields require no maintenance. Moving either field requires updating the supported wire schemas.

The observer publishes bounded snapshots through `window.postMessage`. The isolated receiver checks origin, message shape, viewer identity and publication order. These checks handle malformed data and stale responses; they do not authenticate page scripts.

The current profile link identifies the viewer. A changed or missing link clears observed relationships. Each request records the viewer epoch at its start, so an old account's delayed response cannot refill the new account's relationships. Per-author request sequences prevent an older response from replacing a newer follow or unfollow observation. Unknown follow state grants no exemption.

Relationships live only in page memory. The observer reads no cookies or request headers and persists no account graph. Text and JSON-mode XHR are supported.

Unit tests cover supported formats, malformed data, directional relationships, snapshot ordering and account changes. E2E tests click the fixture's refresh, switch-account and logout controls, toggle the extension setting, and verify filtered posts. They do not patch browser or object prototypes.
