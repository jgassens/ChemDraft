# `@chemdraft/toolset-registry`

Typed registry for command-backed ChemDraft toolsets.

Toolsets describe toolbar windows and palettes. They do not own chemistry behavior and they do not mutate documents. Every visible item routes a command ID back to the app command registry.

## Toolbar Item Contract

The registry accepts legacy command-backed items and normalizes them into a richer item
model. Command-backed items still include `commandId`, while commandless controls and
separators may omit it. Explicit schema fields describe how the item should render:

```json
{
  "commandId": "tool.bond",
  "id": "tool.bond",
  "kind": "button",
  "label": "Single Bond",
  "primary": { "type": "command", "commandId": "tool.bond" },
  "submenu": null,
  "tooltip": { "title": "Single Bond", "shortcut": "M" },
  "layout": { "colSpan": 1, "rowSpan": 1 }
}
```

Supported item metadata:

- `kind`: `button`, `toggle`, `control`, `separator`, or `spacer`.
- `primary`: `command`, `control`, or `none`. If `primary.commandId` is present, it must
  match the compatibility `commandId`.
- `submenu`: `null` or a non-empty `command-grid` submenu. Submenu commands are included in
  registry command enumeration and unknown-command validation. `columns` controls compact
  icon-grid rendering in the palette flyout renderers.
- `tooltip`: title, optional description, and optional shortcut text.
- `layout`: item span metadata (`colSpan`, `rowSpan`).
- `placement`: group, row, column, and order metadata for customization.

Core and plugin toolsets may receive add-only `itemAdditions` from toolbar customization. Their
indices are replayed in saved order: each index addresses the group produced by all earlier
additions. Customization IDs are unique across the whole toolset, with manifest items and then the
first saved addition winning. `mergeToolsetItemAdditions` is the shared merge path for registry and
editor previews.

`normalizeToolsetItem`, `normalizeToolsetDefinition`, and `normalizeToolsetDefinitions`
are the preferred read path for UI code. They fill defaults for legacy items, preserve
sparse item metadata, and produce `NormalizedToolsetItem` values for palette renderers.
