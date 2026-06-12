# Grouped Object Transform Entry

Status: design note for the grouped selection transform UI.

ChemDraft already has single-object double-click entry for exact rotation and molecule stretch. Group selections should use the same interaction idea without making the group a new document object and without hiding chemistry behavior inside handle-local UI.

## Target Behavior

- Double-click the grouped selection rotate handle to open exact angle entry for the selected group.
- Double-click any grouped selection resize handle to open exact size entry for the selected group.
- The entry popovers are anchored to the group transform frame and use the same compact input styling as single-molecule rotation/stretch entry.
- Applying an angle rotates every selected object about the current group selection center.
- Applying size values scales every selected object about the current group selection center.
- Canceling or pressing Escape closes the popover without changing the document.
- Dragging a handle keeps the current drag behavior; double-click only opens numeric entry.

## Model Boundary

Grouped numeric entry is interaction state, not document state. It must not create a persistent group object merely to remember the entry surface.

The implementation should reuse these existing document-workflow helpers:

- `selectionBounds(...)` for the current group frame and center.
- `rotateDocumentObjectsAroundPoint(...)` for exact angle apply.
- `scaleDocumentObjectsAroundPoint(...)` for exact size apply.

For selected native molecules, these helpers must preserve atoms, bonds, bond orders, charge, stereo/display metadata, and chemical identity. For non-molecule page objects, the same group-center transform rules apply to object boxes and rotations.

## Entry Semantics

### Angle

The group angle field is an absolute displayed angle for the current entry session, seeded at `0`.

Applying `theta` degrees means:

```text
rotate selected objects about selection center by theta degrees
```

This differs from single-molecule entry, where the field can represent a molecule's persisted `transform.rotationDegrees`. A multi-object selection has no single persisted group rotation, so the group field is session-local.

### Size

The group size fields are percentages seeded at `100` for X and Y.

Applying `X%` and `Y%` means:

```text
scale selected objects about selection center by X / 100 and Y / 100
```

Uniform resize can be represented by equal X/Y values. Non-uniform resize remains explicit and should use the same positive-percent validation as molecule stretch entry.

## Command And Surface Notes

The rendered controls can stay local to `MainWindow` while this is still a Phase 7 desktop interaction, but the behavior should remain command-shaped:

- rotate entry apply maps to the layout operation behind grouped rotation;
- size entry apply maps to the layout operation behind grouped scaling;
- the group frame remains a UI surface only;
- no plugin permissions, document schema fields, or native group objects are introduced.

When the command registry grows first-class layout commands for exact transforms, the popover apply handlers should call those commands instead of direct helper functions.

## Acceptance Checks

- Double-clicking the group rotate handle opens an angle entry popover and does not start a drag.
- Double-clicking a group resize handle opens a size entry popover and does not start a drag.
- Applying angle/size creates one undoable document change.
- Escape/cancel creates no history entry and restores no stale preview.
- Group transforms keep molecule graph identity intact and do not change atom elements, bond ids, bond orders, charges, or selected object ids.
- Group transforms preserve visible cyclic double-bond placement inside rings after rotation or projected-plane transforms.
