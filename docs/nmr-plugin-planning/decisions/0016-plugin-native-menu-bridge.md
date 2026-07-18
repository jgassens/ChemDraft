# ADR-0016: Plugin commands in the native menu via a prefix-routed bridge

- **Status:** accepted (2026-07-09) — user scoped core changes as in-scope on this branch to give *plugins* native-menu access
- **Builds on:** [[0009-analyze-menu-via-appmenu-model]] (shared app-menu model); the existing native→webview command bridge

## Context

Plugin Analyze commands work in the **web** menu but not the **native** macOS menu.
The native menu is built statically in Rust at startup (`create_app_menu`), while
plugins register at runtime in the webview — so the Rust menu never sees a plugin's
command ids or labels. The rest of the bridge already exists and is generic:

```
native click → on_menu_event → emit_command_to_main → (webview) listenForToolsetCommands → invoke(commandId)
```

and `invoke` already dispatches plugin commands (`pluginCommandExists → invokePluginCommand`).
Two gaps remain: plugin ids are not *in* the native menu, and `is_routed_menu_command`
(a static allowlist, `MENU_COMMAND_IDS`) does not route them.

## Decision

A **generic, plugin-agnostic bridge** — core never learns any specific plugin's ids.

1. **Webview syncs menu items to Rust.** The webview owns the plugin registry, so on
   plugin-menu change (registration) it calls a `sync_plugin_menu_items(items)` command
   with its Analyze contributions — each `{ id: commandId, label, enabled }`.
2. **Rust rebuilds + installs the menu.** `sync_plugin_menu_items` rebuilds the app menu
   with those items appended under **Analyze** and installs it via `app.set_menu`.
3. **Clicks route by the `plugin.` id prefix.** Plugin command ids are uniformly
   namespaced `plugin.<pluginId>.<command>` (manifest-enforced), so `on_menu_event`
   routes any `plugin.*` id through the existing `emit_command_to_main` path. Core treats
   `plugin.*` as an opaque, routable namespace.

## Consequences

Any plugin's Analyze items appear in the native menu **with no core edit** — the
capability belongs to plugins generally, not to the NMR plugin specifically. The static
`MENU_COMMAND_IDS` drift test is unaffected: plugin items are excluded from
`nativeRoutedCommandIds` and route by prefix, not via the static list.

Costs: the menu is rebuilt and re-installed on each plugin-menu change (rare —
registration time). This edits core `lib.rs` menu construction, which the
`refactor/toolbars` branch also rewrites, so it will need **reconciliation** when those
merge (accepted, per the user's scope call for this branch).

Rejected alternatives: hardcoding the NMR command ids into the Rust Analyze submenu (not
extensible — every plugin would need a core edit); a live menu-mutation API holding
`Submenu` handles in managed state (more moving parts than rebuild-and-set for changes
that only happen at registration time).
