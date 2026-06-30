# @chemdraft/engine3d-api

Pure protocol types and guards for ChemDraft's external interactive 3D engine sessions.

This package intentionally has no native dependencies. It defines the stable newline-delimited
JSON contract between ChemDraft and a future Avogadro-style sidecar, plus fake-engine helpers
used by tests before a native sidecar exists.

The current product contract is ChemDraft-rendered and sidecar-optimized:

- ChemDraft owns the visible 3D Workspace panel.
- ChemDraft renders the scene in a React-owned WebGL canvas from sidecar coordinates.
- The native sidecar owns molecule state, atom-drag constraints, and force-field optimization.
- Dragging is expressed in world-space coordinates through `beginDrag`, `updateDrag`, and `endDrag`.
- Coordinate events are latest-frame-wins from the React side; the protocol does not stream rendered images.
- `showViewport` / `hideViewport` window semantics are not part of the product protocol.

The older PNG/offscreen-frame protocol was removed because it made the visible interaction depend
on image transport instead of a real editor viewport. A future render-backend swap should preserve
the same product semantics: ChemDraft owns the panel, the sidecar owns 3D mechanics.
