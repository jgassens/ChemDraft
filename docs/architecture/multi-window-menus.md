# Document menus (1.3 A8)

Every document webview publishes its own native menu snapshot. Toolbar rows and checks,
plugin contributions, registered-command availability, active-tab close validation, and the
document title belong to that window. `window-manager/documentMenus.ts` merges publication
effects in a microtask, drops unchanged snapshots, and serializes publications. Rust's
`DocumentMenus` stores snapshots by registry window id and incarnation; a recreated window
cannot inherit the retired window's menu. Utilities and the runtime cannot publish snapshots.
Publication returns the window list as well as broadcasting changes, so a late native event
subscription cannot lose the initial list. Window actions become enabled after their document
client has registered and published the corresponding commands.

macOS installs one application menu from the active document's snapshot. Document activation
rebuilds it; utility focus leaves its document target unchanged. With no documents, document
actions are disabled. New, Open, and New Window can recreate the first document; Open is
delivered after the new document publishes its initial snapshot. Additional-window creation
remains gated until A10.

Windows installs a distinct menu on every ready document window. The installer never sets
an app-wide menu there and never attaches menus to utilities or the runtime. Tauri broadcasts
menu events without a source HWND, including events delivered to window-specific listeners.
Routed leaf ids therefore use an internal length-framed document-label prefix. The dispatcher
decodes and validates that owner, then delivers the original registered command id exactly
once to its webview. A source that is no longer a document is refused. Installation and
replacement stay on the main thread to preserve the existing muda subclass lifetime fix.
Only the active document's Windows menu supplies routed accelerators: Tauri tries all installed
accelerator tables globally. Activation rebuilds the menus so an inactive table cannot route a
keyboard shortcut to the wrong document. macOS retains its application-wide accelerators.

`window.close` and `window.activate.<windowId>` are registered in each document's shared
command registry. The Window menu lists live documents and activates the encoded target.
Close Window uses Cmd+Shift+W / Ctrl+Shift+W. `window.new` is registered but hidden while a
document exists until A10. Application-owned native actions such as Quit and predefined
clipboard actions retain their existing native handling.

The narrow `document-menus` capability grants only document windows the two new commands.
The command-signature snapshot changes are intentional:

| Native command | Change and reason |
| --- | --- |
| `publish_menu_snapshot` | Added: publish one complete snapshot, with the caller supplied by Tauri; return the initial window list without an event-subscription race. |
| `run_window_menu_command` | Added: execute registered close/activation commands after validating the document caller. |
| `set_toolbars_menu` | Added injected `window`: scope legacy toolbar pushes to their document. |
| `set_menu_checked` | Added injected `window`: prevent a check update from changing another document's snapshot. |
| `sync_plugin_menu_items` | Added injected `window`: scope legacy plugin contributions and routing to their document. |
| `set_keybinding_scheme` | Added injected `window`: utilities and the runtime cannot drive menu shortcut publication. |

Test expectation changes:

- Native construction assertions include the source-label argument and per-document installation because Windows menu actions now identify their owner.
- Native plugin publication assertions expect the coalesced complete snapshot instead of a separate plugin-only invoke.
- Native history/Select All routing assertions target the active document on macOS and the encoded document owner on Windows because utility focus no longer drives menus.
- Preferences close assertions check the registered document-close path; Preferences retains its own flush-before-disposal controls.
- Capability coverage includes the new document-only capability so both added native commands are checked for grants.
- The old utility-key-window menu-close test was removed with its obsolete routing implementation; document-only routing is covered on both platforms in `document_menus.rs`.
