# Feed filtering UX prior art

Research checked on 2026-10-07 against first-party documentation, product pages, and the CSS specification. Recommendations below are design judgments for this repository; the sources do not establish that these changes improve a measured usability outcome.

## Keep the reader's place

The [CSS scroll anchoring specification](https://www.w3.org/TR/css-scroll-anchoring-1/#description) explains that browsers choose a visible DOM anchor and adjust the scroll position when it moves. Anchoring can be suppressed when height, min-height, padding, margins, position, or transforms change on the path from the anchor to the scroller. Setting `overflow-anchor: none` excludes that subtree; descendants cannot turn anchoring back on for the ancestor's scrolling box. A filtering extension should therefore avoid assuming the browser will repair every collapse.

Recommendation: when an asynchronous verdict arrives for a post already in or above the viewport, retain its measured layout height while hiding its content. A replacement notice can occupy that same box. Posts classified below the viewport can collapse before they are read. Keep the decision stable for that article binding so later status updates do not change its height. Do not animate height as classification results arrive. Explicit user actions such as revealing or collapsing a post can change its size, with the clicked notice retained at its current viewport position.

[Google's CLS guidance](https://web.dev/articles/cls) describes unexpected shifts as disruptive and notes that locally fast API calls can hide delays experienced by users. The acceptance check should delay classification, scroll to a known post, and compare that post's viewport position before and after surrounding verdicts arrive. Repeat while actively scrolling, scrolling backward, revealing content, changing thresholds, and allowing the host site to recycle article nodes. Screenshots alone cannot establish stability.

## Explain a hidden post and give a way back

[Social Fixer's political filter](https://socialfixer.com/blog/2019/04/28/hide-politics-from-your-news-feed/) replaces hidden posts with a message that can be clicked to show the original. Its [29.0 release notes](https://socialfixer.com/blog/2022/12/30/social-fixer-version-29-0-release-notes/) add separate click-to-show and click-to-hide messages and styling for posts revealed after filtering. This is useful precedent for making the extension's action visible and reversible within the feed.

Recommendation: use a plain notice such as "Hidden by Crypto promotions" with "Show post" and a separate details affordance. Show the score and threshold in details, for example "Match score 82%, threshold 65%." Keep revealing the current post distinct from permanently allowing it, because those actions have different consequences. A revealed post should offer "Hide again". Avoid making users open logs to recover a post they can still see in the feed.

## Separate classification from the user's preference

[Bluesky's moderation documentation](https://github.com/bluesky-social/bsky-docs/blob/main/docs/advanced-guides/moderation.md) separates labels from the user's hide, warn, or ignore preference. Hide filters labeled content out of feed listings, while warn permits a warning that can be clicked through. Labels can apply to media, individual content, or whole accounts, and their effects depend on that scope.

Recommendation: describe a custom rule as what to detect, then let its saved row control the threshold and whether it is enabled. Creation needs a name and a description, using the existing 65% default. Keep probability controls out of creation as requested. Once created, use the same enabled switch, slider, percent input, and direction explanation as built-in categories. Say "Lower thresholds hide more posts." The repository's benchmark notes already say the scores are uncalibrated estimates, so "Match threshold" is clearer than wording that promises a literal probability of correctness.

## Make the controls consistent and teach their direction

[uBlock Origin's element picker](https://github.com/gorhill/uBlock/wiki/Element-picker) previews a proposed filter's effect, offers depth and specificity sliders, and explains that broader choices can hide more elements. It requires a valid filter with at least one match before creation. Its strongest lesson here is visible consequence and clear control direction, rather than borrowing selector syntax.

[Control Panel for Twitter](https://soitis.dev/control-panel-for-twitter) groups extensive options around a calmer timeline and applies preferences when they change. Recommendation: keep everyday controls beside each rule, with description editing and deletion in secondary actions. Avoid a separate threshold editor for custom rules. Keep readiness visible, and put model IDs, pinned revisions, and benchmark descriptions behind Model details so everyday filters fit in the popup.

Use native range inputs with a 0–100 range and `step="1"`, paired with percent inputs using the same step. Keep existing stored decimal values readable until the user edits them. The [WAI slider pattern](https://www.w3.org/WAI/ARIA/apg/patterns/slider/) specifies arrow-key changes by one step and Home/End at the range limits, with an accessible name and understandable value. Verify one arrow press changes 65% to 66%, the saved value survives popup closure, and a failed save leaves a visible error. Connect the direction hint with `aria-describedby` so keyboard and assistive-technology users receive the same explanation.

## Priority for this change

1. Give saved custom rules the same threshold controls as built-in categories, in 1% steps; simplify creation to name and description.
2. Fix late verdicts moving the post being read, and assert viewport position with delayed responses in the persistent extension session.
3. Make hidden-post reasons and reveal actions readable in the feed, preserving the reader's place through reveal and hide.
4. Consider a future preview against recent posts to help tune broad rules. That needs a clear sample boundary and reliable classification state, so it should not delay the first three changes.

## Verification in this change

On 2026-10-07, the updated extension ran in headed system Chromium against a signed-in, live X home timeline with the existing provider configuration. Only X/Twitter cookies were copied into an isolated live profile; no cookie values or API keys were printed or added to the repository. The live launcher uses the OS keychain, matching desktop Chromium, while the synthetic fixture retains its separate profile.

A native-wheel pass scrolled down 18 times and back up six times. Each reading pause sampled a retained post's viewport position 25 times over 2.5 seconds. All 24 pauses had a retained target with 0px movement. During the run, the popup reported 49 analyzed posts and 13 blocked posts. Show post and Hide again were exercised on a real filtered post. Popup, content-script, and background log collection passed; live smoke verification reported no extension runtime errors. Local evidence is under `.wxt/live-scroll-artifacts/` and is intentionally not committed.

These observations cover this live browsing session, not every layout change X can introduce. The deterministic browser regression separately held provider replies, scrolled with native wheel input, and reproduced a 720px movement before the fix. After the fix, it checks unchanged viewport position, below-viewport collapse, temporary reveal and hide, and recycled-cell cleanup with native scroll anchoring disabled.
