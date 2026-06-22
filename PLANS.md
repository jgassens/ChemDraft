# Spin 3D Handoff / Rotation Parity Fix

## Context

Spinning a molecule in 3D then committing it (overlay release, or a later 3D-backed X/Y
rotation) makes the committed drawing **balloon and change proportions** on edge-on views,
and **jump** when the Spin 3D overlay is reopened. It's a projection-parity bug, not a
chemistry-engine or zoom bug.

Two different projection contracts are in play:

- The live overlay uses `projectSpin(coords3d, bondPairs, quat, placement)` with a **fixed**
  `ScreenPlacement.scale` ([spinOverlay.ts:239](apps/desktop/src/interaction/spinOverlay.ts:239)),
  so an edge-on molecule foreshortens *inside the same box*.
- `flattenSpunMolecule` instead **rescales the projection back to the molecule's current
  median 2D bond length** ([documentWorkflow.ts:9757-9777](apps/desktop/src/documentWorkflow.ts:9757)):
  `scale = medianOriginal / medianProjected`. Edge-on -> `medianProjected -> 0` -> scale blows
  up -> the molecule inflates. Every commit and every modeled X/Y drag frame goes through
  this path, so the drawing diverges from the overlay and drifts across rotations.

Fix: make every modeled Spin 3D path share **one fixed `ScreenPlacement` contract** -- initial
overlay, optimized-coordinate hot-swap, overlay release/flatten, overlay reopen, drag X/Y,
typed X/Y, drag Z, typed Z -- with **zero** change to chemical identity, stereo validation,
wedges, crossings, depth cues, or CDXML/CDX behavior.

This plan reconciles codex's redo with the verified code. Two correctness facts make it
robust (and are why this is safe to do per-keystroke / per-frame):
- **Preview re-derives from a frozen base.** `rotationInputDocumentFromDraft`
  ([6537](apps/desktop/src/MainWindow.tsx:6537)) always recomputes from `input.startDocument`;
  drag flattens from `drag.startDocument` ([6244](apps/desktop/src/MainWindow.tsx:6244)). So
  folding the updated orientation into the preview document is **idempotent** -- typing/dragging
  never accumulates scale or rotation drift.
- **Commit promotes the preview.** `handleRotationInputKeep`
  ([6670](apps/desktop/src/MainWindow.tsx:6670)) -> `commitLiveInputPreview`, and drag commit is
  `commitProjectedPlaneTilt` ([6492](apps/desktop/src/MainWindow.tsx:6492)). The folded model
  is already in the previewed doc, so nothing special is needed at commit.

## Exact code changes

### 1. Reuse projection primitives; add one scale helper
File: [spinOverlay.ts](apps/desktop/src/interaction/spinOverlay.ts)

Do **not** add a `SpinProjectionPlacement` type or a `projectConformerToPlacement` projector --
reuse the existing `ScreenPlacement`, `projectSpin`, `projectPoint`, `conformerCentroid`,
`medianBondLength2d`. Add one helper next to `overlayScale`:

```ts
export function orientedOverlayScale(
  drawn2dPoints: readonly { x: number; y: number }[],
  coords3d: ArrayLike<number>,
  bondPairs: readonly BondPair[],
  viewMatrix: ViewMatrix
): number
```

- `centroid = conformerCentroid(coords3d)`.
- For each atom: subtract centroid, `projectPoint(viewMatrix, centered)`, push `{ x: px, y: -py }`.
- `drawn = medianBondLength2d(drawn2dPoints, bondPairs)`,
  `projected = medianBondLength2d(projectedPoints, bondPairs)`.
- Return `drawn / projected` when both > 0, else `1` (never `Infinity`/`NaN`).

This scales the current 2D drawing against the conformer **projected at a given orientation**
(not the raw 3D median), so `projectSpin` lands exactly on a tilted committed molecule. Used
only for reopen/rotation of an already-modeled molecule; fresh embed keeps `overlayScale`.

### 2. `flattenSpunMolecule` -- optional placement (core fix)
File: [documentWorkflow.ts:9700](apps/desktop/src/documentWorkflow.ts:9700)

- Add `import type { ScreenPlacement } from "./interaction/spinOverlay";` (type-only; no
  runtime cycle -- spinOverlay never imports documentWorkflow).
- New signature: `flattenSpunMolecule(document, objectId, coords3d, viewMatrix, options: { placement?: ScreenPlacement } = {})`.
- Replace **only** the median-rescale block
  ([9757-9777](apps/desktop/src/documentWorkflow.ts:9757)). Keep `projectedById`,
  `projectedInOrder`, `projectedCentroid`.
  - **With `placement`:** affine-transform the coords `flattenPerspectiveFrom3D` already
    produced (provably identical to `projectSpin`, but consistent with the wedge/crossing
    geometry -- do not re-project):
    ```ts
    x: placement.centerX + (p.x - projectedCentroid.x) * placement.scale
    y: placement.centerY + (p.y - projectedCentroid.y) * placement.scale
    ```
  - **Without `placement`:** keep the existing median-rescale/recenter logic exactly
    (back-compat for the current test suite).
- Leave untouched: `flattenPerspectiveFrom3D`, stereo refusal, wedge/hash assignment, graph
  identity diff, crossing computation/patching, `display.depthWeight`, `defaultDoubleBondSide`,
  molfile rewrite, page-bound clamping, selection preservation.

### 3. `MainWindow` -- thread placement everywhere
File: [MainWindow.tsx](apps/desktop/src/MainWindow.tsx)

- Import: add `orientedOverlayScale` to the existing `spinOverlay` import
  ([398](apps/desktop/src/MainWindow.tsx:398)).
- `spinPlacementFor` ([2478](apps/desktop/src/MainWindow.tsx:2478)): add optional
  `orientation?: Quaternion`. Keep `centerX/centerY` (mean of drawn atoms) and `bondPairs`.
  Scale = `orientedOverlayScale(points2d, coords3d, bondPairs, quatToViewMatrix(orientation))`
  when `orientation` is given, else `overlayScale(...)`.
  - Fresh embed ([2697](apps/desktop/src/MainWindow.tsx:2697)) and refined hot-swap
    ([2728](apps/desktop/src/MainWindow.tsx:2728)): unchanged (naive scale).
  - Reopen ([2610](apps/desktop/src/MainWindow.tsx:2610)): pass `reopen.quat`.
- `commitSpinFlatten` ([2386](apps/desktop/src/MainWindow.tsx:2386)): pass
  `{ placement: state.placement }`.

### 4. `Spin3dRotateSnapshot` + drag start
File: [MainWindow.tsx:629](apps/desktop/src/MainWindow.tsx:629)

- Add **`placement: ScreenPlacement`** to `Spin3dRotateSnapshot`. (Do not add `bondPairs` to
  the snapshot -- nothing consumes it during drag; keep the snapshot minimal.)
- `spin3dRotateSnapshotFor` ([6186](apps/desktop/src/MainWindow.tsx:6186)): compute the fixed
  placement via `spinPlacementFor(molecule, coords3d, model.orientation)` and store it. Both
  drag-state builders ([9171](apps/desktop/src/MainWindow.tsx:9171),
  [9332](apps/desktop/src/MainWindow.tsx:9332)) go through this one function, so they inherit it.

### 5. Modeled drag X/Y
Function `projectedPlaneTiltFromDrag`, 3D branch
([6231-6263](apps/desktop/src/MainWindow.tsx:6231)).
- Keep the delta-quaternion order and `nextQuat` composition exactly as today.
- Change the flatten call to pass `{ placement: model.placement }` (fixed snapshot placement)
  on every preview frame.
- Keep the "last valid preview" handling for stereo-refused frames; commit
  ([6492](apps/desktop/src/MainWindow.tsx:6492)) attaches `lastValidOrientation` as today.

### 6. Modeled typed X/Y -- delta semantics
Function `rotationInputDocumentFromDraft`, `kind: "xy"`
([6561](apps/desktop/src/MainWindow.tsx:6561)).
- Only when the whole molecule has `validSpin3dModelFor(object)` (read off `input.startDocument`).
  Read `coords3d` via `spin3dModelCoordsForMolecule`; build `placement` from the molecule at
  `model.orientation` (`spinPlacementFor(object, coords3d, model.orientation)`).
- Treat typed degrees as a **nudge**: `deltaQuat = quatMultiply(quatFromAxisAngle(SPIN_AXIS_Y, yRad), quatFromAxisAngle(SPIN_AXIS_X, xRad))`,
  `nextQuat = quatNormalize(quatMultiply(deltaQuat, model.orientation))`.
- `flattenSpunMolecule(input.startDocument, objectId, coords3d, quatToViewMatrix(nextQuat), { placement })`;
  if committed, `document = attachSpin3dModelFromConformer(outcome.document, objectId, { coords3d, orientation: nextQuat, engine: model.engine })`.
  (Idempotent: base is always `startDocument`.)
- Return `{ kind: "xy", document, tiltXRad: xRad, tiltYRad: yRad, clamped: false }`.
- Seed the typed X/Y drafts to `0` for modeled molecules when the rotation input opens (delta
  baseline), so reopening after a commit starts from 0 rather than a stale absolute tilt.
- Non-modeled molecules, selected fragments, and art objects keep the legacy
  `tiltNativeMoleculeProjectedPlane` / `applyDocumentObjectProjectedPlaneTilt` path untouched.

### 7. Modeled typed Z
Function `rotationInputDocumentFromDraft`, `kind: "z"`
([6543](apps/desktop/src/MainWindow.tsx:6543)).
- Keep the visible 2D path (`rotateDocumentObject` with the existing absolute-Z delta).
- When `validSpin3dModelFor(object)`: fold the **applied** Z delta into the stored model,
  mirroring drag Z's sign ([6460-6481](apps/desktop/src/MainWindow.tsx:6460)):
  `nextQuat = quatNormalize(quatMultiply(quatFromAxisAngle(SPIN_AXIS_Z, -deltaDegrees * Math.PI/180), model.orientation))`,
  then `attachSpin3dModelFromConformer(rotatedDocument, objectId, { coords3d, orientation: nextQuat, engine: model.engine })`.
  (Idempotent via the frozen-base property.) Non-modeled/art unchanged.

### 8. Build stamp + guardrail note
- Bump `CURRENT_BUILD_STAMP` ([MainWindow.tsx:962](apps/desktop/src/MainWindow.tsx:962)) and
  `**Current Build**` ([AGENTS.md:3](AGENTS.md:3)) to the current date/time per the `M.D.x`
  convention.
- Add a Spin 3D note to AGENTS.md: `ScreenPlacement` is the shared visual contract (overlay,
  flatten, reopen, drag, typed); `flattenSpunMolecule(..., { placement })` must match
  `projectSpin`; do not add duplicate projection helpers (consistent with section 5.26 -- no
  rendering math added; projection/scale live in `interaction/`, flatten in `documentWorkflow`).

## Tests

- **spinOverlay.test.ts** -- `orientedOverlayScale`: tilted current 2D + stored orientation
  yields a scale where `projectSpin` reproduces the current median 2D bond length; `overlayScale`
  unchanged for fresh embed; edge-on returns finite (never `Infinity`/`NaN`).
- **spinFlatten.test.ts** -- with `placement`, flattened atom coords match `projectSpin` for the
  same coords/orientation/placement (parity linchpin); edge-on/oblique stays inside the placement
  envelope instead of inflating; `display.depthWeight` still equals `bondDepthWeights`; existing
  no-placement median-rescale tests stay green.
- **flattenRoundTrip.test.ts** -- existing IDENTITY/tilted round-trips stay green; add a placement
  round-trip.
- **spin3dModel.test.ts** -- initial flatten+attach then modeled X/Y keeps median size bounded;
  repeated X/Y rotations don't drift in width/height; drag Z and typed Z fold the same-sign
  stored orientation; modeled typed X/Y updates the stored orientation and writes no legacy
  `tiltXDegrees/tiltYDegrees`.
- **spin3dSession.test.ts** -- start spin -> commit flatten -> reopen; overlay exists and object
  bounds before/after reopen do not jump (mocked conformer callbacks; no real OCL).
- **App.test.ts** -- modeled typed X/Y calls `flattenSpunMolecule` with placement; non-modeled
  typed X/Y stays on the legacy tilt path.

Run:
```bash
pnpm vitest run apps/desktop/src/interaction/spinOverlay.test.ts apps/desktop/src/spinFlatten.test.ts apps/desktop/src/flattenRoundTrip.test.ts apps/desktop/src/spin3dModel.test.ts apps/desktop/src/spin3dSession.test.ts apps/desktop/src/App.test.ts
pnpm vitest run apps/desktop/src/agentBridge.test.ts apps/desktop/src/drawingTools.test.ts
pnpm lint
cargo test agent_bridge
git diff --check
```

## Manual verification (browser)
Per the chemdraft browser-verification workflow (launch.json swap, dev port 5174,
agent-bridge fire-and-forget):
1. Spin a non-planar molecule; let optimized/refined coords hot-swap in.
2. Tilt to near edge-on, release -> committed drawing matches the overlay footprint (no balloon).
3. Reopen Spin 3D -> overlay lands on the drawing (no jump).
4. Drag X/Y repeatedly -> bounded envelope, foreshorten only, no cumulative drift; bond color +
   thickness keep updating from depth.
5. Typed X/Y on the modeled molecule -> same behavior as a drag nudge; fields reset to 0 after apply.
6. Typed Z on the modeled molecule -> visible Z rotation, stored orientation stays in sync.
7. Non-modeled molecule X/Y tilt and art-object tilt -> visually unchanged.

## Acceptance
- Overlay, initial flatten, reopen, drag X/Y, typed X/Y, drag Z, typed Z share one visual
  placement contract for modeled molecules.
- Edge-on modeled rotations foreshorten; they never inflate; repeated rotations don't drift.
- Depth color/stroke width keep updating on every modeled X/Y rotation.
- Stereo validation, chemical identity, bond order, charge, wedges, crossings, molfile rewrite,
  and CDXML/CDX behavior unchanged; legacy non-modeled/art tilt unchanged.
- No duplicate projection math introduced.
