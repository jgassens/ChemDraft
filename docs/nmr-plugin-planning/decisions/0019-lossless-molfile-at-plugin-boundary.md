# ADR-0019: Plugins receive a lossless molfile at the selection boundary, not the app's hand-rolled SMILES

- **Status:** accepted (2026-07-09) — user-reported correctness bug ("naphthalene compounds consistently become straight chains")
- **Relates to:** [[0008-extend-existing-selection-api]] (the selection bridge), [[0014-nmrshiftdb2-data-source]] / [[0017-h1-coupling-and-full-corpus]] (the predictor that consumes structure)

## Context

The NMR plugin predicted the **wrong molecule** for anything with a fused/polycyclic ring
system: a hand-drawn naphthalene + isopropyl came back as the spectrum of **tridecane, a straight
13-carbon alkane** (6 aliphatic resonances, 0.88–1.30 ppm, no aromatics).

Root cause is the app's `nativeSingleBondGraphSmiles` (in `documentWorkflow.ts`) — a hand-rolled
SMILES writer that only linearizes two graph shapes: a single ring-with-branches, and a tree
(forest). Anything else (**two or more fused rings**) falls through to a last-resort branch that just
concatenates every atom symbol:

```ts
if (!isForestGraph(atoms, bonds, components)) {
  return atoms.map((atom) => nativeAtomSmiles(atom)).join("");
}
```

In SMILES, adjacent characters are implicitly bonded, so a 10-carbon naphthalene becomes
`CCCCCCCCCC` — which OCL reads as **decane**. Every ring closure and bond order is lost. The
selection bridge (`selectionSnapshot.ts`) forwarded that string to the plugin verbatim, so the
predictor was faithfully predicting a straight chain. (Reproduced end-to-end: molfile `C10H8`,
10 aromatic atoms → `[7.40, 7.48, 7.80]`; the lossy SMILES `C10H22`, 0 aromatic → `[0.88 … 1.30]`.)

Single rings mostly survived (the single-ring path emits Kekulé `C1=CC=CC=C1`, which OCL
aromatizes), which is why the failure looked topology-specific.

## Decision

**The plugin selection boundary hands plugins a lossless V2000 molfile built from the molecule's
own atom/bond graph, not a re-serialized SMILES.** A molecule the editor has parsed into
`atoms`/`bonds` is the source of truth; we serialize that graph directly to a connection table and
let the plugin's OCL do ring/aromaticity perception.

- `selectionSnapshot.ts` gains `pluginFacingStructure(molecule)`: if `atoms.length > 0`, emit
  `moleculeToMolfileV2000(molecule, { fromDocFrame: true })` as `molfile-v2000`; otherwise pass the
  object's existing `structure`/`structureFormat` through (e.g. a molecule imported as SMILES that
  was never parsed into a graph). Writer-limit throws (>999 atoms) fall back to passthrough rather
  than dropping the molecule.
- The staleness **fingerprint stays keyed on the object's own coordinate-free `structure` string**,
  not the emitted molfile, so a pure move never reads as a content change.

Why molfile and not "fix the SMILES writer": the app deliberately keeps **OpenChemLib out of the
main bundle** (it lives only in the prediction worker). A molfile is a plain fixed-column connection
table — pure string formatting, no OCL, no ring perception on our side — so it is both correct and
bundle-cheap. `moleculeToMolfileV2000` already exists (`@chemdraft/chem-core`, used by the 3D-spin
pipeline) and is proven against OCL + RDKit. The predictor already accepts `molfile-v2000`
(`normalizeStructure` → `OCL.Molecule.fromMolfile`), so this is a boundary change only.

## Consequences

- Fused/polycyclic structures now predict correctly (naphthalene → aromatic ~7.4–7.8 ppm). What the
  plugin analyzes is exactly the graph the user drew; OCL does canonical perception once, well.
- Adds `moleculeToMolfileV2000` to the desktop main chunk — negligible (string formatting, type-only
  imports; **no OCL**), so the main-bundle-lean invariant (ADR-0014/M10) holds.
- Narrow regression accepted: an imported molfile-v3000 carrying features the native model can't hold
  (isotopes/radicals) is re-emitted from the live graph and loses them — but the app can't display or
  edit those anyway, so the prediction now matches what is on screen.

**Deeper issue left standing (out of scope here):** `nativeSingleBondGraphSmiles` is still lossy for
the app's *own* `object.structure` field (copy-as-SMILES, round-trips). A proper general SMILES
writer (DFS spanning tree + ring-closure digits) would fix that at the source. Filed as a follow-up;
this ADR fixes the plugin-facing path, which is what was broken for the user.
