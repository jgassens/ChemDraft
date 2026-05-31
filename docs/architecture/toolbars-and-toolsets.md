# Toolbars And Toolsets

Status: customization-ready schema and command surface, without drag-and-drop UI.

ChemDraft toolbars are declarative toolsets backed by command IDs. A toolbar button never owns behavior directly; it invokes a command registered by the app or a plugin.

## Sources

- Built-in toolsets come from ChemDraft manifests such as `apps/desktop/src/toolsets/desktop-toolsets.json`.
- Plugin toolsets come from plugin contributions and keep `source: "plugin"`.
- User toolsets come from versioned user customization state and keep `source: "user"`.

User customization references command IDs. It must not copy command implementations, mutate plugin manifests, grant plugin permissions, or bypass command registration.

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
- user-created toolsets,
- cloned built-in or plugin toolsets,
- toolbar size and cell-size preferences.

Future drag-and-drop customization should edit this state, not source manifests. Built-in and plugin manifests remain stable source contributions.

## View Menu

The View > Toolbars menu should be generated from the registry plus customization state:

```text
built-in toolsets
plugin toolsets
user toolsets
user layout state
-> menu items with command IDs
```

The menu item command remains `view.toolset.toggle.<toolsetId>`. Customization commands such as `view.customizeToolbars` exist as disabled placeholders until the editor UI is implemented.

## ChemDraw XML Boundary

ChemDraw toolbar XML is not the ChemDraft toolbar format.

ChemDraw XML may be studied conceptually as evidence that toolbar layouts are data, but do not copy ChemDraw command IDs, icon names, XML schemas, image assets, menu text, or trade dress.

If external toolbar import is ever added, it must be a compatibility/import layer. It should map known external actions into ChemDraft command IDs, warn for unmapped commands, and preserve the legal boundary.

## Future Drag And Drop

Do not add a drag-and-drop dependency until the customization UI is actually being built.

Future dependency recommendation:

- `dnd-kit`: preferred. It supports custom sensors, keyboard/touch/pointer input, sortable behavior, and custom layout logic for toolbar grids.
- `@hello-pangea/dnd`: acceptable for simple lists, but less ideal for mixed grid/palette layouts.
- `SortableJS`: good for plain sortable lists, less ideal for command-driven React tool palettes.
- `react-beautiful-dnd`: do not use. It is archived/deprecated.

Any future dependency addition must update `docs/architecture/dependency-inventory.md` with package name, purpose, license, core/optional status, and distribution impact.

## Asset Note

Current toolbar asset IDs use `Custom_*` names and the checked-in files live under `apps/desktop/src/assets/toolbar`. These must remain original ChemDraft assets. If any asset is found to be copied from ChemDraw or another proprietary toolbar pack, remove it or replace it with an original placeholder glyph before release.

Later, prefer ChemDraft-native asset IDs that describe command meaning without carrying import-history names.
