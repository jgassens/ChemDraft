# Report 0010 — M14: Plugin commands in the native menu (prefix-routed bridge)

**Date:** 2026-07-09
**Worktree:** `~/Documents/programming/chemdraw-nmr` @ `codex/nmr-plugin`
**Decision:** [ADR-0016](../decisions/0016-plugin-native-menu-bridge.md)

## Context

After M13, the NMR plugin's Analyze commands worked in the **web** menu but not the
**native** macOS menu (the reverted dev toggle was only a stopgap). The user scoped core
changes as in-scope on this branch to give *plugins* native-menu access. Investigation
found the native→webview command bridge already exists end-to-end
(`on_menu_event → emit_command_to_main → listenForToolsetCommands → invoke`, and `invoke`
already dispatches plugin commands); the only gaps were that plugin ids never entered the
statically-built native menu, and `plugin.*` ids weren't routed.

## What shipped (M14)

- **ADR-0016 — prefix-routed bridge.** Plugin command ids are uniformly `plugin.<id>.<cmd>`,
  so core treats `plugin.*` as an opaque, routable namespace — no per-plugin core edits.
- **Rust (`lib.rs`):**
  - `PluginNativeMenuItems` managed state (the items last synced from the webview), read by
    **every** menu rebuild so toolset-driven rebuilds keep the plugin items too.
  - `build_analyze_submenu` — the static "Validate Selected Structure" item plus, separated,
    any synced plugin items.
  - `sync_plugin_menu_items` command — stores the items and rebuilds + `set_menu`s the app
    menu (mirrors the existing `schedule_customized_toolset_menu` pattern).
  - `is_routed_menu_command` now also routes `plugin.`-prefixed ids.
- **Webview:** `nativePluginMenu.ts` (`pluginAnalyzeItemsForNativeMenu` mapper +
  `syncPluginNativeMenuItems`, desktop-only) and a `MainWindow` effect that pushes the
  Analyze plugin items to Rust whenever the plugin menu changes.

## Files

- `apps/desktop/src-tauri/src/lib.rs` (state, submenu builder, sync command, routing, test)
- `apps/desktop/src/plugins/nativePluginMenu.ts` (+ `.test.ts`)
- `apps/desktop/src/MainWindow.tsx` (sync effect)

## Verification

- **Rust:** `cargo check` clean; `cargo test` → **39 passed**, including new assertions that
  `plugin.*` ids route (and a non-plugin id does not).
- **Frontend:** `pnpm lint` clean; `pnpm test` → **1328 passed**; the `MENU_COMMAND_IDS`
  drift test stays green (plugin items are excluded from `nativeRoutedCommandIds` and route
  by prefix, not the static list).
- Native menu **verified** in the running dev build (build `7.8.12.42-opus`): the Analyze menu
  shows Recognize Structure / Predict ¹³C / Predict ¹H / Bundled Plugins… alongside the static
  Validate item.

## Gotcha: Tauri v2 command ACL (cost the M14 debug loop)

A new bridge command is **silently rejected** by the webview unless it is *both*:
1. declared in `src-tauri/build.rs`'s `AppManifest::commands([...])` list — this is what generates
   the `allow-<command>` permission; and
2. granted in `src-tauri/capabilities/default.json` (`"allow-sync-plugin-menu-items"`).

Miss either and `invoke(...)` throws on the frontend with **no server-side log**; the sync helper's
`try/catch` swallowed it, so the native menu simply never updated — a true silent no-op. The build
*does* fail loudly if you add the capability grant without the `build.rs` entry (`Permission … not
found`), which is how it was finally caught. Any future plugin-bridge command must add both.

## Follow-ups (not in scope)

- Reconcile with the `refactor/toolbars` branch's native-menu rewrite when those merge.
- Optionally sync per-item `enabled` state to the native menu on selection change (today the
  items are always enabled; the command handler already surfaces "select one molecule").
