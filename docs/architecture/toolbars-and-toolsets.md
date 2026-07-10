# Toolbars And Toolsets

Status: single-brain toolbar architecture shipping — native floating palettes, manifest-declared
widgets, a drag-and-drop Customize Toolbars editor, and Safari-style in-place customization of the
Main toolbar (drag items on the live palette; a gallery tray to add commands, spacers, and dividers).

ChemDraft toolbars are declarative toolsets backed by command IDs. A toolbar button never owns behavior directly; it invokes a command registered by the app or a plugin.

## Single Brain (TypeScript owns toolbar state; Rust is a dumb window host)

The TypeScript main window is the single source of truth for toolbars. `toolbars/toolbarCatalog.ts`
composes the effective toolset set from three inputs — the core manifest, live plugin contributions,
and the user's saved layout state — into immutable `ToolsetRegistry` snapshots. Everything else
(the palettes, the View ▸ Toolbars menu model, the Customize editor) follows that registry.

On the desktop build, each visible palette is a **native floating utility window** (a macOS NSPanel:
floats above the document while the app is active, hides on deactivate, never steals focus). Rust no
longer reads the toolset manifest at all — the TypeScript side supplies each window's title, size, and
staggered default position, pushes the View ▸ Toolbars menu model, and routes every menu click back to
JS; Rust just hosts the windows and persists their geometry. The browser build renders the same
`ToolPalette` in-window; `isDesktopRuntime()` (with a `localStorage["chemdraft.forceWebPalettes"]`
escape hatch) picks the renderer.

**Persistence split:** `toolbar-layout-state.json` holds user *intent* (visibility as
`toolsetOverrides[].visible`, order, renames, hidden items, user toolsets) — JS reads/writes it via
`load/save_toolset_customization_state`. `toolbar-state.json` holds window *geometry* only. A layout
file that fails to load or parse is never overwritten with defaults (it's preserved so a transient
error can't destroy customization).

## Sources

- Built-in toolsets come from ChemDraft manifests such as `apps/desktop/src/toolsets/desktop-toolsets.json`.
- Plugin toolsets come from plugin contributions and keep `source: "plugin"`.
- User toolsets come from versioned user customization state and keep `source: "user"`.

User customization references command IDs. It must not copy command implementations, mutate plugin manifests, grant plugin permissions, or bypass command registration.

## Item Schema

Toolbar manifests are schema-backed at the item level. Most items are command-backed, but the
manifest also declares **widget items** — full sections like the text/art style controls and the
ring/molecule inspectors — as `control` items whose `controlId` carries a `widget.` prefix (e.g.
`widget.core.moleculeInspector`). `ToolPalette` maps each widget id to its component via an internal
registry and feeds it live state through `ToolbarWidgetStateContext`, so which widgets a palette
shows is data (the manifest), not a hardcoded flag. Widget items are customizable (hide/reorder) by
their control id just like commands; they are skipped from grid slots and grid sizing. Inline
(non-widget) `control` items still occupy a grid slot.

Item fields:

- `commandId`: compatibility anchor for command-backed items. Non-command controls and
  separators may omit it.
- `id`: stable item identity for customization and DOM metadata. Defaults to `commandId`
  when omitted.
- `kind`: `button`, `toggle`, `control`, `separator`, or `spacer`. Defaults to `button`. A `spacer`
  is deliberate empty grid space (Safari's "Space"); a `separator` renders a thin divider. Both are
  commandless (`primary: { "type": "none" }`) and carry an explicit stable `id` so they can be
  reordered and hidden like any other item.
- `label`: user-facing item label. Defaults to `title` or `commandId`.
- `primary`: primary action descriptor. Current production items use
  `{ "type": "command", "commandId": "..." }`; `control` and `none` are reserved for
  non-command UI items.
- `submenu`: either `null` or a `{ "type": "command-grid", ... }` submenu with command
  items. Empty submenus are invalid. `columns` controls compact icon-grid rendering for
  both inline flyouts and native popover flyout windows.
- `tooltip`: display metadata with `title`, optional `description`, and optional shortcut
  text. Disabled-state reasons still come from the command spec.
- `layout`: item-span metadata such as `colSpan` and `rowSpan`.
- `placement`: customization placement metadata such as group, row, column, and order.

If a command-backed item declares both `commandId` and `primary.commandId`, they must
match. This keeps the old command-ID contract honest while giving the renderer a richer
item model. Items with `primary: { "type": "control" }`, `primary: { "type": "none" }`,
or `kind: "separator"` may be commandless. The registry normalizes legacy items and
explicit schema items into `NormalizedToolsetItem`, and command enumeration includes
primary commands plus submenu commands so validation and plugin/user layout state can
reject unknown commands consistently.

Toolset-level `gridLayout` also supports `gap` and `padding`, and item overrides may carry
`layout` span overrides. Source manifests remain the canonical contribution format; user
customization state should store overrides, not rewrite built-in or plugin manifests.

## Customization State

The native ChemDraft customization model lives in `packages/toolset-registry`.

The state is versioned and supports:

- toolset visibility,
- floating, docked, and hidden modes,
- View > Toolbars ordering,
- group ordering inside a toolset,
- item ordering inside a group,
- hidden command IDs,
- item placement metadata for future grid toolbars,
- item additions (`itemAdditions`) — the one structural edit allowed on a core/plugin toolset: an
  add-only list of `{ groupId, index?, item }` that in-place customize uses to drop new commands,
  spacers, and dividers onto a built-in toolbar without cloning it (manifest items are never mutated),
- user-created toolsets,
- cloned built-in or plugin toolsets,
- toolbar size and cell-size preferences.

The **Customize Toolbars editor** (`toolbars/CustomizeToolbars/`) edits this state — never the source
manifests. `layoutStateEdits.ts` is a pure `ToolsetLayoutState -> ToolsetLayoutState` layer (visibility,
rename, reorder toolsets/groups/items, hide, clone, create, delete); the dnd-kit dialog keeps a draft
and commits (setLayoutState + save) only on Apply. Invariant: structural edits (add/remove items) apply
only to `user.*` toolsets; core and plugin toolsets take overrides only (clone a built-in first to edit
it structurally) — with the single exception of add-only `itemAdditions`, which in-place customize
uses to grow a core toolbar. Built-in and plugin manifests remain stable source contributions.

## In-Place Customize (Main toolbar)

The Main toolbar (`core.main`) also has a **Safari-style in-place mode** (View ▸ "Customize Main
Toolbar…"): you rearrange items on the live palette itself, drag items off to remove them, and drag
new ones in from a gallery tray. Only `core.main` gets this mode; other toolbars use the list dialog.

The single-brain rule still holds — a palette webview never writes layout state. Instead the palette
sends **edit ops** to the main window on the `chemdraft://toolset-layout-edit` channel
(`reorderItems | addCommand | addSpacer | addSeparator | removeItem | resetToolset | exitCustomize`,
each wrapped with a `toolsetId`). MainWindow applies the op against `layoutStateRef.current` with the
pure `applyToolsetLayoutEdit` (adds become `itemAdditions`; removing a base item hides it, removing an
addition deletes it) and commits through the normal funnel, which re-broadcasts the new layout state;
the palette repaints from that broadcast. Ops, not snapshots, so a stale palette can't clobber state.
Mode entry/exit rides a companion `chemdraft://toolset-customize-mode` broadcast (with a request/
response so a palette opened mid-mode catches up). Both channels dual-dispatch (DOM CustomEvent +
Tauri emit) so the browser build and jsdom tests exercise the identical path.

The gallery tray lives **inside** the Main palette window (a webview can't paint outside its window),
so the window grows to fit it via the shell `ResizeObserver`; the tray is width-capped and scrolls at
a fixed px height. Because palettes ship non-focusable, entering customize mode flips the window
focusable (`set_toolset_window_focusable`) so the gallery's search field can take keystrokes, and back
off on exit. To avoid a flash of the old layout during the op round-trip, `ToolbarCustomizeController`
previews reorder/remove locally (optimistic display) and drops the preview once the authoritative
broadcast lands. Additions made here also appear in the list-style Customize Toolbars dialog, which
merges a core toolset's `itemAdditions` into its rows.

Implementation lives in `apps/desktop/src/toolbars/CustomizeMainToolbar/` (the controller, the pure
op applier, the gallery model/tray, and the Done/Restore bar).

## View Menu

The View > Toolbars menu should be generated from the registry plus customization state:

```text
built-in toolsets
plugin toolsets
user toolsets
user layout state
-> menu items with command IDs
```

The menu item command remains `view.toolset.toggle.<toolsetId>`. `view.customizeToolbars` is enabled and
opens the editor (routed to JS via `MENU_COMMAND_IDS`, mirrored in the web menu by `appMenu.ts`). The
standalone `view.toolset.{resetLayout,resetAllLayouts,createUserToolset,cloneToolset}` commands remain
disabled placeholders because those actions are performed inside the dialog.

## ChemDraw XML Boundary

ChemDraw toolbar XML is not the ChemDraft toolbar format.

ChemDraw XML may be studied conceptually as evidence that toolbar layouts are data, but do not copy ChemDraw command IDs, icon names, XML schemas, image assets, menu text, or trade dress.

If external toolbar import is ever added, it must be a compatibility/import layer. It should map known external actions into ChemDraft command IDs, warn for unmapped commands, and preserve the legal boundary.

## Drag And Drop

The Customize Toolbars editor uses **`dnd-kit`** (`@dnd-kit/core`, `@dnd-kit/sortable`,
`@dnd-kit/utilities`) for sortable toolset and item lists, with the keyboard sensor for accessibility.
It was chosen over `@hello-pangea/dnd` (weaker for mixed grid/palette layouts), `SortableJS` (not
React-command-driven), and `react-beautiful-dnd` (archived). See
`docs/architecture/dependency-inventory.md` for the inventory entry.

## Asset Note

Current toolbar asset IDs use `Custom_*` names and the checked-in files live under `apps/desktop/src/assets/toolbar`. These must remain original ChemDraft assets. If any asset is found to be copied from ChemDraw or another proprietary toolbar pack, remove it or replace it with an original placeholder glyph before release.

Later, prefer ChemDraft-native asset IDs that describe command meaning without carrying import-history names.
