# Chrome extension verification with coding agents

Research checked on 2026-10-02 against primary sources and source code. The follow-up implementation is now in `scripts/extension-agent.mjs`; see [the verification instructions](../README.md#verification). It has been tested with the actual toolbar popup, logs from all extension contexts, automatic WXT rebuild/reload, and build-failure recovery.

Google now documents the exact development loop needed here. Its [build-with-agents tutorial](https://developer.chrome.com/docs/extensions/ai/build-with-ai) combines the Chrome team's extension skill with Chrome DevTools MCP. It includes a Quick Notes popup example and says the agent can inspect popups, side panels, and service workers. Its [extension debugging tutorial](https://developer.chrome.com/docs/devtools/agents/extensions) walks through installing an unpacked extension, changing files, reloading the extension, triggering its action, and checking the resulting page. Enable extension tools with `--categoryExtensions`.

The [MCP tool reference](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md) lists `install_extension`, `list_extensions`, `reload_extension`, `trigger_extension_action`, and `uninstall_extension`, alongside page snapshots, screenshots, console messages, and script evaluation. Extension pages and extension workers appear when extension support is enabled. Worker logging shipped in version 1.2.0 on June 8, 2026, according to the [release changelog](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/CHANGELOG.md). Version 1.10.1 was released September 23, 2026, so this is released functionality.

I would start with an MCP-launched browser:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest", "--categoryExtensions"]
    }
  }
}
```

There is conflicting documentation about attaching to an existing browser. Google's build tutorial recommends `--autoConnect`; the current [configuration reference](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md) still describes extension tooling as requiring a pipe connection and says attachment support awaits Chrome 149. Starting a browser through the MCP avoids depending on that discrepancy. Existing-profile attachment needs a separate compatibility check against the installed Chrome and MCP versions.

## Background logs need a separate check

The released [worker collector](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/chrome-devtools-mcp-v1.10.1/src/collectors/ServiceWorkerCollector.ts) explicitly subscribes to `service_worker` targets whose URLs begin `chrome-extension://`. It collects worker console messages and uncaught exceptions, listens for new worker targets, and retains up to 1,000 messages per extension. This is actual extension-background support, rather than only website service-worker support.

The `list_console_messages` tool accepts `serviceWorkerId`. Without that parameter, [response handling](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/chrome-devtools-mcp-v1.10.1/src/McpResponse.ts) returns page console data. With the parameter, it calls the worker collector instead. A blank page console is therefore insufficient evidence that the background worker has no errors.

There is a source-level ID mismatch to verify before relying on this tool. [McpContext](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/chrome-devtools-mcp-v1.10.1/src/McpContext.ts) assigns worker IDs like `sw-1`. The collector stores logs under the actual extension ID parsed from the worker URL. Response handling forwards `serviceWorkerId` directly to that lookup. My inference is that the console filter may require the actual extension ID, despite its parameter name, while [worker evaluation](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/chrome-devtools-mcp-v1.10.1/src/tools/script.ts) resolves the synthetic worker ID. This finding comes from reading tagged source, not a reproduced browser test. Generate a known background console message and confirm it appears; an empty result alone proves little. Current page-scoped console tools also require a page ID, so keep a normal target page open while querying the worker filter.

## Other concrete prior art

[extensiondev/mcp](https://github.com/extensiondev/mcp) is an extension-specific MCP built on Extension.js. Its documented tools include `extension_open` for popups and other extension pages, `extension_logs` across contexts, `extension_reload`, DOM inspection, storage access, and assertions. It also has HMR and a ready-state check. `extension_start` documents an `outputPath` option for launching an existing unpacked build, which could make it useful with this WXT project. I have not verified that integration; its normal development workflow uses Extension.js, so Google MCP is the smaller first experiment here.

## Fit with this repository

The repository already has a real-extension Playwright fixture in `tests/e2e/fixtures.ts`. It launches `.output/chrome-mv3` and discovers the background worker. Tests open `chrome-extension://<id>/popup.html` in a tab, including settings persistence and log navigation. That is useful for stable popup DOM checks, though a toolbar popup also has focus and close behavior that a tab does not reproduce. The fixture currently captures page `pageerror` events, rather than a combined console log from pages and the extension worker.

For a repeatable agent loop, build or wait for WXT's development rebuild; reload when needed; reload the target X page after content-script changes; trigger the toolbar action or open the popup document; inspect the popup and target-page DOM; then read popup, content-script, and background logs separately. Rediscover page and worker IDs after reload. Confirm the newly built code ran before treating an empty log as success. The existing Playwright suite remains useful for deterministic regressions; MCP supplies interactive inspection and lifecycle control.
