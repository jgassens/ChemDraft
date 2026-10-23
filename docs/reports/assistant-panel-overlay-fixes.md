# Assistant panel and overlay investigation — 2026-10-23

## Findings and changes

The reproducible empty-window cause is the overlay opener. Assistant 0.1.0 declares
`panel.assistant.chat` without `commandId`. MainWindow used that field to invoke an opener, but its
fallback merely created a native window. The plugin never ran `plugin.assistant.open`, never called
`showReport`, and there was no snapshot to replay. The native request already carried the correct
title; the undecorated panel's visible heading comes from the missing report, so it displayed
"Plugin panel" and waited indefinitely.

MainWindow now resolves the panel's explicit command, or a unique owned menu command with the same
title after removing a trailing ellipsis. The real package's "ChemDraft Assistant…" menu therefore
supplies `plugin.assistant.open`. Unrelated or ambiguous menus cannot be chosen. A panel with neither
an opener nor cached content reports the missing content/command instead of creating a blank window.

The Plugins menu already invokes `plugin.assistant.open`. The real bundle's report is accepted by
plugin-host's schema, unique-control-id checks, and command-ownership validation; the desktop panel
controller also accepts it. An integration test mounts the detached renderer after the initial
broadcast, suppresses shared-DOM shortcuts, and exercises the authenticated snapshot request and
replay with the real plugin/panel identity. It renders the correct heading, provider selection,
prompt, and actions. This menu path passes even before the fix. **The owner's additional menu-only
failure has not been reproduced or established as an ACL/forwarder defect.** Native execution remains
an outstanding check, not a claimed fix.

The fixture's entry SHA-256 is
`e7a59b33a6265a882bcb0f34a9fc164450f2f3f0bc7649231d2d54da91f6964a`, matching the installed entry in
the `assistant-c` app data. Its recorded running build is commit `8cb8baee`, stamp
`10.23.11.00-codex`. The new source stamp is `10.23.17.30-codex`.

The collapsed icon had no drag handlers; only the expanded header did. Both modes also shared one
position. The icon now distinguishes a click from a drag using a four-pixel threshold and suppresses
the click following a drag. Collapsed and expanded positions persist independently, scoped by window
and overlay id, with guarded storage access. Old positions migrate to the expanded box. Moving the
icon anchors the next expansion nearby; resize clamps both modes. The expanded box is at most 300 px
wide and is further limited to the measured drawing area, excluding rulers, scrollbars, and status.

## Plugin change

In the Assistant repository's `src/manifest.ts`, add
`commandId: assistantOpenCommandId` to the `panel.assistant.chat` contribution
(`assistantOpenCommandId` is `plugin.assistant.open`). This is the explicit association the host
expects. The compatibility fallback handles the current unmodified 0.1.0 package. No plugin source
or package was changed here.

## Verification

- Re-ran the real-bundle and overlay regressions against the original HEAD implementation: **seven
  failures**, including both platform-origin overlay open paths, icon drag-versus-click, separate
  stored positions, old-position migration, and resize bounds. Restoring the fixes makes them pass.
- The real package is loaded through `loadPackagedPlugin`, `PluginWorkerBridge`, the persistent
  desktop runtime, MainWindow command routing, and the actual detached report renderer. Its bundled
  SDK and handlers execute in an isolated VM with structured-cloning Worker transport. Only native
  IPC and the Worker transport are replaced. Both installed-package origins are exercised.
- `pnpm lint`: passed.
- Requested scoped command (`pnpm vitest run --configLoader runner apps/desktop/src/plugins
  apps/desktop/src/MainWindow apps/desktop/src/App.test.ts`): 1,392 passed, 2 skipped, **10 failed**
  in the unchanged `pluginStructureNaming.rdkit.test.ts`. That suite fails standalone too.
- The linked dependency tree resolves the bare RDKit package/testing helper to the donor checkout,
  while the existing Vitest identifiers alias resolves to this worktree, creating separate loader
  singletons. A temporary config that adds exact aliases for `@chemdraft/rdkit-adapter`, `/testing`,
  and `/adapter` to this worktree resolves those failures. With that config, the requested suites
  plus `agentBridge.test.ts` and `drawingTools.test.ts` passed: **1,428 passed, 2 skipped**. Repository
  configuration is outside this task's owned paths and was not changed.
- Focused real-bundle/overlay/opener tests plus all plugin-api and plugin-host tests pass using the
  repository's unchanged configuration.
- `pnpm --filter @chemdraft/desktop exec vite build --configLoader runner`: passed.
- `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check`: passed.
- `git diff --check`: passed.

## Platforms and remaining checks

macOS: automated TypeScript/DOM tests and web build ran on this host. A packaged app was not launched;
the plan reserves the Mac screen for the owner. Windows: installed-origin handling is covered in
the same automated tests, but native WebView2/window behavior has not been run. No Rust or capability
implementation changed; native compilation/clippy/tests and the full repository gauntlet were not run.

Recommended next task: run the real-package checklist on the owner's packaged macOS build and the
Windows build, especially Plugins → ChemDraft Assistant… after opening and closing from the overlay.
If the menu still waits, capture its command result, provider-status probe completion, and native
snapshot-request outcome; automated evidence currently establishes neither a report rejection nor
an authenticated-forwarder failure on that path. The manual stress checklist includes these checks.
