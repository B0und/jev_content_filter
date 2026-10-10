# Test audit

The audit reduced 271 reported cases to 262: 193 unit cases, 54 E2E scenarios,
6 browser integration scenarios, and 9 browser-loop results. The last count
includes a parent Node test that aggregates seven subtests; there are eight
independent browser-loop scenarios.

Most tests caught useful faults. The main problems were repeated scenarios and
assertions that did not test what their names promised.

## Removed coverage

| Removed case or variants                | Reason and retained coverage                                                                                                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Separate background startup status test | It never suspended settings loading. Combined with an immediate listener-registration assertion and a real status reply.                                                                               |
| Link-only captured reply unit case      | It checked identity and empty fields, but not card extraction. The captured-X browser scenario checks that the real card is filtered.                                                                  |
| Reattached-post unit case               | The duplicate-binding lifecycle scenario already verifies retained scores, detachment, reattachment, recycling, and provider call counts.                                                              |
| Media-size churn lifecycle unit case    | It passed when media-size normalization was removed. The browser scenario detects that mutation and checks visible flapping; the distinct video-thumbnail regression remains.                          |
| Four threshold-race variants            | All six variants detected the same concurrency-guard fault. Retained one custom-filter case and one built-in-category case. The configuration E2E separately checks debounce and popup-close flushing. |
| Pending-threshold cancellation scenario | Removing cancellation still passed because the background concurrency guard protected the saved value. The retained race scenarios test that protection directly.                                      |

These changes remove nine reported cases without removing the distinct behaviors
listed above.

## Repaired assertions

- Check listener registration immediately after starting the background worker;
  the previous assertion ran after an await and accepted deferred registration.
- Await the senderless badge request's actual reply before checking storage;
  the old test accepted a write attributed to an invalid tab.
- Give the missing-prediction metrics test an actually missing prediction and
  assert incomplete coverage.
- Compare a captured media URL with a literal expected URL rather than calling
  the production normalizer to construct the expectation.
- Check the inspector threshold in a newly opened popup after saving. The old
  scenario passed when every settings write was discarded.
- Serve the same image on the timeline and the opened-post fixture, then wait
  for scanning to finish. Previously the second document had no image and
  passed with opened-post protection removed.
- Assert the actual order of inspector table rows, in addition to section
  headings. Moving the image table before the text table previously passed.
- Assert normalized empty benchmark solutions directly and give the test a
  name matching its malformed-input behavior.

## Fault experiments

I ran 243 temporary mutation trials: 211 against unit tests, 23 against
Playwright scenarios, and 9 against browser-loop tests. Each trial changed
application or harness behavior, ran the affected tests, and restored the source.
No deliberate faults remain in the project.

Every retained independent case detected at least one mutation. The recorded
unit evidence comprises 163 assertion failures, 27 timeouts waiting for missing
behavior or notifications, and 3 exceptions. Hook-only failures were excluded.
The browser-loop parent is recorded as an aggregation, not an independent proof.

[Case evidence](./test-audit-cases.csv) maps every retained case to a representative
fault in the [mutation catalog](./test-audit-mutations.json). The case number
distinguishes parameterized cases with identical titles. The catalog records
exact replacements against production commit
`56ec95203f581db780191cd37c6764861e659c1a`; the repaired tests in this change were
used for the final experiments. It contains 137 representative mutations, rather
than every unsuccessful attempt or intermediate test revision.

A detected fault does not establish that every assertion is useful, or that a
test catches every regression its title suggests. Surviving mutations also need
interpretation: another valid guard can preserve the behavior. This is a record
of the audit, not an exhaustive mutation score or a new CI mutation framework.

## Validation

After restoring production and harness sources, `npm run check` validates types,
lint and Effect diagnostics, React Doctor, formatting, all 193 unit cases, the
production extension build, all 60 Playwright scenarios, and the browser-loop
suite. The offline persistent session verifies the actual toolbar popup and
collects errors from popup, content, and background contexts.
