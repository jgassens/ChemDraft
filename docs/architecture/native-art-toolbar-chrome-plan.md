# Full Native Art Toolbar And Chrome Plan

## Summary

ChemDraft will build the Art Toolbar as a native art and chrome system over `GraphicObject`, not as a second drawing app and not as a visual clone of any proprietary toolbar. Reference tools are only a functional checklist. Icons, labels, command IDs, and chrome must be original ChemDraft work.

All toolbar actions must be command-backed. Dependency-native objects must never be persisted. `GraphicObject` remains the native document boundary for art primitives, while `@chemdraft/art-engine` owns art planning, projection, bounds, paint planning, editable handles, and export/editor parity.

## Current Foundation

- `chem-core` supports `GraphicPaint` for `none`, `solid`, `linear-gradient`, and `radial-gradient`, with opacity and object-local gradient coordinates.
- `GraphicObjectStyleSchema` supports paint, opacity, stroke width, dash, cap, join, miter, gloss/effect, and tilt fields.
- `GraphicObjectDataSchema` supports line/path/arc metadata, `cornerRadiusPx`, and legacy path fields.
- `@chemdraft/art-engine` owns native art planning, projection, bounds, capabilities, paint plans, path handles, and uses `svg-path-commander`.
- `ToolPalette.tsx` uses `@jaames/iro` for the shared color wheel/slider, with RGB/CMYK/HEX fields and palette swatches kept in owned React UI.
- Editor layering invariant: in editor mode, `GraphicObject`s remain filtered out of `PageSvgSurface` and render only through the overlay. Export and editor may consume the same art-engine plan, but editor mode must not reintroduce duplicate or frozen graphics.

## Locked Model Decisions

These are decisions for the full art system, not fields to add immediately. Add each schema field only in the phase that implements behavior for it.

Phase 0 may add only:

- `arcCenter?: Point`
- `arcRadiusX?: number`
- `arcRadiusY?: number`

Phase 3 adds:

- `GraphicMarkerSchema`
- `markerStart?: GraphicMarker`
- `markerEnd?: GraphicMarker`

Phase 4 adds:

- `artPathKind` values `polyline | bezier`
- `GraphicPathNodeSchema`
- `pathNodes?: GraphicPathNode[]`
- `pathClosed?: boolean`

Phase 5 adds:

- `artPathKind` value `freehand`
- `GraphicFreehandPointSchema`
- `GraphicFreehandOptionsSchema`
- `freehandPoints?: GraphicFreehandPoint[]`
- `freehandOptions?: GraphicFreehandOptions`

Phase 10 adds:

- `GraphicEffectSchema`
- `effects?: GraphicEffect[]`, while preserving legacy `style.effect`

## Dependency Plan

Already present:

- `svg-path-commander` in `@chemdraft/art-engine`
- `@jaames/iro` in `apps/desktop`

Add later, one phase at a time:

- Phase 4: `bezier-js` for robust cubic path editing.
- Phase 5: `perfect-freehand` for pencil and brush strokes.
- Phase 6: `@flatten-js/core` for lasso, geometry hit testing, spatial queries, and boolean operations.
- Phase 10: `roughjs` for optional deterministic sketch effects.

Before adding any dependency, verify license metadata and confirm no forbidden license enters the bundled core dependency graph.

## Implementation Rules

- No Fabric, Konva, Excalidraw, tldraw, or second drawing app in the document canvas.
- No copied proprietary icons, toolbar art, command IDs, schemas, file paths, or trade dress.
- No decorative disabled future buttons in the final toolbar. If a feature is not implemented in its slice, hide it.
- Toolbar controls set modes and styles; canvas handles edit geometry.
- Line Ends and Corners are not primary toolbar controls. Arrowheads and corner-radius handles are the primary UX.
- Browser rendering and SVG export must consume the same art-engine plan for path data, paint, markers, gradients, effects, projection, and bounds.
- Editor mode must continue to render graphics only through overlay `GraphicGlyph`, not `PageSvgSurface`.
- Undo/redo should create one history entry per completed user edit.

## Phase 0: Current Bug Hardening

Goal: stabilize the current art toolbar before expanding feature surface.

Scope:

- Implement semantic arc editing in `@chemdraft/art-engine`.
- For existing circular arcs without semantic fields, synthesize center from object bounds and synthesize `radiusX = max(width / 2 - 4, 1)`, `radiusY = max(height / 2 - 4, 1)`.
- Do not persist synthesized arc fields until the user edits the arc.
- Middle handle changes midpoint angle and radius while preserving sweep.
- Start and end handles change start/sweep only and do not alter radius.
- After edits, recompute object bounds from sampled arc points plus stroke padding while preserving semantic arc center and radii in `data`.
- Handle positions must always derive from semantic arc center/radii/start/sweep, not stale bounds.
- Rotated and tilted arcs must use `projectGraphicObjectPoint` and `unprojectGraphicObjectPoint`.
- Preserve the line segment middle-dot behavior as a freeform curve edit, not a conversion into the circular arc tool.
- Complete rectangle corner-radius handle only if incomplete.
- Fix art color picker reliability: wrapper ref around trigger/popover, outside capture pointerdown closes, inside pointerdown stays open, Escape/window blur/selection change close, `onChange` previews, `onChangeEnd` commits one undo entry, trigger toggles reliably.
- Hide Line Ends and Corners from the primary art toolbar.
- No toolbar taxonomy redesign and no new dependency in Phase 0.

Tests:

- Arc middle handle stays attached to the visible arc.
- Middle drag changes radius/angle and preserves sweep.
- Start/end drag changes sweep only.
- Rotated/tilted arc remains editable after deselect/reselect.
- Line middle handle bends into a freeform curve, stays attached to the visible curve, and does not create circular arc metadata.
- Picker opens, closes on outside click, stays open on inside click, closes on Escape/blur/selection change.
- Line Ends and Corners are absent from the primary toolbar.
- No duplicate graphics in editor mode.

## Phase 1: Toolbar Taxonomy And Command Surface

Goal: make the toolbar represent the intended native art system without cloning the reference toolbar.

Toolbar groups:

- Selection
- Shapes
- Paths
- Freehand
- Paint
- Effects
- Arrange/Transform
- Shape Ops
- View

Required command concepts:

- Select and Direct Edit
- Rectangle, ellipse, line, circular arc, arrow, text
- Pen/Bezier, polyline, scissors/split segment, eraser
- Pencil and brush
- Fill/stroke target, fill color, stroke color, no fill/no stroke, swap fill/stroke
- Linear/radial gradient, eyedropper
- Bring front/back, forward/backward, group/ungroup, flip horizontal/vertical
- Boolean union/subtract/intersect/split
- Shadow, glow, sketch

Rules:

- Every visible item maps to a registered command.
- Every command has an original ChemDraft icon and tooltip.
- Existing preset commands may remain callable for compatibility, but should not dominate the primary toolbar.

## Phase 2: Direct Edit Mode

Goal: make selected objects editable directly on canvas.

Art-engine APIs:

- `graphicEditableHandles(object): GraphicEditableHandle[]`
- `editGraphicHandle(object, handleId, point): GraphicObject`

Handle types:

- `line-start`, `line-end`, `line-middle`
- `arc-start`, `arc-middle`, `arc-end`
- `rect-corner-radius`
- `path-node`, `path-in-control`, `path-out-control`
- `marker-start-size`, `marker-end-size`

Tests:

- Rect radius max makes a pill/circle-like shape.
- Dragging radius handle commits one undo entry.
- Arc midpoint stays attached.
- Line endpoint drag updates `lineStart`/`lineEnd`.
- Bezier node drag updates path nodes once Phase 4 lands.

## Phase 3: Arrowhead Model And Arrow Tool

Goal: replace confusing line-end controls with real arrowheads.

Schema additions:

- `GraphicMarkerSchema`
- `data.markerStart?: GraphicMarker`
- `data.markerEnd?: GraphicMarker`

Supported markers:

- none
- open arrow
- filled arrow
- bar
- dot
- diamond
- chevron

Behavior:

- Arrow tool creates a line/path with `markerEnd` set to a filled arrow.
- Selected arrows show endpoint handles plus arrowhead handles.
- Arrowhead handle drag adjusts marker size and angle.
- SVG export emits marker definitions and `marker-start`/`marker-end`.

Tests:

- Arrow tool inserts a native line/path with `markerEnd`.
- SVG export contains marker defs.
- Dragging arrowhead handle changes size.
- Open/filled/bar/dot/diamond markers render in editor and export.

## Phase 4: Pen, Polyline, Scissors, And Segment Editing

Goal: build real path creation and editing.

Dependency:

- Add `bezier-js` only in this phase.

Schema additions:

- `data.pathNodes: GraphicPathNode[]`
- `data.pathClosed: boolean`
- `data.artPathKind: "polyline" | "bezier"`

Pen behavior:

- Click creates node.
- Drag creates Bezier controls.
- Double-click or Enter finishes an open path.
- Click first node closes path.
- Escape cancels active path.
- Backspace removes last node while drawing.

Scissors behavior:

- Click near a path segment splits at the nearest point.
- Selected segment Backspace deletes the segment.
- Closed paths can become open after segment deletion.

Tests:

- Pen creates path nodes.
- Closed paths support fill; open paths do not.
- Scissors splits line and cubic segments.
- Deleting a segment preserves a valid path.
- Undo/redo works.

## Phase 5: Freehand Pencil And Brush

Goal: implement pencil and brush tools.

Dependency:

- Add `perfect-freehand` only in this phase.

Schema additions:

- `data.artPathKind = "freehand"`
- `data.freehandPoints = [{ x, y, pressure }]`
- `data.freehandOptions`

Behavior:

- Pencil uses smaller size and lower smoothing.
- Brush uses larger size and pressure-sensitive outline behavior.
- Persist raw points/options; art-engine converts to SVG path plans.

Tests:

- Pointer drag creates one freehand object.
- Pressure affects width when present.
- Pencil and brush produce different widths.
- SVG export matches editor path.
- Undo/redo creates one object per stroke.

## Phase 6: Lasso, Eraser, And Hit Testing

Goal: support freeform selection and eraser behavior.

Dependency:

- Add `@flatten-js/core` only in this phase.

Behavior:

- Freeform lasso selects objects whose bounds/path intersect the lasso polygon.
- Alt-lasso subtracts from selection.
- Eraser on object deletes object.
- Eraser in direct-edit mode deletes a point or segment.

Tests:

- Lasso selects enclosed rectangle/circle/path.
- Lasso intersects stroke paths.
- Alt-lasso subtracts.
- Eraser deletes object.
- Eraser deletes direct-edit node/segment.

## Phase 7: Gradient Editor

Goal: make gradient paint real in UI and export.

Behavior:

- Fill/stroke type controls: none, solid, linear, radial, gloss preset.
- Gradient rail and stop list.
- Stop color and opacity editing with the shared `@jaames/iro` color popover.
- Add, delete, reverse, and rotate stops.
- Linear start/end handles and radial center/radius/focus handles on canvas.

Rules:

- Use existing `GraphicPaint` gradient schema.
- Do not add a gradient-picker package.
- Editor and export must match gradient coordinates, stops, opacity, transforms, and projection.

Tests:

- Linear gradient exports same coordinates as editor.
- Radial gradient exports same center/radius.
- Stops are sorted by offset.
- Stop opacity works.
- Rotated/tilted objects transform gradients consistently.

## Phase 8: Eyedropper And Style Copy/Paste

Goal: make eyedropper useful without pixel sampling first.

Behavior:

- Click source object.
- Active fill target copies fill paint and opacity.
- Active stroke target copies stroke paint, opacity, width, dash, and marker data where supported.
- Alt copies full appearance.

Tests:

- Eyedropper copies fill from rect to circle.
- Eyedropper copies stroke from line to arc.
- Alt-eyedropper copies full appearance.
- Undo works.

## Phase 9: Boolean Shape Operations

Goal: support native shape operations.

Dependency:

- Use `@flatten-js/core` added in Phase 6.

Supported inputs:

- Closed rect
- Closed ellipse converted to approximation
- Closed Bezier/path
- Closed freehand outline

Commands:

- union
- subtract
- intersect
- split

Rules:

- Enabled only for at least two closed fill-capable graphics.
- Open lines/arcs are skipped with status or warning.
- Result is a native path `GraphicObject`.

Tests:

- Union two rectangles.
- Subtract circle from rectangle.
- Intersect two ellipses.
- Open line skipped with warning/status.
- SVG export works.

## Phase 10: Effects

Goal: implement shadow, glow, and sketch effects as editable style metadata.

Dependency:

- Add `roughjs` only in this phase.

Schema additions:

- `GraphicEffectSchema`
- `style.effects?: GraphicEffect[]`

Rules:

- Preserve legacy `style.effect`.
- Editor and export consume the same effect plan.
- Do not convert editable objects into opaque SVG.
- Sketch output must be deterministic by seed.

Tests:

- Shadow appears in editor/export.
- Glow emits SVG filter output.
- Sketch mode uses deterministic seed.
- Sketch export is stable.

## Phase 11: Arrange, Group, Layer, And Transform

Goal: complete the overlapping-squares and layer-operation part of the art system.

Rules:

- Use existing `GroupObjectSchema`, but implement real document patches, selection behavior, export behavior, and undo tests.
- Keep document state and user toolbar state separate.

Features:

- Bring forward/backward
- Bring to front/back
- Group/ungroup
- Flip horizontal/vertical
- Rotate 90 degrees
- Duplicate
- Align left/center/right/top/middle/bottom
- Distribute horizontal/vertical

Tests:

- Group preserves children.
- Ungroup restores children.
- Layer order updates.
- Flip changes geometry around selection center.
- Align/distribute are stable.
- Undo/redo works.

## Phase 12: Final Toolbar And Chrome Polish

Goal: make the full native art panel usable, dense, and testable.

Chrome requirements:

- Original icons only.
- Tooltips on every tool.
- Flyouts for shape, path, freehand, paint, effects, and arrange groups.
- Inspector updates based on selection.
- Direct handles on canvas for geometry.
- Toolbar sets modes/styles; canvas handles edit geometry.
- No inert visible controls.
- No visual cloning of proprietary toolbar art.

Tests:

- Every visible button maps to a command.
- Every command has a tooltip.
- Hidden compatibility commands remain callable if needed.
- No disabled fake future buttons in final state.

## Gates

Each implementation phase should run:

- Focused tests for the phase.
- `pnpm lint`.
- `pnpm test` before push.
- `git diff --check`.
- Browser interaction QA for visible behavior changes.
- Built-app QA with `./run-app` when the user needs to test the desktop bundle.
