# Molecule Inspector: Rings-First Slice 1

## Summary

Re-scope the first implementation to the genuinely new capability: native ring identity, per-ring fill styling, ring interior selection, and a dedicated hidden-by-default `Molecule Inspector` palette. Reuse existing molecule paint/effect, art-inspector, command, export, and per-bond display plumbing. Defer Drawing, Atom Labels, Indicators, and per-bond width/opacity/effects to later slices.

Slice 1 acceptance target: in an anthracene-like fused molecule, the user can click each ring interior, select that ring, assign a distinct fill color/effect from `Molecule Inspector`, see it on canvas, save/export it, and not mutate chemical identity.

## Scope Corrections

- Do not add `NativeMoleculeDrawingSettings`, `NativeAtomLabelSettings`, or `NativeMoleculeIndicatorSettings` in slice 1.
- Do not add a `style.bondStyles` map. Per-bond identity already lives on `bond.display.bondStyle`; per-bond color already uses `style.bondColors`.
- Do not rebuild whole-molecule fill/stroke/opacity/effect logic. Reuse existing molecule-compatible art workflows.
- Do not create a permanent side inspector. Add a compact floating palette/toolset named `Molecule Inspector`.
- Do not copy screenshot dialog layout, wording, or proprietary UI art. Functional tab/section names are fine.

## Data Model

Add one new native display storage concept:

```ts
type MoleculeRingStyleMap = Record<string, NativeRingAppearance>;

interface NativeRingAppearance {
  fillPaint?: GraphicPaint;
  fillColor?: string;
  fillOpacity?: number;
  effects?: VisualEffect[];
}
```

Store it on `MoleculeObject.style.ringStyles`.

Ring keys:

- `ringKey = sorted bond IDs joined by "|"`
- Example: `bond_001|bond_002|bond_003|bond_004|bond_005|bond_006`
- Ring keys are topology-derived, never coordinate-derived, so move/scale/rotate does not change them.

Style resolution order:

1. `style.ringStyles[ringKey]`
2. whole-molecule fill fields already used for molecule fill
3. legacy/default molecule style fields
4. `ChemDraftSyntheticStylePreset`

Stale pruning:

- When a molecule topology changes, recompute valid ring keys.
- Drop `style.ringStyles` entries whose keys no longer resolve.
- Do not prune ring styles on move, rotate, resize, color-only edits, or other non-topology changes.

## Ring Helper

Create/export a shared helper from `packages/layout-engine`.

Suggested API:

```ts
export interface NativeMoleculeRing {
  ringKey: string;
  atomIds: readonly string[];
  bondIds: readonly string[];
  center: LayoutPoint;
  points: readonly LayoutPoint[];
  area: number;
  pathD: string;
}

export function nativeMoleculeRings(object: MoleculeObject): NativeMoleculeRing[];
```

Implementation requirements:

- Build from the existing private `moleculeFillRingCycles()` logic rather than introducing a third ring algorithm.
- Keep ring geometry/key ownership in `layout-engine` per `AGENTS.md` section 5.26.
- `documentWorkflow`, `MainWindow`, and hit-testing import this helper; they must not copy ring math.
- Preserve current macrocycle and fused-ring behavior.
- Return one ring per fillable interior.
- Sort deterministically by existing cycle sort/key behavior.

## Rendering

Replace combined molecule fill path rendering with one fill path per ring.

Each ring fill path must:

- Render below bond lines and atom labels.
- Include `data-ring-key`.
- Include `data-molecule-fill-ring="true"` or equivalent stable test attribute.
- Use the resolved per-ring fill paint/color/opacity.
- Support per-ring visual effects only on the ring fill path.
- Preserve existing whole-molecule fill behavior as fallback when no per-ring style is present.

Anthracene/fused rings:

- Fused acene-style systems must render separate ring interior paths.
- A three-ring anthracene fixture should emit three distinct ring paths, each independently styleable.

Export:

- `exportDocumentToSvg` already uses `planPageSvgRender`; no new export pipeline is needed.
- Add SVG export tests proving `data-ring-key` paths and independent fills flow through.

## Selection And Hit Testing

Extend native molecule selection:

```ts
type NativeMoleculeSelectionPart =
  | existing atom/bond/parts variants
  | { objectId: string; kind: "ring"; ringKey: string; atomIds: readonly string[]; bondIds: readonly string[] };
```

Selection rules:

- Atom hit wins first.
- Bond hit wins second.
- Ring interior hit is tested only if no atom/bond hit wins.
- If multiple rings contain the point, choose smallest polygon area, then stable `ringKey`.
- Clicking outside atoms/bonds/rings keeps existing whole-object behavior.

Ring selection should carry `atomIds` and `bondIds` so existing fragment/parts helpers can be reused where appropriate. Fill targeting uses `ringKey`.

Selection chrome:

- Add a subtle ring interior selected overlay.
- Keep existing atom/bond/parts selection chrome unchanged.
- Lasso selection does not need ring selection in slice 1.

## Workflow And Commands

Follow existing value-encoded command conventions. Do not add generic `*.set` commands with hidden value params.

Add command factories similar to current color/effect command helpers:

```ts
moleculeRingFillColorCommandId(ringKey, color)
moleculeRingFillOpacityCommandId(ringKey, opacity)
moleculeRingEffectCommandId(ringKey, effectKind)
moleculeRingEffectColorCommandId(ringKey, effectKind, color)
moleculeRingEffectOpacityCommandId(ringKey, effectKind, opacity)
moleculeRingEffectSizeCommandId(ringKey, effectKind, size)
```

Add workflow helpers in `documentWorkflow`:

```ts
applyMoleculeRingFillColor(document, target, color)
applyMoleculeRingFillOpacity(document, target, opacity)
applyMoleculeRingEffect(document, target, effectKind)
applyMoleculeRingEffectColor(document, target, effectKind, color)
applyMoleculeRingEffectOpacity(document, target, effectKind, opacity)
applyMoleculeRingEffectSize(document, target, effectKind, size)
pruneMoleculeRingStyles(document, objectId)
```

Where target is:

```ts
{ objectId: string; ringKey: string }
```

Workflow requirements:

- Validate `objectId` is a molecule.
- Validate `ringKey` exists in `nativeMoleculeRings(object)`.
- Update only `style.ringStyles[ringKey]`.
- Return unchanged document for invalid target or no-op value.
- Preserve selection.
- Preserve atoms, bonds, bond order, charges, stereo display, chemistry metadata, and molecule geometry.

## Molecule Inspector Palette

Add a dedicated palette/toolset:

- Toolset ID: `core.moleculeInspector`
- Title: `Molecule Inspector`
- Default visible: `false`
- Default mode: `floating`
- Compact preferred window size.
- Toggle command: `view.toggleMoleculeInspector`

Be aware existing `view.toggleInspector` and disabled `tool.settings` exist. Do not create a third conceptual inspector path beyond this palette. If implementation touches those, route or leave them clearly inactive rather than overlapping.

UI pattern:

- Mirror `ArtToolbarStyleControls` architecture.
- Add `createMoleculeInspectorModel(...)`.
- Add `MoleculeInspectorStyleControls`.
- Gate through `showMoleculeInspectorControls={toolset.id === "core.moleculeInspector"}`.
- Use preview/commit/cancel semantics for color pickers/sliders so drag previews do not spam undo history.
- Reuse existing color picker/swatch/effect/slider styling patterns where practical.

Slice 1 UI content:

- Functional `Ring` section.
- Hint state when no ring is selected.
- Deferred tabs/sections may be visible as disabled placeholders only if compact and clearly unavailable:
  - Drawing
  - Atom Labels
  - Indicators
  - Bond advanced styling

Ring section controls:

- Fill color swatch/color picker.
- Fill opacity slider.
- Effect toggles: none, shadow, glow, sketch, if compatible with existing visual effect support.
- Optional compact ring identifier/status for QA, not prominent user copy.

## Tests

Model/helper tests:

- Benzene returns one ring.
- Naphthalene returns two rings.
- Anthracene returns three rings.
- Fused rings have distinct `ringKey` values.
- Ring keys are unchanged after object move/rotate/scale.
- Macrocycle fill behavior remains valid.

Workflow tests:

- Applying ring fill color changes only `style.ringStyles[ringKey]`.
- Applying ring opacity/effect updates only that ring entry.
- Invalid ring key returns unchanged document.
- Deleting a ring bond prunes stale `ringStyles`.
- Non-topology edits do not prune valid ring styles.
- Chemical identity fields are unchanged after every ring style command.

Rendering tests:

- Ring fills render as separate paths, not a combined path.
- Each path includes `data-ring-key`.
- Anthracene fixture renders three paths with three independent fills.
- Existing whole-molecule fill fallback still works.
- Bond lines and atom labels remain above ring fills.

Export tests:

- `exportDocumentToSvg` output contains three anthracene ring paths.
- Exported paths include `data-ring-key`.
- Exported fill colors/opacities match the canvas render plan.

DOM/UI tests:

- `Molecule Inspector` is hidden by default.
- `view.toggleMoleculeInspector` shows/hides it.
- No selected ring shows compact hint state.
- Selecting a ring shows Ring controls.
- Editing fill color through the palette updates the selected ring live.
- Clicking a ring interior selects `kind: "ring"`.
- Clicking an atom/bond within a ring still selects atom/bond first.

## Deferred Follow-Up Slices

Slice 2: appearance target and toolbar arbitration

- Resolve competing `Art` toolbar and `Molecule Inspector` behavior before adding more part-level appearance controls.
- Add a shared appearance-target resolver used by both palettes: whole object, selected ring(s), selected bond(s), selected atom label(s), and art objects.
- Whole-molecule selection in the `Art` toolbar edits the base molecule style and preserves existing `style.ringStyles` overrides.
- Ring selection in either toolbar routes through the same per-ring command/workflow helpers, so `Art` and `Molecule Inspector` agree.
- If whole-molecule styling is applied while per-ring overrides exist, show an explicit choice instead of silently clearing overrides:
  - keep ring overrides and edit only the base molecule style;
  - clear ring overrides and apply the style uniformly to the whole molecule;
  - cancel.
- Clearing per-ring overrides must be an intentional, undoable command. Do not make normal `Art` toolbar edits silently delete `style.ringStyles`.
- Keep the style model cascading rather than mutually exclusive: whole-molecule style is the base, per-ring/per-part styles are sparse overrides.
- Add DOM/workflow regressions proving ring overrides survive whole-molecule Art edits unless the explicit clear-overrides command is chosen.

Slice 3: per-bond advanced appearance

- Per-bond stroke width.
- Per-bond stroke opacity.
- Per-bond effects.
- Reuse `bond.display.bondStyle` for identity.
- Keep `style.bondColors` compatibility.

Slice 4: Drawing tab

- Chain angle.
- Fixed length.
- Bond spacing mode/value.
- Bold width.
- Line width.
- Margin width.
- Hash spacing.
- Display units.

Slice 5: Atom Labels tab

- Font family and size.
- Line spacing.
- Bold/italic/underline/outline/shadow.
- Baseline style.
- Alignment.
- Terminal carbon labels.
- Hide implicit hydrogens.

Slice 6: Indicators tab

- Atom query indicators.
- Atom stereochemistry.
- Enhanced stereochemistry.
- Atom numbers.
- Bond query indicators.
- Bond stereochemistry.
- Reaction indicators.

## Verification And Closeout

Run targeted tests for touched files, including:

```bash
pnpm vitest run packages/layout-engine/src/index.test.ts packages/export-engine/src/svg.test.ts apps/desktop/src/documentWorkflow.test.ts apps/desktop/src/App.test.ts
pnpm lint
git diff --check
```

If hit-testing or bridge-tested pointer behavior changes, also run the relevant DOM/agent bridge suites.

Update both required build stamps after implementation:

- `AGENTS.md`
- `apps/desktop/src/MainWindow.tsx`

Use the required format: `[month].[day].[hour].[minute]-[agent]`.
