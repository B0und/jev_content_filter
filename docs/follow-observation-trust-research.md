# Trusting observed follow state

Research date: 2026-10-09. Scope: authenticate the follow-observer bridge without new X API calls, cookie/header access or persisted account relationships.

## The original message was forgeable

Before this repair, `receiveFollowState` accepted a same-window, same-origin `jev-follow-state` message whose schema matches. Page JavaScript can send exactly that message. A fabricated `following: true` grants the optional exemption, and an oversized epoch can prevent later real updates from replacing it. Schema validation, an origin check and a public nonce do not identify which same-origin script sent a message. MDN recommends checking sender origin and syntax, but neither distinguishes scripts sharing that origin. [Window.postMessage](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)

Chrome separates extension content-script variables from page variables in its isolated world. MAIN is shared with page JavaScript, and the DOM is shared across worlds. Static `document_start` scripts run before other page scripts; asynchronous programmatic injection does not offer that same ordering guarantee. This makes early capture relevant, while DOM viewer identity remains untrusted. [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)

## Recommendation

Authenticate published observation packets with a per-document HMAC key supplied through extension runtime messaging and `scripting.executeScript` arguments. Keep the receiver and verification key in the isolated world. Keep the observer's signing key in a closure, never DOM attributes, postMessage traffic, globals containing raw keys, logs or persistent settings.

However, a self-contained MAIN function injected after an asynchronous background round trip cannot safely assume MAIN crypto and network methods are pristine. A page-patched `crypto.subtle.importKey` can read its supplied key; a page-patched fetch or response parser can fabricate the data it signs. Capturing methods at that later time only captures their current values. HMAC then authenticates poisoned input, not native observations. This is an implementation inference from shared MAIN execution, not a Chrome guarantee of authenticated network provenance.

For stronger protection against ordinary page scripts, retain a minimal static MAIN `document_start` initializer. It captures required intrinsics before page scripts run and installs a read-only, nonconfigurable initializer callable, with captured references in its closure. The later injected function invokes that callable with the per-document key. `Object.defineProperty` supports a property that cannot be replaced or deleted; keep its descriptor non-writable and nonconfigurable. [Property descriptor semantics](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/defineProperty)

A page can call that public initializer first with its own key or later request reinitialization. This must cause rejection or loss of observations, never acceptance by the isolated verifier. The extension verifier accepts only its expected channel/key. Do not provide a callable that signs arbitrary page-supplied payloads. A public signing oracle would defeat the MAC.

If the implementation cannot guarantee early intrinsic capture and defend all observer input paths, describe the bridge as protection against direct message forgery only. A simpler safe fallback is to leave follow status unknown and keep filtering; do not silently retain the forgeable exemption path.

## Bootstrap and packet design

The background handler validates the extension sender, exact allowed HTTPS X/Twitter origin, top-level frame and sender document ID. Use browser-provided `sender.tab.id` and `sender.documentId`, not payload-supplied targeting. Bind injection to that document to prevent a navigation race installing a key into the replacement document. Chrome exposes those sender fields. [runtime MessageSender](https://developer.chrome.com/docs/extensions/reference/api/runtime#type-MessageSender)

`scripting` requires its permission and host permission. A function injection must be self-contained; serializable arguments can carry a byte array or encoded key. Chrome supports MAIN selection and document-ID targets; establish the minimum supported Chrome version for document IDs. MAIN initialization should return only status, never the key. [Scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting)

Generate a fresh 256-bit HMAC-SHA-256 key in an isolated extension context. Import it non-extractable with only the required sign or verify usage. Non-extractable prevents later key export; it does not erase raw import bytes or protect them from an already patched importer. Use native Web Crypto verification instead of handwritten comparison. [Key import](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/importKey), [HMAC signing](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/sign), [Signature verification](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/verify)

The implemented protocol signs exact bytes of a bounded canonical payload containing a monotonic publication sequence, viewer epoch and complete validated user snapshot. A fresh per-document key separates channels. Send an immutable payload string plus MAC. Verify its byte limit and MAC before parsing or advancing any epoch/sequence. A public channel ID separates sessions but is not the secret. Reject duplicate/older publication sequences and require safe integers. A forged huge epoch with an invalid MAC must have no effect.

Publish complete authoritative snapshots and replace receiver state only with the newest verified sequence. This makes independently completed signing and verification safe without relying on promise completion order. Web Crypto returns promises; without ordering, a later epoch or update could apply before an earlier verification completes. Keep per-author request sequencing separate from packet publication sequencing. Include empty epoch-reset packets in the authenticated stream. Receiver teardown clears key, sequence, epoch and relationships; a fresh document gets a fresh channel. Unknown or failed bootstrap remains filtered.

Capture all methods used on security-sensitive paths, not just fetch: native response getters, `Response.clone`/JSON parsing, crypto methods, text encoding, Promise continuation operations, event registration and necessary object/array operations. Invoke captured functions with correct receivers. Do not pass a secret through an attacker-installed setter. JSON traversal should read only own validated properties and remain bounded; later prototype mutations must not turn missing fields into invented relationships.

A small MAIN collector should use primitive type checks and captured own-property access, rather than importing the application's general schema runtime. Traverse JSON-only response objects with a bounded numeric-index stack. Capture `Reflect.apply` before page scripts instead of relying on subsequently mutable `.call`/`.apply`; likewise capture explicit Promise continuation methods if they are used.

Capturing `JSON.stringify` alone is insufficient: its normal algorithm still calls an inherited `toJSON` method. A later page-added `Object.prototype.toJSON` or `Array.prototype.toJSON` could modify producer-created payloads before they are signed. Build payload/row objects with null prototypes and shadow `toJSON` on any arrays, or use a canonical primitive-only serializer. The same concern applies to constructing a typed array from a secret argument array: an inherited iterator can run page code. Allocate the byte array by length and copy validated own numeric values. [JSON.stringify serialization behavior](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify), [TypedArray construction](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/TypedArray)

For XHR, page code can synthesize load events and set shadowing own properties. Use captured native response/status/URL getters on a valid native XHR receiver rather than trusting `this.status` or `this.response` property lookup. Request endpoint and response URL checks still apply. Avoid any new credential/header reads.

Response cloning consumes a second body stream; MDN notes that unread data may be buffered without a limit. Restrict inspection to existing relevant JSON endpoints, consume the clone promptly and apply traversal/publication limits. Do not clone all media or unrelated responses. [Response.clone](https://developer.mozilla.org/en-US/docs/Web/API/Response/clone)

## What this does and does not establish

The MAC establishes that a packet came through the keyed observer path and was not altered or fabricated directly on the message channel. With pristine captured primitives, it also limits later page monkeypatching of those particular paths. It does not authenticate the inferred viewer: the own-profile navigation link is page DOM and can be edited. Account changes must clear observed relationships, and identity uncertainty must grant no exemption.

It does not protect against malicious code that ran before capture, another privileged extension tampering with the same world, a compromised browser or X serving dishonest relationship data. Page code can suppress observation, remove controls, alter DOM, trigger real requests or block messages. These can cause denial of service or visual changes. Do not claim the page is generally unable to influence filtering.

Moving parsed observation packets from an isolated content script to the worker uses extension messaging, but receiving worker messages still requires sender and payload validation. Chrome advises treating content scripts as less trustworthy than the worker. [Extension message security guidance](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)

Chrome's standard `webRequest` API observes request lifecycle and headers but exposes no response-body callback. It therefore does not supply a drop-in isolated response parser for this passive approach. Adding a debugger or credential-backed re-fetch would materially expand permissions or behavior and falls outside this design. [Chrome webRequest API](https://developer.chrome.com/docs/extensions/reference/api/webRequest)

## Required adversarial browser checks

Test a page-forged valid-shaped update and huge epoch; wrong MAC; edited authenticated payload; replay; cross-channel replay; reordered async verification; account transition with an old response in flight; navigation during bootstrap; duplicate initialization; malformed/oversized messages; and missing crypto/injection failure. Every failure must preserve filtering and allow later valid updates where appropriate.

Also monkeypatch MAIN crypto/fetch/response methods after early capture, synthesize XHR load events with own fake properties, and try to replace the bootstrap callable. Verify the collector still uses captured paths or fails closed. A test that patches primitives before a late-only injection should demonstrate its known limitation rather than claiming the HMAC fixes it.

## Implemented additional safeguards

API matching accepts only exact HTTPS x.com/twitter.com response origins and supported API paths. Captured native RegExp.exec avoids an overridden regular-expression exec method. Captured own-property definitions write traversal, snapshot and signature array slots so inherited numeric setters cannot change native observations. Receiver teardown invalidates pending key imports as well as the installed key.

JSON-mode XHR is deliberately ignored: its native getter returns the same mutable parsed object available to page listeners, which can edit it before the observer runs. Fetch clones and native text XHR privately parsed with the captured JSON parser remain supported. This narrower observation support fails closed for unknown followed-account status.

## Viewer-relative interpretation and transition barrier

Directional `relationship.source` / `relationship.target` records are excluded, because their flags describe a source-to-target relationship rather than necessarily the active viewer's relationship to an author. Other supported viewer-relative user shapes remain available.

Signed snapshots include the producer's observed viewer handle. The isolated receiver independently reads the current native profile link before verification and before committing its result. Exemption consumption checks that identity synchronously, clears old relationships on a change or missing link, and invalidates pending verification across that transition. Old-viewer snapshots cannot refill the buffer while the authenticated reset is still in flight. This is a consistency barrier, not authentication of DOM account identity.
