# @chemdraft/document-workflow-core

The pure document-building functions that both the desktop app and the headless CLI
(`packages/chemdraft-cli`, and through it `packages/chemdraft-mcp`) need: turning a SMILES depiction
or molfile into a native molecule object, scaling a molecule to a target bond length, sizing and
inserting text objects and reaction arrows, atom validation and valence rules, and the native SMILES
writer.

It exists because the CLI used to import `apps/desktop/src/documentWorkflow.ts` by relative path.
That file is ~20,000 lines and also carries desktop-only code, so any desktop-only import added to it
broke every headless command. The code here was **moved** out of `documentWorkflow.ts` and
`moleculeSmiles.ts` without behaviour change; both desktop files re-export every moved name, so
desktop importers did not change.

| File | Holds |
|---|---|
| `drawingDefaults.ts` | Field-by-field document drawing/text defaults for newly inserted objects, falling back to the hand-drawing preset |
| `molecule.ts` | SMILES/molfile depiction → native molecule, target bond length, double-bond sides |
| `documentStyle.ts` | Scale the whole first page uniformly using layout-engine geometry, including pixel style overrides; preserve colours and appearance toggles and apply fixed molecule size keys |
| `documentInventory.ts` | Native atom/bond ids and page geometry, with rings from layout-engine |
| `textObjects.ts` | Text object sizing, creation, insertion |
| `reactionArrows.ts` | Reaction arrow creation and insertion |
| `reactionScheme.ts` | Pure placement of pre-depicted reaction components, plus signs, arrow, and label blocks |
| `reactionLabels.ts` | Shared reaction-label lines, whitespace wrapping, formula spans, measured blocks, arrow length, clearances, and caption placement |
| `gridLayout.ts` | Pure placement of pre-depicted molecules and optional labels in a grid |
| `atoms.ts` | Valence and charge rules, atom validation, formula metadata, and what is built on a label's reading: each group's verdict and free valence, and the recorded bond side. Re-exports layout-engine's element table, bond-order counting and atom-label grammar (`nativeAtomLabelReading`), under the same names |
| `labelGroups.ts` | A group's expansion into real atoms appended after the drawn ones, so drawn indices never move. The formula, SMILES, molfile and analysis read that expansion; the document keeps the label. The group's shape and attachment atom (`NativeLabelGroup`, `nativeLabelGroupAttachment`) are layout-engine's, re-exported |
| `labelOnBondedAtom.ts` | Commit-time relabel/substituent decision using the original atom, shared label readings and valence admission |
| `smiles.ts` | The native SMILES writer; aromatic bonds are kekulized by layout-engine's `nativeBondOrderResolution` |
| `moleculeSmiles.ts` | Export-time SMILES: RDKit when the caller supplies it, native writer otherwise |
| `graph.ts` | Graph walks over native atoms and bonds, including the longest path the SMILES writer and 2D cleanup lay a component along |
| `shared.ts` | Ids, page access, numeric helpers |
| `testing.ts` | Test-only hooks, served as `@chemdraft/document-workflow-core/testing` and kept out of the barrel: the longest-path work counter |

## What belongs here

- Pure functions from document data to document data (`ChemDraftDocument` in, `ChemDraftDocument` out),
  built on `chem-core` patches.
- Chemistry bookkeeping those functions need: element tables, valence, the native SMILES writer.
- Dependencies limited to `chem-core`, `layout-engine`, `clipboard-adapter` (molfile parsing),
  `template-library` (the abbreviation table: data only), and type-only use of `export-engine`
  and `rdkit-adapter`.

## What does not

- **No UI.** No React, no components, no hooks.
- **No Tauri.** Nothing from `@tauri-apps/*`, no native commands, no filesystem.
- **No DOM.** No `window`, `document`, canvas, or text measurement at call time.
- **No app state.** No selection, viewport, undo stack, tool mode, or preferences. Callers pass in
  what a function needs.
- **No plugin loading.** Nothing from `plugin-host` or `plugin-api`, and nothing from `engine3d-api`.
- **No engine loading.** `moleculeSmiles` takes RDKit's `computeStructureIdentifiers` as an argument;
  how the engine is loaded (the desktop's Vite WASM URL, the CLI's Node loader) stays with the caller.
- **No copied rendering math.** Bond, label, and stroke geometry belongs to `layout-engine`
  (AGENTS.md §5.26); import it from there, and add an `export` in `layout-engine` if a helper is
  internal.
- **No second copy of bond-order counting.** The element table, `nativeElementFromAtomLabel`,
  `nativeBondOrderValue`, `nativeAtomBondOrderUsage`, `atomBondOrderUsageMap`, the kekulizer, and the
  `clamp`/`distance` helpers live in `layout-engine` and are re-exported here under the same names.
  Two copies once disagreed about aromatic bonds (1 here, 1.5 there): benzene stored C6H12 while
  pyrrole's N–H drew as a bare N.

`src/boundary.test.ts` fails if any file here imports from `apps/`, React, Tauri, or the plugin and
3D runtimes. `packages/chemdraft-cli/src/importBoundary.test.ts` fails if the CLI or MCP server
imports from `apps/` again.

`applyDocumentStyle` uses each first-page molecule’s median bond length to scale the whole page
(objects, atoms, arrows/control points, graphics, captions and page size) to 22 native units per
bond. If molecule medians differ by more than 2%, it uses their median and emits a warning naming
that value, preserving relative geometry rather than normalizing molecules separately. Later pages
remain unchanged. Arrows and graphics without authored strokes use the fixed document line width
(1.134 pt); authored graphic strokes scale with the page, and image styles remain unchanged.
Text defaults to Arial, Helvetica, sans-serif at 10 pt. Explicit object/span font sizes scale with
the page. Only whole-molecule size/geometry style keys are replaced; other styling is preserved.

`layoutGrid` and `layoutReactionScheme` accept `style: "fit" | "document"` (default `"fit"`)
and an optional `textStyle` override. Document style applies `DocumentTextStyle` to grid labels,
reaction conditions and plus signs; measurements and placement use the same resolved text style.
Grid cells in document style accommodate the wider of the molecule or label, and the custom page
fits all rows and columns with margins given by the anchor. Reaction pages fit the complete scheme;
above/below block width sets arrow length and plus-sign width sets component spacing.
Callers supply pre-depicted molecules at the intended bond length. Reaction schemes preserve the
anchor when it leaves room for page padding, otherwise translating the whole scheme together.
These layout functions translate molecules without
rescaling them; CLI option parsing, cropping, physical SVG units and PNG DPI stay with the caller.

Reaction schemes accept `above` and `below` arrays (each entry is a deliberate line, including any
explicit newlines) and an optional `caption`. Blank lines are discarded. `conditionText` remains a
compatibility adapter: its newline-separated lines precede `above`, with no comma/semicolon guessing.
Each block has explicit rendered
newlines and formula spans, measured once without implicit wrapping. Captions are not formula-formatted; mechanism names such as SN2 are never subscripted.
Entirely numbered authored blocks
align left with their visible text centred on the arrow, including wrapped steps; other blocks and captions align centre.

Reaction-label design numbers live together in `src/reactionLabels.ts`: line wrap at **10 bond
lengths**, minimum arrow **2.5 bond lengths**, total arrow padding beyond the widest block **0.5 bond
lengths**, label line-box clearance from the visible arrow **0.35 em**, caption top clearance
**0.8 em**, caption wrap width at least **8 bond lengths**, and default label font **14 px** centred.
Spaces and tabs are the only wrap points; NBSP/narrow NBSP and oversized tokens stay whole. Captions wrap to the greater of
scheme width and that minimum. A line box includes authored paragraph spacing to match rendering.
`src/textObjects.ts` reuses the renderer's **72%** script font size and existing sizing conventions:
**6 px** horizontal / **4 px** vertical padding, minimum box **36 × 24 px**, dimensions rounded to
**0.01 px**. Padding follows the line box vertically, matching the renderer's baseline origin.
`layout-engine/src/index.ts` derives visible arrow extents from `planReactionArrowGeometry`, including
the existing default **1.5 px** shaft stroke shared with rendering; it adds no per-kind label offsets.

`documentDrawingDefaults(document)` resolves `document.styles.drawing` and `document.styles.text`
without changing existing objects. New native and SMILES molecules share its geometry and style;
captions default to the atom-label font (15 px Arial). Explicit sizing callers such as the CLI can
override `createSmilesMolecule`/`insertSmilesMolecule` options without changing canvas defaults.
