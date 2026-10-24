# Assistant 0.1.3 one-box regression fixture

`entry.js`, `manifest.json`, and `LICENSE` are unmodified copies from
`/Users/jeremiahgassensmith/programming/chemdraft-assistant-plugin/dist/chemdraft-assistant-0.1.3/`.
The source repository is `jgassens/ChemDraft-Assistant-Plugin`, commit `d3b8f3f`
(`d3b8f3f5c66dc841489f3626840ed224b4d46db2` in the package manifest), SDK/API 0.1.12.
The short commit was recorded with
`git -C /Users/jeremiahgassensmith/programming/chemdraft-assistant-plugin log -1 --format=%h`.

Owner-supplied release ZIP SHA-256:
`022ef96f7a2ad5f20d7235661b55e8df4f6efb43dc0ff6846c303b874836aa9b`.

`real-tool-reply.stdout.jsonl` is copied verbatim from
`/Users/jeremiahgassensmith/.agentctl/manifests/assistant/captures/real-tool-reply.stdout.jsonl`.
It is captured real Codex output against canned ChemDraft MCP replies, as the lines explicitly
state. Replaying it verifies provider parsing, transport and rendering; it does not insert or
validate chemistry. The inherited LICENSE is preserved verbatim; this fixture includes no database.
This replaces the 0.1.2 one-box fixture; the existing 0.1.0 fixtures are unchanged.

`assistantOneBox.integration.dom.test.tsx` executes this bundle through `loadPackagedPlugin`,
the real worker bridge, plugin host, desktop runtime, MainWindow command dispatch and
PluginCanvasOverlay. Only Worker transport, native windows/events and Tauri IPC are replaced.
It uses both installed-package origins (`tauri://localhost` and `http://tauri.localhost`).
This is DOM coverage on the macOS test host, not native WebKit/WebView2 or packaged-app verification.

Setup is completed through the rendered buttons, never by seeding plugin storage. The owner's
path sends immediately after choosing Codex in Setup. Before any run, the content heading is
`AI: Codex (OpenAI)` and the sole AI-choice button is `✓ Codex (OpenAI)`; the prompt has no select.
An independent case exercises that button, the captured reply, New conversation and reopening
Setup. Another refuses Enter both before choosing an AI and after choosing Codex but before
Finish setup, then proves that finishing Setup allows the next Enter to run Codex.
Every case asserts exactly one status line and that no panel-window open path was called,
including teardown.

## Regression reproduced before replacing 0.1.2

Running the original integration test at PR #195's head produced four failures and two passes,
reproducing both issues on both installed-package origins:

1. Completing Codex Setup left the prompt's AI select at `claude-code`. The plugin's
   `finishSetup` handler saved Codex and updated internal state, content and status, but the
   manifest still supplied `claude-code` as the prompt default. `PluginCanvasOverlay` passed
   that static prompt to `PluginPromptSection`, whose local selection only resynchronized when
   `section.select.value` changed. Enter carried `selected: "claude-code"`; the plugin refused
   the unconfigured AI and no `external_tool_run_start` occurred.
2. Explicitly selecting Codex allowed the captured reply to render, but completion overwrote the
   working status with `Replied — no changes to the page`, dropping `Codex (OpenAI)`.

The 0.1.3 bundle removes the static select, publishes AI choice through `overlays.setContent`,
and prefixes the status with the active AI and company. The updated assertions cover those
behaviors without changing production code or the release bundle. The VM transport recreates
plain records in the receiving realm so the bundled SDK's plain-object payload checks behave
as they do in a real Worker.
