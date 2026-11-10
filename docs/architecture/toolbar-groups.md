# Toolbar groups and resize

The Main toolbar has seven home groups. `packages/toolset-registry/src/index.ts` owns their metadata.

| Group | ID |
| --- | --- |
| Select & Text | `select-text` |
| Bonds & Rings | `bonds-rings` |
| Arrows | `arrows` |
| Symbols & Shapes | `symbols-shapes` |
| Orbitals | `orbitals` |
| Arrange | `arrange` |
| Style & 3D | `style-3d` |
| Undeclared | `undeclared` |

Undeclared is conditional. It holds buttons without a known home and disappears when empty.
Main folds Orbitals and Undeclared together, then Arrange, Style & 3D, Symbols & Shapes, Arrows,
and Bonds & Rings. Select & Text never folds. Increasing the length unfolds in reverse order.
Fold icons use the group's designated command icon and then its fallback icon.

## Layout and customization

Layout version 1 stores `groupOrder`, `hiddenGroupIds`, per-group `itemOrder`,
`hiddenCommandIds`, and item overrides. Each Main item has a home. Customize shows hidden
buttons and groups, and can show, hide, and reorder them. Buttons can move only within their home
group; groups can be reordered as a whole. Main does not accept spacers or dividers. Dragging a
button out hides it. Other toolsets retain their own customization rules.

`migrateMainToolbarGroups` converts old flat or seven-group layouts once. It maps items to homes,
retains visibility and within-group order, removes spacers, and retains unavailable plugin entries.
Previously visible Arrange buttons remain visible. The durable `mainToolbarGroupsMigration` marker
records version 1 and `noticePending`. Customized legacy layouts show a one-time notice with Dismiss
and Reset to default. Dismissal and reset retain the marker. Fresh or already grouped layouts do not
need that notice. The saved layout and detached palette receive changes through the shared layout
commit and broadcast path.

## Plugin buttons

A plugin button's `toolbarGroup` selects one of the seven named homes. A legacy button without it
lands in Undeclared. Plugins targeting API 0.1.23 or later must declare it on every toolbar button;
Undeclared is not a valid declaration. Registration checks `ui.toolbar` and command references and
rolls back the plugin on failure. Buttons are composed into Main through `core.main` fragments;
explicit plugin toolsets remain separate. Duplicate Main contributions for a command render once.
Unregistering removes the fragments. Saved unavailable buttons remain in the layout and return when
available. Home reconciliation is idempotent and retains visibility and absent slots. See the
[plugin authoring guide](../plugin-architecture/AUTHORING.md) for the public contract.

## Native size ownership

Rust owns floating palette sizing in `apps/desktop/src-tauri/src/palette_resize.rs` and
`apps/desktop/src-tauri/src/palette_geometry.rs`. `report_toolset_content_size` accepts `size` with
`orientation`, `width`, `height`, and optional `minLength`, in logical pixels. The dimensions describe
full intrinsic inner content including the title. The minimum includes one item and overflow,
both leading and trailing group padding/borders, the palette's padding/borders, gaps and drag grip.
`get_toolset_window_size` returns the current status. Only a registered palette can call these
commands for itself. Both return `toolsetId`, `orientation`, `length`, `savedLength`, `minLength`,
`maxLength`, `width`, and `height`; `chemdraft://toolset-window-size` publishes status changes.

A horizontal toolbar resizes only in width; a vertical toolbar only in height. The other axis is
fixed to the natural content size. Length is clamped to the measured minimum, full content, and
available monitor work area. Only left/right edge centres resize a horizontal toolbar; only
top/bottom edge centres resize a vertical toolbar. Locked edges and all four corner squares have
no resize hit or cursor. The title strip retains its normal move behavior outside the allowed
resize band. When minimum and maximum length coincide, there are no resize targets.

`palette_resize_hit_test.rs` owns the pure edge regions, point decisions, Win32 hit-code mapping
and anchored/clamped AppKit drag geometry. Windows filters `WM_NCHITTEST` in the existing native
resize subclass and adapts Tauri's existing input child to the same two edge regions. Its region
and hit decisions refresh on size, orientation and DPI changes; title/client hits pass through.
AppKit palettes are created without unrestricted system resizing. A transparent native `NSView`
sibling above WebKit supplies only the two allowed edge handles and native directional cursors
(with a cursor API fallback before macOS 15). Its native mouse tracking loop clamps the length,
anchors the opposite edge, keeps the other axis fixed and reports genuine user changes directly.
Rust also sets AppKit's content min/max synchronously, equal on the locked axis. There is no
assumption that equal limits alone suppress AppKit's corner cursors, and no late resize-style
change or replacement of Wry's content root.

An inert, aria-hidden natural-size probe measures cells, spans, gaps, borders and padding. Reports are
deduplicated and refreshed on DPI changes. The viewport and native size events trigger reflow,
not changes to the intrinsic probe. The old TypeScript grid-size auto-sizer has been removed;
the grid metric defaults configure rendering, and sizing uses the measured DOM.

A user resize saves the chosen logical length with a debounce; pending saves flush before relevant
frame changes and close. Position and chosen length persist, while visibility is managed separately.
Programmatic fitting, moves, DPI changes and minimized frames do not overwrite the user's length.
Restore resolves the destination monitor and its scale, clamps the frame to its work area, and
retains the chosen length for later use when space returns.

## Folding, overflow and popovers

Main recomputes folds from natural footprints. A folded footprint uses the measured icon-button
length plus both group padding/border ends, read from the same computed CSS as the native minimum.
Empty groups are omitted. If the folded bar still does not fit, More tools contains the remaining
items. Other floating toolbars show the largest
ordered prefix that fits after reserving More tools. Art and Text sections participate as atomic
controls; inspector bodies retain scrolling. When a focused item disappears, focus moves to its
replacement opener.

`openToolsetToolbarItemsPopover` in `apps/desktop/src/window-manager/index.ts` takes a toolset ID,
the actual opener element, orientation, and a toolbar snapshot containing title, items, active tool,
distribute mode and optional widget state. It returns a handle with `ready`, `update`, `close`, and
`dispose`. Update it when items, availability or control state change; an empty or undefined snapshot
closes it. Dispose it on unmount or before opening another popover kind. Clear the legacy replay
payload when opening toolbar items. Removed opener nodes close the session, and dismissed sessions
cannot be replayed.

The transport payload is `{ kind: "toolbarItems", openedAt, toolbar }`, with optional opener,
orientation and work-area anchor data in global logical pixels. The destination monitor's scale
and work area determine placement; the receiver wraps, measures, flips and clamps the popover.
There is one native popover per palette. A hidden item's submenu replaces the strip with a command
list and Back. Buttons use the normal registry and command channels. A normal press invokes once;
hold or Alt+Down opens choices. A disabled primary with enabled choices opens those choices. Toggles
and controls stay open by default; `keepOpen` can override the behavior.

Enter and Space activate; arrows move focus, Home and End jump, and fields keep their editing keys.
Escape closes the popover and restores focus to the opener. Native owner buttons may declare
`aria-haspopup="menu"` but must not point `aria-controls` into another webview.

## Platforms

The same grouping, persistence and resize behavior applies on macOS and Windows. Utility windows
are document-owned and created unfocused. Toolbar-items popovers take focus when opened by the user,
including after prewarming; legacy flyouts retain their own focus policy. Windows palettes and
popovers have no taskbar entry. Monitor placement uses the destination scale on both platforms.

Regression coverage: `toolbars/useToolbarFit.dom.test.tsx` exercises padded/bordered folds and the
overflow boundary on both axes; `window-manager/palette-sizing.dom.test.ts` covers their native
minimum. Rust's `palette_resize_hit_test` tests cover both orientations, every edge and corner,
interior/outside points, Windows caption preservation, scaled bands, and anchored drag limits.
The native cursor, title dragging, focus and mixed-monitor checks still require the hands-on pass
in `docs/manual-stress-checklist.md` on each OS.
