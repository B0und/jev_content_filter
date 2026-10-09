# Jev popup redesign research

Researched 7 October 2026. The sources below are maintained by the extension authors, browser vendors or W3C. Product recommendations are design judgments drawn from those sources and Jev's current controls; they are not claims that another extension has tested Jev's design.

## The popup's job

The current popup mixes feed controls, engine installation, credentials, model descriptions and troubleshooting. A person trying to hide a kind of post has to read setup material before reaching their filters. The redesign should answer two questions immediately: "Is Jev working on this feed?" and "What am I filtering?"

Chrome action popups close when focus moves outside them. Their allowed dimensions are 25×25 through 800×600 pixels. A popup is a temporary interaction, so a long settings form is particularly easy to abandon. [Chrome popup lifecycle](https://developer.chrome.com/docs/extensions/develop/ui/add-popup), [Chrome action API](https://developer.chrome.com/docs/extensions/reference/api/action).

Mozilla recommends centering an extension on a main use case, using an options page for saved settings and bundled pages when gathering significant information. It also recommends keeping users informed, testing at different screen sizes and watching real users rather than assuming the developer understands their audience. This supports a small everyday popup and a separate place for setup. [Firefox extension UX guidance](https://www.extensionworkshop.com/documentation/develop/user-experience-best-practices/).

Chrome supports full options pages in a tab and embedded options pages, with `runtime.openOptionsPage()` providing a standard route from the popup. A larger settings page is therefore an established extension mechanism, not a workaround. [Chrome options pages](https://developer.chrome.com/docs/extensions/develop/ui/options-page).

## Filtering extension prior art

| Extension                 | Observed pattern                                                                                                                                                                                                                                                       | What Jev should take                                                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| uBlock Origin             | The popup gives prominence to the power control, current-page blocking information and tools. More/Less changes the amount of information shown. The dashboard and logger open separately. The dashboard separates settings, filter lists, personal filters and rules. | Put current-feed status and pause within immediate reach. Separate daily filtering from setup and diagnostic detail. Keep personal filters directly accessible. |
| Control Panel for Twitter | Its first-party options source groups controls by purpose, uses full-row labels and switches/selects, and nests dependent controls under their parent setting. The product page says preferences apply as options change.                                              | Use predictable rows with generous clickable labels and visible state. Reveal dependent details where they belong. Keep quick changes automatic.                |
| Social Fixer              | Filtering lives in a Filters section of its options interface. It offers ready-made filter subscriptions alongside custom rules; its author explains that people can use filters without learning rule construction.                                                   | Give custom filters a clear home and a visible creation action. An example prompt should make the natural-language editor approachable.                         |
| Unhook                    | The first-party store listing describes controls in terms of outcomes, such as hiding the homepage feed, Shorts or comments, and disabling autoplay.                                                                                                                   | Name what will change in the feed. Engine names and model repositories belong in setup and technical details.                                                   |

Sources: [uBlock popup guide](https://github.com/gorhill/uBlock/wiki/Quick-guide:-popup-user-interface), [uBlock dashboard guide](https://github.com/gorhill/uBlock/wiki/Dashboard), [Control Panel options source](https://github.com/insin/control-panel-for-twitter/blob/master/options.html), [Control Panel product page](https://soitis.dev/control-panel-for-twitter), [Social Fixer filtering guide](https://socialfixer.com/blog/2019/04/28/hide-politics-from-your-news-feed/), [Social Fixer feature list](https://socialfixer.com/features.html), [Unhook author's Chrome Web Store listing](https://chromewebstore.google.com/detail/unhook-remove-youtube-rec/khncfooichmfjbepaaaebmommgaepoid).

These tools do not establish that AI probabilities are reliable or that a particular Jev layout is effective. They establish useful interaction conventions. Jev still needs its score explanation and real-browser testing.

## Recommended information architecture

1. A compact header shows Jev, the active/paused state, and a labeled global switch. This control remains available while the user scrolls filter rows.
2. A current-feed summary shows actual analyzed/hidden counts and a brief status. Distinguish active filtering, waiting for posts, unavailable connection and incomplete checks. Scope counts explicitly to this tab since its page loaded.
3. The default Filters view contains custom filters first with an obvious Add filter action. Built-in AI-written text and image categories follow in the same row system. Each enabled row exposes its threshold, a 1% slider and a precise numeric value. A disabled row retains its saved value.
4. Settings contains text-provider selection and credentials, local model setup, downloads and technical details. A concise readiness indication can link here from a filter that needs setup. Setup copy should say which checks run locally and which send content to a provider.
5. Creation and editing use a dedicated view with a clear back/cancel action, a name and instructions. Creation has no probability field. Editing a saved definition should not silently reset its separately adjusted threshold.
6. Diagnostics remains reachable from Settings or a secondary footer action. Error status in the summary should provide a direct route when it is useful.

A three-view popup can implement this separation now. A full-page Settings option is preferable if provider forms, downloads and diagnostics still make the popup lengthy. The separation matters more than choosing a fashionable navigation pattern.

## Visual and interaction direction

Use roughly 420–460 pixels of width and a stable height within Chrome's 600-pixel maximum. Reserve one scrolling content region, with header/navigation outside it. Space comes from removing setup material from Filters, not reducing text until it is difficult to read. Prefer clear grouped rows over putting every control inside a separate decorated card.

Use one accent for active controls and primary actions. Show active, paused and failed states with words as well as color. Keep technical explanations behind a named disclosure. Put the threshold explanation once near the filter list, then give each row a concise accessible description. Say "Hide at 65% or above" and "Lower values hide more"; do not reverse slider direction or call the raw probability "strength" without explaining it.

Auto-save should acknowledge success and expose failures. Creation/editing needs an explicit Save action because a definition can be incomplete while being typed. A small unsaved draft should survive accidentally closing the popup if the implementation supports it. Do not promise persistence merely because the form stays mounted during navigation.

## Accessibility requirements

- Prefer native range inputs. Arrow keys change one step; Home/End reach bounds. Each slider needs a unique accessible label and a percentage value description. Preserve a numeric input so precise adjustments do not require dragging. [WAI slider pattern](https://www.w3.org/WAI/ARIA/apg/patterns/slider/).
- If navigation is implemented as tabs, use tablist/tab/tabpanel semantics, selected state, associated panels, and Left/Right keyboard movement. Immediate view changes support automatic activation. [WAI tabs pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/).
- Pointer targets need at least 24×24 CSS pixels or the criterion's spacing exception. Aim for 32–40-pixel buttons and full-row toggle labels in this small popup. [WCAG target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).
- Required control outlines, state marks and custom focus indicators need at least 3:1 contrast against adjacent colors. Decorative separators do not carry that requirement. [WCAG non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html).
- Saving/download status should be available through a polite status region; actionable failures need an accessible error message. Avoid assertive announcements for routine counter updates. [WCAG status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html).

## Acceptance checks for Jev

Open the actual toolbar popup at normal browser zoom. Confirm the main filter action is visible without scrolling past setup. Create a custom filter, change its slider with mouse and keyboard, close/reopen the popup and check the stored value. Edit instructions and confirm the threshold remains unchanged. Exercise disabled filters, missing provider credentials, downloaded/not-downloaded models and saving failures. Check focus after entering/leaving the editor and after deleting a filter.

Test navigation and scrolling inside the bounded popup, including long names/instructions and many custom filters. Verify that pause remains reachable and status/counters remain truthful. Finally reload the finished unpacked build in the user's regular browser, refresh X and open its actual popup. A screenshot from a separate test profile cannot prove that handoff happened.
