# UX Surfaces

Status: tiny local metadata scaffold implemented; rendered UI is not yet driven by it.

ChemDraft should bake stable contracts, not user-facing placement. Chemistry behavior, native document state, command IDs, plugin permissions, adapter interfaces, viewport coordinate math, import/export rules, and chemical identity invariants should remain stable. Menus, palettes, panels, status items, canvas controls, labels, icons, shortcut maps, and default visibility may evolve as the owner and users refine the app.

## Command-Backed Controls

Every control that performs an action should route through a command ID where practical. A future surface model can describe where that command appears without making the placement part of the chemistry or document contract.

Candidate fields:

```text
id
kind
commandId
slot
label
icon
defaultVisible
source: core | plugin | user | owner
order
featureFlag
```

The local `apps/desktop/src/surfaces` module now defines this metadata shape and a small set of core surface definitions. It is not a full UX registry package, plugin surface renderer, rendered surface system, or customization UI. Promote it to `packages/ux-registry` only if multiple packages need the model.

Existing UI rendering is not yet wired to this metadata. Future controls should register metadata first, then wire rendering deliberately.

## State Separation

Owner defaults are project-level layout and style choices. User preferences are local app configuration, such as toolbar visibility, panel state, and shortcut overrides. Document state is file-traveling data, such as pages, page sizes, objects, and styles used by the document.

Do not store owner defaults or local user preferences in `.chemdraft` files unless they truly belong to the document.

## Examples

Toolbars already follow this direction through `toolset-registry`: toolset manifests define command-backed buttons, source, visibility, and customization state without putting chemistry behavior in buttons.

A future circular add-page button should be a `canvas-control` surface that invokes `document.addPageAfter`. It should not be a one-off hard-coded button with behavior hidden in the component.

`surface.canvas.addPageAfter` currently exists only as disabled metadata. It must not render as an active control until `document.addPageAfter` exists and is wired.

Empty states, menu items, panel entries, and status-bar items should move toward the same surface/slot pattern where practical.

Toolsets remain under `toolset-registry`. The local surface schema is for menus, status items, canvas controls, panels, empty states, and similar chrome; it must not duplicate toolset behavior or own chemistry behavior.
