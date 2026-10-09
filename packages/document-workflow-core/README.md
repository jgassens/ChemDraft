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
| `molecule.ts` | SMILES/molfile depiction → native molecule, target bond length, double-bond sides |
| `documentInventory.ts` | Native atom/bond ids and page geometry, with rings from layout-engine |
| `textObjects.ts` | Text object sizing, creation, insertion |
| `reactionArrows.ts` | Reaction arrow creation and insertion |
| `atoms.ts` | Valence and charge rules, atom validation, formula metadata; re-exports layout-engine's element table and bond-order counting |
| `smiles.ts` | The native SMILES writer; aromatic bonds are kekulized by layout-engine's `nativeBondOrderResolution` |
| `moleculeSmiles.ts` | Export-time SMILES: RDKit when the caller supplies it, native writer otherwise |
| `graph.ts` | Graph walks over native atoms and bonds |
| `shared.ts` | Ids, page access, numeric helpers |

## What belongs here

- Pure functions from document data to document data (`ChemDraftDocument` in, `ChemDraftDocument` out),
  built on `chem-core` patches.
- Chemistry bookkeeping those functions need: element tables, valence, the native SMILES writer.
- Dependencies limited to `chem-core`, `layout-engine`, `clipboard-adapter` (molfile parsing),
  and type-only use of `export-engine` and `rdkit-adapter`.

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
