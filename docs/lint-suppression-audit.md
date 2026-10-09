# Lint suppression audit

The audit started at commit `128e273`. Application, benchmark, script and test sources contained 62 lint disable comments. The cleanup removes 27, leaving 35. There were no TypeScript ignore, expect-error or nocheck comments. The vendored anti-slop sources contain no disable comments either. Generated output and dependencies are outside this count.

Oxlint already provides 13 of the compiler rules previously also enabled under the `react-compiler` alias. The configuration now runs those checks once through the built-in React plugin. The JavaScript plugin retains only `config` and `gating`, which have no built-in counterpart.

Removed suppressions now have concrete replacements:

- Benchmark migration decodes snapshot dictionaries and lists before calling its migration functions. The SQLite store accepts benchmark state; imported data goes through migration first.
- Cache eviction decodes timestamps with Schema and assigns malformed entries the oldest timestamp.
- Pending inference requests record their expected operation. The reply registry validates the correlated payload, rejects malformed or mismatched results, ignores cancelled and duplicate replies, and clears pending work after worker failure.
- The background worker declares its reply union instead of returning `unknown`. Its browser response callback accepts that union.
- Log virtualization publishes copied, stable snapshots through `useSyncExternalStore`. React no longer renders from the mutable TanStack hook result. All three `use no memo` directives and the incompatible-library suppression are gone.
- Browser readiness probes wait for globals installed by their own scripts. Settings tests bring raw storage values back to the test process for schema decoding.
- Security tests use declared page capabilities and direct calls where their types support it. Prototype restoration saves full property descriptors rather than unbound methods.

## Remaining comments

These exceptions preserve checked browser inputs or test the page tampering defenses. They are local to the statements listed below; no lint rule was weakened or moved into a file-wide exclusion.

| File                                      | Comments | Why they remain                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------- | -------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/background/runtime.ts`               |        1 | Browser messages arrive untrusted. The listener checks the request type and full request schema before dispatch. Keeping `unknown` prevents unchecked property access.                                                                                                                                                                                        |
| `src/content/runtime.ts`                  |        1 | The report listener validates browser messages before responding.                                                                                                                                                                                                                                                                                             |
| `src/entrypoints/inference/main.ts`       |        1 | The inference listener checks extension identity, sender context and the request schema before dispatch.                                                                                                                                                                                                                                                      |
| `tests/unit/support.ts`                   |        1 | The fake background uses the same raw message contract and schema validation as production. Removing the annotation would inherit the browser library's permissive input type.                                                                                                                                                                                |
| `src/content/native-follow-parser.ts`     |        8 | The MAIN-world parser handles heterogeneous native JSON. It reads own data descriptors, uses captured string and regexp methods, and writes queue entries with captured `defineProperty`. Direct primitive checks cannot depend on helpers a page may replace. The two unbound methods are always invoked with their original receivers.                      |
| `src/entrypoints/follow-state.content.ts` |       15 | Response, Promise, Element, regexp, string and XHR methods/getters are captured at document start and invoked with their native receivers. The XHR getter block covers four getter declarations. Primitive guards check outputs from captured native calls. The only raw-data callback parses a fresh native JSON body before publishing typed follow states. |
| `tests/e2e/author-exceptions.spec.ts`     |        7 | Three method captures and a Promise.then replacement observe when an old-account response finishes. One Reflect.apply call preserves Promise.then's generic overload, which Function.call loses. Two primitive checks inspect deliberately hostile page values. These probes must execute inside the page.                                                    |
| `tests/unit/relationships.test.ts`        |        1 | An array prototype setter deliberately changes object values to prove the native parser does not invoke it when collecting relationships.                                                                                                                                                                                                                     |

Replacing captured calls with ordinary prototype calls would allow page patches to forge followed-account exemptions. Replacing raw browser inputs with domain annotations would claim validation happened before the listener, which the browser does not guarantee. Those changes would make the lint count smaller while weakening the code.

## Regression coverage

The inference reply tests cover malformed scores, operation mismatches, encoded OCR success and failure, duplicate replies, cancellation and worker failure. The log browser regression covers 500 rows, variable heights, scrolling, a narrow viewport, unblocking, a same-length reorder, tab remounts and clearing.

The existing relationship tests cover native fetch and XHR observations, unfollowing, viewer changes, stale responses, forged messages, external response rejection, patched native methods, array setters, toJSON hooks and mutable JSON-mode XHR bodies. The MAIN-world parser is now independent of the isolated-world relationship store and Effect schemas. Its production script shrank from 74.06 kB to 4.68 kB.
