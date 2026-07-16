# ChemDraft Plans

## Runtime union merge (2026-07-16, branch `merge/plugin-union`)

The `codex/nmr-plugin` program (M1–M36: plugin runtime, NMR/mass analyzers, worker isolation,
packaging, installer, manager) merged into the trunk on this branch per ADR-0030: trunk = `main`,
plugin architecture = the plugin branch's, with main's four unique plugin pieces (stable command
registry, toolset-contribution stage, disk-backed plugin storage, patch-review tray) ported onto that
runtime and one unified panel renderer serving both the in-app surface and floating panel windows.
That program's full plan and milestone records live in the planning workspace
(`~/Documents/programming/Chemdraw-NMRplugin`) and in `PLANS.md` on the `codex/nmr-plugin` branch;
they are not duplicated here. Remaining plugin-separation work (publish the SDK, strip bundled NMR,
from-zero install test) is queued there as PLAN-plugin-separation Phases 2+.

The sections below are the trunk's active plan, unchanged by the merge.

# Rings Toolbar and Molecule Inspector Tabs

## Refactor/Toolbars Schema Update

The `refactor/toolbars` branch now has a schema-backed toolbar item contract in
`packages/toolset-registry` and `apps/desktop/src/toolsets/desktop-toolsets.json`.
Toolbar items explicitly carry `id`, `kind`, `label`, `primary`, `submenu`, `tooltip`,
and `layout` metadata, while preserving the legacy command-backed item shape through
normalization. The desktop palette now consumes normalized item models so manifest-defined
submenus, submenu column counts, and grid spans are available to both native palette
windows and the web fallback. Command-backed items still use real command IDs; commandless
control and separator items are legal for future toolbar customization work.

The durable schema notes live in:

- `docs/architecture/toolbars-and-toolsets.md`
- `packages/toolset-registry/README.md`

## Toolbar Stabilization Gate

Before starting the Rings Toolbar / Molecule Inspector delivery sequence, complete
one cleanup commit that stabilizes schema-backed toolbar button invocation, inline
submenu ARIA, generated tooltip descriptions, and branch docs. This gate must not
change Molecule Inspector behavior.

## Objective

Split ring appearance out of the Molecule Inspector. The existing hidden-by-default ring appearance work becomes its own compact `core.ringInspector` toolbar, while `core.moleculeInspector` remains hidden by default and contains three tabs:

1. `Structure`
2. `Atom Labels`
3. `Templates`

The slice is complete when users can select one or more molecule targets, inspect mixed values, edit base molecule drawing and atom-label appearance, edit only selected atom labels through sparse per-atom overrides, import ChemDraw `.cds` style-sheet inputs through the style compatibility boundary, export Molecule Inspector settings as `.template` files, undo and redo those edits as single operations, save and reopen them, and obtain matching canvas, Spin 3D, editor-overlay, and SVG output without changing chemical identity.

The existing Rings functionality remains operational throughout the work as its own toolbar. Ring interior selection is available only while the Rings toolbar is open.

## Completed Rings Slice

- Ring identity is topology-derived from sorted bond IDs and owned by `packages/layout-engine`.
- Per-ring fill/effect appearance is stored in `style.ringStyles`.
- Ring fills render below bonds and atom labels, flow through SVG export, and preserve whole-molecule fill fallback.
- Ring selection is gated by the Rings toolbar being open; atom hits beat bond hits, and bond hits beat ring-interior hits.
- Whole-molecule Art edits must not silently clear `style.ringStyles`.

## Preparation Before Implementation

Before implementation code, update:

- `PLANS.md`: this active implementation plan replaces the Rings-first plan.
- `AGENTS.md`: branch state is active implementation; scope is Rings, Structure, and Atom Labels; Structure and Atom Labels are no longer deferred.
- `apps/desktop/src/MainWindow.tsx`: update the `Build` string when implementation starts and again at closeout.

Preserve chemical-identity, sparse-override, shared-layout, command-ID, and verification constraints. Per-bond width, per-bond opacity, per-bond effects, label underline, label outline, and label shadow remain outside this slice.

## Existing Systems to Reuse

Do not introduce `NativeMoleculeDrawingSettings`, `NativeAtomLabelSettings`, or another parallel molecule-style object.

Continue using `MoleculeObject.style` and `nativeDrawingStyleFromObjectStyle()`.

Reuse existing style fields:

```ts
bondLengthPx
bondStrokeWidthPx
bondColor
bondLineCap
multipleBondGapPx
doubleBondInsetPx
bondOverlapClearancePx

atomLabelFontFamily
atomLabelFontSizePx
atomLabelFontWeight
atomLabelColor
atomLabelBackgroundColor
atomLabelPaddingPx
atomLabelBondClearancePx
```

Add only:

```ts
atomLabelFontStyle
atomLabelAlignment
atomLabelPlacement
atomLabelShowTerminalCarbons
atomLabelHideImplicitHydrogens
```

Continue using:

- `style.ringStyles` for per-ring appearance.
- `style.bondColors` for per-bond color overrides.
- `style.atomLabelColors` for per-atom label color overrides.
- Sparse per-atom atom-label style maps for selected atom-label edits.
- `bond.display.bondStyle` for per-bond style identity.
- Existing Art-control preview, commit, and cancel patterns.
- `planPageSvgRender` as the shared SVG planning route.
- The cached native system-font database already used by raster export.

No document schema-version increment is required merely for these style metadata keys. Old documents resolve new fields through defaults.

## Explicit Non-Goals

This slice does not include:

- Per-bond stroke width.
- Per-bond opacity.
- Per-bond effects.
- Label underline, outline, or shadow.
- Font embedding in native documents or SVG.
- A font-management preference screen.
- Modification of atom elements, formal charges, bond orders, stereochemistry, atom IDs, bond IDs, or molecule identity.
- Replacing the existing ring-detection or ring-key algorithm.
- Clearing sparse overrides as a side effect of base-style editing.

The Structure tab's existing indicator controls are in scope as render overlays. They must be driven by existing native or compatibility metadata only:

- Atom numbers come from stable atom order.
- Atom and bond stereochemistry indicators come from wedge/hash/dashed display or imported stereo metadata.
- Query indicators appear only for native unknown/query atoms or bonds, R-group query anchors, or explicit compatibility metadata.
- Reaction indicators appear only for reaction/RXN compatibility metadata.
- Ordinary SMILES must not receive fake query or reaction annotations.

## Delivery Sequence

Implement as three independently testable commits. Documentation changes may be committed separately or included in the first implementation commit, but must happen before code changes begin.

### Commit 1: Inspector Targets, Tabs, and Structure

Files:

- `apps/desktop/src/moleculeInspectorModel.ts`
- `apps/desktop/src/moleculeInspectorModel.test.ts`
- `apps/desktop/src/artInspectorModel.ts`
- `apps/desktop/src/MainWindow.tsx`
- `apps/desktop/src/ToolPalette.tsx`
- `apps/desktop/src/App.css`
- `apps/desktop/src/PaletteWindow.tsx`
- `apps/desktop/src/window-manager/index.ts`
- `apps/desktop/src/toolsets/desktop-toolsets.json`
- relevant command, workflow, UI, and palette transport tests

Replace the flat ring-only model with nested tab models:

```ts
export type MoleculeInspectorTabId = "structure" | "atom-labels";
export type MoleculeInspectorContext = "none" | "molecule" | "ring" | "bond" | "atom";

export interface MoleculeInspectorTargets {
  moleculeObjectIds: readonly string[];
  ringTargets: readonly MoleculeInspectorRingSelection[];
  context: MoleculeInspectorContext;
}

export interface MoleculeInspectorModel {
  targets: MoleculeInspectorTargets;
  suggestedTab: MoleculeInspectorTabId;
  rings: MoleculeInspectorRingsModel;
  structure: MoleculeInspectorStructureModel;
  atomLabels: MoleculeInspectorAtomLabelsModel;
}
```

The target resolver must include selected molecule objects, include the parent molecule for selected atoms/bonds/rings, dedupe by molecule ID, ignore selected non-molecules, return molecule IDs in stable document order, keep ring targets separate, and validate ring keys against `nativeMoleculeRings(object)`.

Suggested tab:

- `ring` -> `rings`
- `atom` -> `atom-labels`
- `bond`, `molecule`, `none` -> `structure`

Mixed-value resolution must use `nativeDrawingStyleFromObjectStyle(object.style)`. A field is mixed only when at least two targeted molecules have non-equal resolved values. Mixed fields return `{ value: null, mixed: true }`.

For `bondLengthPx`, the model shows the representative bond length used by the scaling workflow, not merely stale metadata. A molecule with no usable bonds falls back to resolved `style.bondLengthPx`.

Structure controls:

| Control | Style key | UI | Limits |
| --- | --- | --- | --- |
| Target bond length | `bondLengthPx` | numeric field plus slider | 8-120 px, step 0.5 |
| Stroke width | `bondStrokeWidthPx` | numeric field plus slider | 0.25-12 px, step 0.25 |
| Bond color | `bondColor` | swatch and color picker | normalized CSS hex |
| Line cap | `bondLineCap` | select | butt, round, square |
| Multiple-bond gap | `multipleBondGapPx` | numeric field plus slider | 0.5-24 px, step 0.25 |
| Double-bond inset | `doubleBondInsetPx` | numeric field plus slider | 0-24 px, step 0.25 |
| Overlap clearance | `bondOverlapClearancePx` | numeric field plus slider | 0-32 px, step 0.5 |

Keep range definitions in one exported module or in `commands.ts`; UI, parser, and tests consume the same bounds.

Add explicit Structure command factory/parser pairs:

```text
molecule.structure.bondLength:<number>
molecule.structure.bondStrokeWidth:<number>
molecule.structure.bondColor:<normalized-color>
molecule.structure.bondLineCap:<butt|round|square>
molecule.structure.multipleBondGap:<number>
molecule.structure.doubleBondInset:<number>
molecule.structure.overlapClearance:<number>
```

Numbers must be finite, in range, canonicalized to at most three decimals, and reject malformed suffixes. Colors reuse existing normalization and reject `"none"`. Enums require exact allowed values.

Add:

```ts
applyMoleculeBaseStylePatch(document, moleculeObjectIds, patch): ChemDraftDocument
applyMoleculeTargetBondLength(document, moleculeObjectIds, targetBondLengthPx): ChemDraftDocument
```

`applyMoleculeBaseStylePatch` dedupes IDs, ignores invalid and non-molecule targets, preserves page order and selection, shallow-copies only affected molecule styles, preserves unknown metadata and sparse maps, returns the original document for no-ops, and does not materialize defaults.

`applyMoleculeTargetBondLength` is not a style-only patch. It calculates each molecule's representative median valid 2D bond length, prefers heavy-atom bonds, scales atom `x` and `y` plus explicit `atom.labelOffset` around that molecule's center, updates `style.bondLengthPx`, preserves atom/bond IDs and display objects, keeps `z`, does not prune ring styles, and returns the original document for no-ops. If safe scaling cannot be preserved, remove Target bond length from this slice.

The Molecule Inspector UI must use a left-side vertical tablist with proper ARIA, keyboard navigation, local active-tab state, session initialization from `model.suggestedTab`, and preview cancellation when tabs/targets/close state change. Tabs remain selectable with no targets; panel controls disable instead.

Native `PaletteWindow` preview/commit/cancel must use a dedicated Molecule Inspector interaction event, not ordinary committed command routing. Preview and commit remain distinguishable even when command IDs match, cancel carries no command ID, and DOM fallback and Tauri transport behave the same.

### Commit 2: Atom Label Style and Display Policy

Files:

- `packages/chem-core/src/styles.ts`
- `packages/chem-core/src/index.ts`
- `packages/chem-core/src/styles.test.ts`
- `packages/layout-engine/src/index.ts`
- `packages/layout-engine/src/index.test.ts`
- `packages/export-engine/src/svg.test.ts`
- `apps/desktop/src/documentWorkflow.ts`
- `apps/desktop/src/ToolPalette.tsx`
- `apps/desktop/src/MainWindow.tsx`
- relevant render and workflow tests

Add:

```ts
export type NativeAtomLabelAlignment = "automatic" | "left" | "center" | "right";
export type NativeAtomLabelPlacement = "automatic" | "above" | "below";
```

Extend `NativeDrawingStyle` with:

```ts
atomLabelFontStyle: NativeTextFontStyle;
atomLabelAlignment: NativeAtomLabelAlignment;
atomLabelPlacement: NativeAtomLabelPlacement;
atomLabelShowTerminalCarbons: boolean;
atomLabelHideImplicitHydrogens: boolean;
```

Defaults:

```ts
atomLabelFontStyle: "normal";
atomLabelAlignment: "automatic";
atomLabelPlacement: "automatic";
atomLabelShowTerminalCarbons: false;
atomLabelHideImplicitHydrogens: false;
```

Atom Label controls:

| Control | Style key | UI | Limits |
| --- | --- | --- | --- |
| Font family | `atomLabelFontFamily` | searchable select/editable combo | validated nonempty string |
| Font face | weight + style | select | catalog/default faces |
| Size | `atomLabelFontSizePx` | numeric field plus slider | 6-96 px, step 0.5 |
| Label color | `atomLabelColor` | swatch/color picker | normalized hex |
| Background | `atomLabelBackgroundColor` | Transparent/Solid plus swatch | transparent or normalized hex |
| Padding | `atomLabelPaddingPx` | numeric field plus slider | 0-16 px, step 0.25 |
| Bond clearance | `atomLabelBondClearancePx` | numeric field plus slider | 0-32 px, step 0.5 |
| Alignment | `atomLabelAlignment` | select/segmented control | automatic, left, center, right |
| Placement | `atomLabelPlacement` | select | automatic, above, below |
| Terminal carbon labels | boolean | checkbox | explicit true/false |
| Hide implicit hydrogens | boolean | checkbox | explicit true/false |

Transparent background stores `atomLabelBackgroundColor: "transparent"`, omits the fill rectangle, and still uses padded bounds and bond clearance.

Add explicit Atom Label command factory/parser pairs:

```text
molecule.atomLabel.fontFamily:<uri-encoded-family>
molecule.atomLabel.fontFace:<weight>:<normal|italic>
molecule.atomLabel.fontSize:<number>
molecule.atomLabel.color:<normalized-color>
molecule.atomLabel.backgroundColor:<normalized-color|transparent>
molecule.atomLabel.padding:<number>
molecule.atomLabel.bondClearance:<number>
molecule.atomLabel.alignment:<automatic|left|center|right>
molecule.atomLabel.placement:<automatic|above|below>
molecule.atomLabel.showTerminalCarbons:<true|false>
molecule.atomLabel.hideImplicitHydrogens:<true|false>
```

Boolean commands require literal lowercase `true` or `false`; no toggle commands.

Create shared atom-label semantic and geometry planning in `packages/layout-engine`. Visibility precedence:

1. Required by chemistry remains visible.
2. `atom.labelVisible === true` makes optional carbon visible.
3. `atom.labelVisible === false` hides optional carbon but cannot erase required chemistry.
4. Terminal-carbon setting applies.
5. Otherwise skeletal carbon is hidden.

Terminal carbon means carbon with exactly one neighboring non-hydrogen atom, not an isolated carbon. Hidden implicit hydrogens removes generated hydrogen runs only; explicit hydrogen atoms remain visible. `atom.labelOffset` wins over automatic placement.

Effective color precedence:

```ts
style.bondColors?.[bondId] ?? style.bondColor ?? defaultStyle.bondColor
style.atomLabelColors?.[atomId] ?? style.atomLabelColor ?? defaultStyle.atomLabelColor
```

Canvas, Spin 3D, atom-label editor overlay, and SVG export consume shared plans for visibility, runs, typography, bounds, background, placement, and bond exclusion. Font weight/style affect conservative label bounds.

### Commit 3: Shared Font Catalog

Files:

- `apps/desktop/src-tauri/src/fonts.rs`
- `apps/desktop/src-tauri/src/export.rs`
- `apps/desktop/src-tauri/src/lib.rs`
- `apps/desktop/src/systemFonts.ts`
- `apps/desktop/src/systemFonts.test.ts`
- `apps/desktop/src/ToolPalette.tsx`
- Rust tests

Move cached font database ownership out of `export.rs`:

```rust
pub(crate) fn shared_fontdb() -> Arc<usvg::fontdb::Database>;
```

Use one process-wide `OnceLock<Arc<usvg::fontdb::Database>>`. Both raster export and `list_system_fonts` use it; no second `load_system_fonts()` scan.

Expose:

```rust
#[tauri::command]
pub(crate) async fn list_system_fonts() -> Result<Vec<SystemFontFamily>, String>
```

Return only:

```ts
interface SystemFontFamily {
  family: string;
  faces: Array<{ weight: number; style: "normal" | "italic" }>;
}
```

Never return paths, file names, face indices, or PostScript identifiers. Deduplicate by `(family, weight, style)`, sort faces and families deterministically, map oblique to italic, and run initial scan in Tauri's blocking task facility.

Frontend font loading:

- Load only when Atom Labels becomes active.
- Cache the promise.
- Validate native data.
- Fall back in web/tests or on malformed native data.
- Include fallback families plus the currently stored family.
- Preserve unavailable stored families through UI, save/reopen, SVG, and raster export.

Family selection writes only `atomLabelFontFamily`. Face selection writes one `fontFace` command that updates weight and style atomically.

## Testing Matrix

Model tests cover no selection, molecule/multi-molecule selections, parent atom/bond/ring targets, invalid/deleted targets, non-molecule ignored, document-order targets, suggested tabs, uniform/mixed Structure and Atom Label values, atomic font-face comparison, and defaults.

Command tests cover valid round trips, min/max values, below/above range rejection, malformed numbers, canonical decimals, enum validity, URI font family parsing, font face parsing, and boolean parsing.

Workflow tests cover every base-style field, multi-molecule updates, invalid targets, no-ops, selection preservation, unchanged atom/bond arrays, sparse map preservation, chemical identity stability, atomic font-face patches, target bond-length scaling, and visible sparse override precedence.

UI tests cover Molecule Inspector tab order and ARIA, keyboard navigation, suggested initial tabs, user tab persistence, close/reopen reset, disabled no-target panels, dedicated Rings toolbar regressions, mixed placeholders, indeterminate checkboxes, preview cancellation, one undo for drags, numeric Enter/Escape behavior, font catalog lazy loading, unavailable current fonts, native palette interaction round trips, and color-picker open sizing.

Layout/render/export/save tests cover default automatic layout, forced alignment and placement, explicit label offsets, transparent backgrounds, padding/clearance, bold/italic bounds, terminal carbon rules, hidden implicit hydrogens, explicit hydrogens, heteroatoms, charged carbons, per-atom/per-bond color precedence, SVG attributes, unknown font families, serialization round trips, and old-document defaults.

Regression tests cover closed/open Rings toolbar ring-interior hit-testing, Structure and Atom Labels staying separate from ring appearance controls, hit priority, ring commands editing only `style.ringStyles`, existing Art toolbar molecule behavior, whole-molecule fill fallback, and ring undo/redo.

## Manual Stress Pass

Run these in the real browser/app surface:

1. Open the Rings toolbar, select a ring, and confirm the ring controls target that ring.
2. Open Molecule Inspector and confirm it offers only Structure and Atom Labels.
3. Close/reopen Molecule Inspector with a selected atom and confirm Atom Labels initializes.
4. Select two molecules with different stroke widths and verify mixed state.
5. Set stroke width and undo once.
6. Change Target bond length for two differently scaled molecules and confirm independent centers.
7. Apply base bond color with one bond override and confirm override remains visible.
8. Apply base atom-label color with one atom override and confirm override remains visible.
9. Show terminal carbon labels, hide implicit hydrogens, and confirm explicit hydrogens remain.
10. Change family and face, including unavailable/current family preservation.
11. Save/reopen; undo/redo font, color, toggle, and geometry changes.
12. Compare Spin 3D label behavior and atom-label editor placement.
13. Export SVG and inspect labels, colors, and font attributes.
14. Reconfirm ring interior selection after tab switching and after inspector close.

## Verification and Closeout

Run focused suites for every touched area:

```bash
pnpm vitest run \
  packages/chem-core/src/styles.test.ts \
  packages/layout-engine/src/index.test.ts \
  packages/export-engine/src/svg.test.ts \
  apps/desktop/src/moleculeInspectorModel.test.ts \
  apps/desktop/src/commands.test.ts \
  apps/desktop/src/documentWorkflow.test.ts \
  apps/desktop/src/window-manager/index.test.ts \
  apps/desktop/src/App.test.ts
```

Adjust paths only where the repository already has an equivalent focused test file.

Then run:

```bash
pnpm lint
pnpm build
git diff --check
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Run additional agent-bridge, hit-test, and drawing-tool suites because ring hit-testing and palette interaction remain part of this slice.

Definition of done:

- `AGENTS.md` and `PLANS.md` describe the active slice accurately.
- Rings, Structure, and Atom Labels all work in one palette.
- Multi-molecule targeting and mixed values work.
- Target bond length has visible, tested semantics or is explicitly removed.
- Sparse overrides remain present and visually effective.
- All label surfaces consume shared semantic and layout planning.
- Font catalog shares the raster-export database.
- Native and in-document palette interactions preserve preview semantics.
- Save/reopen and SVG export preserve new styles.
- Chemical identity tests remain unchanged.
- Required tests, lint, build, Rust tests, formatting checks, and `git diff --check` pass.
- Build stamps are updated in `AGENTS.md` and `apps/desktop/src/MainWindow.tsx`.
