# Agent Instructions for ChemDraft Structure Inspector Branch

**Current Build**: 7.4.9.27-opus

> [!IMPORTANT]
> When implementation work starts or a significant slice is finished, update this build stamp and the corresponding `Build` string in `apps/desktop/src/MainWindow.tsx`. Use `[month].[day].[hour].[minute]-[agent_name]`.

This branch is for the active Structure Inspector worktree: a dedicated Rings toolbar plus Molecule Inspector tabs for Structure, Atom Labels, and Templates.

- Worktree: `/Users/jeremiahgassensmith/Documents/programming/chemdraw-structure inspector`
- Branch: `codex/structure-inspector`
- Planning source: `PLANS.md`
- Current state: active implementation. The user has explicitly requested implementation of the Molecule Inspector tabs plan.

## Required Reading Before Coding

Before editing implementation files, read:

```text
PLANS.md
AGENTS.md
README.md
package.json
pnpm-workspace.yaml
```

If the work touches a package, also read that package's README or local documentation before editing.

## Active Slice Scope

Ship the compact hidden-by-default inspector palettes with:

- `core.ringInspector`: a Rings toolbar preserving existing ring identity, per-ring fill/effect rendering, ring interior hit-testing, and ring appearance controls.
- `core.moleculeInspector`: a Molecule Inspector with `Structure`, `Atom Labels`, and `Templates` tabs.
- `Structure`: molecule bond drawing controls for selected molecule targets. If one or more bonds or atoms are selected, Structure controls apply only to those parts through sparse per-bond / per-atom overrides, mirroring the Atom Labels behavior below.
- `Atom Labels`: base molecule atom-label typography, display policy, and font-family/face controls. If one or more atom labels are selected, Atom Labels controls must apply only to those labels through sparse per-atom overrides.
- `Templates`: import ChemDraw `.cds` style-sheet inputs through `packages/style-compat`, apply supported Molecule Inspector settings to selected molecule targets, and export ChemDraft Molecule Inspector presets as `.template` files.

Structure drawing controls (stroke and bold width, spacing, line caps, margins, hashing, overlap, chain angle, and indicator toggles) apply per bond and per atom via sparse maps when specific bonds/atoms are selected, and to the whole molecule otherwise.

Outside this slice:

- Per-bond fill opacity and per-bond visual effects (opacity and effects stay whole-molecule / ring-level through the Rings and Art inspectors).
- Atom-label underline, outline, and shadow.
- Font embedding, a font-management preference screen, general CDXML/CDX document import, clipboard, OCSR, or broad toolbar customization.

Do not add `NativeMoleculeDrawingSettings`, `NativeAtomLabelSettings`, or `NativeMoleculeIndicatorSettings`.

## Reuse Existing Systems

Verify existing code before adding new code.

- Whole-molecule fill/stroke color, paint type, opacity, none, and visual effects already apply to molecule objects through `documentWorkflow.ts` and `artInspectorModel.ts`. Reuse those paths where applicable.
- Per-bond color already exists through `applyColorToNativeMoleculePart`, writing `style.bondColors` and `style.atomLabelColors`.
- Per-bond style identity already lives on `bond.display.bondStyle`. Do not add a duplicate `style.bondStyles` map.
- The live inspector pattern already exists in `ArtToolbarStyleControls`. Mirror its model, payload, controls, and preview/commit/cancel behavior.
- Commands use value-encoded IDs and factory helpers. Do not introduce generic `*.set` commands with hidden value parameters.
- `exportDocumentToSvg` already reuses `planPageSvgRender`; per-ring render-plan paths should flow to export through that existing route.
- Use `MoleculeObject.style` and `nativeDrawingStyleFromObjectStyle()` for Structure and Atom Labels. Do not introduce a parallel molecule-style object.
- Keep Structure and Atom Labels state on the shared `NativeDrawingStyle` (never a parallel molecule-style object). Beyond reusing existing bond/label fields, this slice adds base bond-drawing fields (`chainAngleDegrees`, `bondBoldWidthPx`, `bondSpacingMode`, `bondSpacingPercent`, `bondMarginWidthPx`, `bondHashSpacingPx`), the atom/bond structure-indicator toggles (`atomIndicatorShow*`, `bondIndicatorShow*`), and the atom-label fields (`atomLabelFontStyle`, `atomLabelAlignment`, `atomLabelPlacement`, `atomLabelShowTerminalCarbons`, `atomLabelHideImplicitHydrogens`). Each is sparse-overridable per bond/atom via the `documentWorkflow.ts` maps and round-trips through templates/imports.
- The native system-font database already used by raster export must be shared with the Molecule Inspector font catalog; do not scan system fonts twice.

## Hard Boundaries

- Do not change the main checkout. Work only in this worktree for this branch.
- Do not copy proprietary assets, icons, dialog art, help text, sample files, command IDs, trade dress, or branded UI.
- Keep chemical identity stable. Ring styling must not mutate atoms, bonds, bond order, charges, stereochemistry, reactions, or molecule metadata.
- Ring geometry and key logic must live in `packages/layout-engine`; app code imports helpers and does not duplicate ring math.
- Ring appearance storage remains `style.ringStyles`, keyed by topology-derived ring keys.
- Ring keys must derive from sorted bond IDs, never coordinates.
- The Rings toolbar and Molecule Inspector must be hidden by default, compact, dense, and floating. Do not create a permanent right inspector or card/dashboard UI.
- Keep `core.ringInspector` / `view.toggleRingInspector` for ring appearance and `core.moleculeInspector` / `view.toggleMoleculeInspector` for Structure, Atom Labels, and Templates. Be aware that `view.toggleInspector` and disabled `tool.settings` already exist; do not add additional inspector concepts.
- Ring interiors are selectable only while the Rings toolbar is open.
- Keep chemical identity stable. Structure and Atom Label styling must not mutate atom elements, formal charges, bond orders, stereochemistry, atom IDs, bond IDs, or molecule identity.
- Sparse overrides must remain sparse and visually effective. Base style edits must not clear `style.ringStyles`, `style.bondColors`, `style.atomLabelColors`, sparse per-atom label style maps, or the sparse per-bond/per-atom Structure and indicator style maps.
- Target bond length must visibly scale selected molecule atom coordinates about each molecule's own center and update `style.bondLengthPx` in one undoable operation, or it must be removed from this slice.
- Structure indicators must be honest render overlays: atom numbers from atom order; atom/bond stereo from native wedge/hash/dashed display or imported stereo metadata; query indicators only from unknown/query atom or bond metadata; reaction indicators only from reaction/RXN metadata. Do not invent query or reaction chemistry for ordinary SMILES.

## Verification

Run focused suites for touched files, including:

```bash
pnpm vitest run packages/chem-core/src/styles.test.ts packages/layout-engine/src/index.test.ts packages/export-engine/src/svg.test.ts apps/desktop/src/moleculeInspectorModel.test.ts apps/desktop/src/commands.test.ts apps/desktop/src/documentWorkflow.test.ts apps/desktop/src/window-manager/index.test.ts apps/desktop/src/App.test.ts
pnpm lint
pnpm build
git diff --check
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

If hit-testing, pointer behavior, or the agent bridge changes, also run the relevant DOM/agent bridge/drawing-tool suites.

Manual stress must cover tab initialization, user tab persistence, mixed states, multi-molecule scaling, sparse override precedence, terminal carbon labels, hidden implicit hydrogens, explicit hydrogens, fonts, save/reopen, undo/redo, Spin 3D, atom-label editor placement, SVG export, and ring selection after tab switching/closing.

## Closeout Requirements

At implementation closeout:

- Update the build stamp in this file.
- Update the `Build` string in `apps/desktop/src/MainWindow.tsx`.
- Report tests run and any skipped verification.
- Keep the final answer focused on the branch and the specific slice completed.
