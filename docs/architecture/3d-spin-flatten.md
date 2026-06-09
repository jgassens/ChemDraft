# Roadmap: 3D Spin → Flatten Perspective Tool

**Status:** Phase 1C engine-free core complete. Phases 1A (layered identity service),
1B (`flattenPerspectiveFrom3D` constrained-search wedging), and the engine-free part
of 1C (labeled corpus runner + oracle non-mutation barrier) are on `feature/3d-spin`.
The live RDKit chemistry oracle is deferred until RDKit is available (Phase 2). Next
runnable-without-clicks slice: Phase 3 (pure rotation math). Architecture decided:
**built into the app, behind the `chemistry-adapter` seam** — not a plugin. Engine
front-runner: **OpenChemLib JS**,
gated by a labeled validation corpus + atom-mapping proof + real bundle-cost
measurement. (Revised twice after external review — wedging is a constrained search;
identity is a mandatory layered service; phases front-load safety before UI.)

## Context

A user draws a flat structure, clicks "Generate 3D", **spins the conformer on the
canvas** to a viewing angle, releases, and the result is **flattened to a 2D
perspective drawing** (chairs, bulky ligands at an angle).

- **3D is transient.** Conformer + spin pose are never serialized; the saved
  document stays 2D. Do **not** add `z` to `MoleculeAtom`. This is a 2D drawing
  aid, not a 3D viewer (overrides `PLAN.md:133`).
- **Two features, perspective first.** Perspective depiction now (a *picture*;
  re-editing is lossy). Clean 2D re-layout later (3D intermediate → regenerate tidy
  2D via CoordGen/Indigo; editable; no Z drop; no spin).
- **Pairs with the over/under crossing model** (`docs/architecture/over-under-crossing-model.md`,
  implemented through Phase D). The spin's depth authors front/back at bond
  crossings, not just wedges — and 3D-spin→flatten is the natural authoring tool for
  the model's northstar (the rotaxane weave). See the crossings section below.

## Architecture decision: in-app, behind the adapter seam

```
CORE (in the app) — not plugin-reachable:
  • "molecule-spin-3d" DragKind + live 3D overlay     (interaction machine + renderer)
  • flatten transform: constrained-search wedging + stereo commit guard
  • structure.spin3d command
  • chemistry-adapter: generate3DConformer + layered identity snapshot/diff
  • DEFAULT engine = lazy-loaded core adapter (OpenChemLib)

PLUGIN / NATIVE-SERVICE boundary — reserved, same contract:
  • native RDKit sidecar (high-fidelity/later; dev oracle; needs native.execute)
  • OpenBabel            (GPL — isolation mandatory)
  • sci-form/experimental(risk containment)
```

UX is core (canvas drag + overlay + in-place commit aren't plugin-reachable; the
owner's vision is in-canvas). Engine is a lazy core adapter (OCL is BSD-3, pure-JS,
light — plugin ceremony adds nothing). Isolation boundary reserved for native/GPL/
experimental engines, all on the same contract.

## Phase 0 findings (spike complete, 2026-06-06)

**Published RDKit WASM is 2D-only** (`@rdkit/rdkit@2025.3.4`: 56 JSMol methods, zero
embed/conformer/MMFF/UFF; molblock header `"2D"`; max |z| = 0 — verified type defs
AND runtime). "Core adapter via stock RDKit WASM" is dead for 3D.

| Engine | License | Form | 3D capability | Verdict |
|---|---|---|---|---|
| **OpenChemLib JS** `9.22.1` | **BSD-3** | pure-JS, raw dist ~1.1 MB, no SAB/native | `ConformerGenerator` + `ForceFieldMMFF94.minimise()`(→0 ok) + `getAtomZ` + `set/getAtomMapNo` (verified `.d.ts`) | **v1 front-runner.** Gated by corpus + atom-map + bundle tests. |
| Custom RDKit MinimalLib WASM | BSD-3 | single-thread WASM (no SAB) | ETKDGv3 + MMFF/UFF (add embind; own the build) | v1 fallback + later high-fidelity. **Early size/init spike.** |
| Native RDKit sidecar | BSD-3 | native (`externalBin`) | full ETKDGv3 + MMFF/UFF + stereo/wedge | Later property-grade + **dev-only oracle**. Out of v1 path. |
| sci-form-wasm `0.15.2` | MIT | WASM (rayon→SAB) | `embed`, `search_conformers_with_uff` | Experimental plugin only. |
| OpenBabel WASM | **GPL** | plugin | gen3d + MMFF94/UFF | Isolated plugin / QA only. |
| Indigo / CoordgenLibs | Apache-2.0 / BSD | — | **no** conformer gen | Later clean-2D relayout. |

## Model & contract

- **No `z` on `MoleculeAtom`.** 3D is transient adapter/tool state, never persisted.
- **Output stays a `molecule`:** projected 2D coords + constrained-search wedges +
  rewritten V3000 `structure`, committed via `updateObject`
  (`packages/chem-core/src/patches.ts:18`), mirroring `cleanUpNativeMoleculeGeometry2d`
  (`apps/desktop/src/documentWorkflow.ts:4148`). Warn: "perspective depiction —
  geometry may need cleanup."

### Layered identity service (mandatory — avoids correlated failure)

Identity is first-class in `chemistry-adapter`, NOT hidden in conformer generation.
Three layers so the conformer engine is never also the sole validator:

1. **App-owned graph/stereo invariants (MANDATORY first line)** from the native
   V3000 parser — atom/bond counts, bond orders, formal charges, isotopes,
   radicals, a connectivity hash, and stored wedge/parity. Engine-independent;
   catches gross corruption with no chemistry engine.
2. **OCL canonical/parity** representation (canonical isomeric / CXSMILES — plain
   SMILES drops enhanced-stereo/S-group).
3. **Native RDKit** — corpus/oracle **tests only**, never shipped.

```ts
snapshotChemicalIdentity(mol): Promise<MoleculeIdentitySnapshot>; // layers 1+2
diffChemicalIdentity(before, after): StereoDiff;
```

Implemented in `packages/chem-core/src/identity.ts` (Phase 1A).

### Conformer contract (`packages/chemistry-adapter/src/index.ts`)

Capability flag `canGenerate3DConformer`. Atom identity mapping is first-order
(OCL saturates with H and mutates in place → **pass a copy**, tag atoms with
`setAtomMapNo` before handoff, rebuild the map via `getAtomMapNo` after; unmapped
result atoms are generated H):

```ts
type ConformerAtomMapping = {
  coords3dByOriginalAtom: Float64Array; // length = originalAtomCount * 3
  originalToEngineAtom: number[];       // original idx -> engine idx
  engineToOriginalAtom: number[];       // engine idx -> original idx, -1 = generated H
  generatedHydrogenEngineAtoms: number[];
};
generate3DConformer(input, options): Promise<{
  mapping: ConformerAtomMapping; originalAtomCount: number; generatedAtomCount: number;
  hydrogens: { added: boolean; explicitInputHydrogensPreserved: boolean };
  engine: { name: "openchemlib"|"rdkit-wasm"|"rdkit-native"|string; version: string; parameters: Record<string,unknown> };
  embed: { status: "ok"|"failed"|"unsupported"; failureReason?: string };
  forceField?: { name: "MMFF94"|"MMFF94s"|"UFF"|"none"; status: "not-run"|"converged"|"not-converged"|"setup-failed"; returnCode?: number; energy?: number; iterations?: number };
  unsupportedFeatures: ChemistryWarning[]; warnings: ChemistryWarning[];
}>
// options: seed, optimize "none"|"auto"|"mmff94"|"uff", preserveSpecifiedStereo: true, allowInventStereo: false
```

## The flatten + wedge algorithm — a constrained search (Phase 1B, complete)

`flattenPerspectiveFrom3D(mol2dOriginal, coords3d, viewMatrix, options) →
FlattenResult`. Implemented in `packages/chem-core/src/perspective.ts`.
**Encoding-soundness is a hard constraint; view-fidelity is the optimization target.**
Not "higher z ⇒ wedge".

1. **Eligible set:** only stereo specified in the original input. Never wedge a bond
   just because the view has depth.
2. **Enumerate candidates** per specified tetrahedral center: wedge/hash on each
   eligible adjacent single bond (prefer non-ring, long-enough projection), choosing
   origin atom. Bonds are a **shared resource** — adjacent/vicinal centers (and meso
   cases like tartaric acid) may contend for the same bond, so treat assignment as a
   small constraint-satisfaction problem across centers, not per-center-independent.
3. **Hard filter:** assemble the candidate molfile, parse it back, keep only
   assignments whose perceived stereo identity equals the original (global check;
   **backtrack** if a center's local choice breaks another).
4. **Score survivors for view fidelity:** z-separation, projected bond length,
   non-ring preference, no overlap, consistency with the viewed depth cue. Pick the
   most view-faithful surviving assignment.
5. **E/Z bonds:** never "wedge" a double bond; preserve double-bond stereo from the
   original graph; warn if projection makes substituents near-collinear/misleading.
6. **Commit guard:** if **no** assignment survives the hard filter → **refuse**.
   Otherwise commit; re-run `diffChemicalIdentity` on the committed result and refuse
   on known→unknown / inverted / newly-specified stereo.

Key implementation notes:
- **Parity form:** center-independent determinant `det[n2−n1, n3−n1, n4−n1]` for 4
  substituents (immune to symmetric-view collinearity); center-based triple product
  for 3 explicit substituents + implicit H.
- **Shared-bond CSP:** MRV backtracking so vicinal/meso centers never claim the same
  wedge bond.
- **Wedge narrow-end convention:** `bondStyle:"wedge"` → stereocenter at `fromAtomId`
  (narrow tip). To place a wedge AT center C, bond must have `fromAtomId === C`.
- **`diffChemicalIdentity` role:** graph backstop only (atom/bond/charge/connectivity),
  NOT marker-level — flatten legitimately moves a wedge to a different bond.

## Over/under crossings from depth (integrate the existing model — do not reinvent)

The same rotated z that drives wedges also resolves **front/back at every bond–bond
crossing the projection creates**. This is a *separate* output from wedging, with a
different invariant — do not conflate them:

| | Wedges | Over/under crossings |
|---|---|---|
| Encodes | chirality at a center / E,Z | spatial occlusion at a bond–bond intersection |
| Stored on | molecule bond `display` | page-level `page.crossings` (`CrossingOverride`) |
| Invariant | **must preserve chemical identity** | **display-only, identity-independent** |

The over/under model is implemented through Phase D
(`docs/architecture/over-under-crossing-model.md`) and was explicitly designed to
accept 3D depth: `compareBondDepth` (`packages/layout-engine/src/index.ts:842`)
resolves front/back via override → object layer → bond order, and the doc reserves
*"per-atom/per-bond 3D depth plugs into this comparator rather than rewriting the
crossing model."* So we **integrate, never reinvent**:

- **Live spin overlay (Phase 4):** the transient overlay paints in painter's order,
  depth-sorted by z, so occlusion reads correctly while spinning. We own it; it does
  not touch `page.crossings`.
- **Flatten commit (Phase 5):** for each projected crossing, `front` = the nearer-z
  bond; **bake a persisted `CrossingOverride`** via `setCrossingOverride`
  (`packages/chem-core/src/patches.ts:27`). The planner then renders the local gaps
  automatically. The transient z is consumed to author overrides, then discarded
  (3D still never persisted).
- **Cyclic-depth canary:** if projected pairwise fronts are inconsistent (A>B>C>A —
  3+ bonds near one knot, or near-coincident depths), reuse the model's existing
  cyclic-depth warning ("Escher drawing that can't be realized as a clean 2D weave")
  → **warn**, offer re-spin. Don't silently pick a winner.

## Implementation phases (safety before UI)

- ✅ **Phase 1A — Layered identity service.** App-owned graph invariants (mandatory) +
  OCL canonical/parity; `snapshot`/`diffChemicalIdentity`; fixtures incl. a
  deliberately inverted center. RDKit-backed in tests.
  → `packages/chem-core/src/identity.ts` · 15 tests passing.

- ✅ **Phase 1B — `flattenPerspectiveFrom3D` vs. synthetic 3D fixtures** (hand-authored
  methane-like, chiral, E/Z, cyclohexane, vicinal/meso, failure cases). No engine wait.
  → `packages/chem-core/src/perspective.ts` · 13 tests passing · commit `347fe65`.

- ◐ **Phase 1C — Corpus runner + oracle boundary** (no UI, dev-only). **Engine-free
  core complete & green**; live RDKit chemistry oracle deferred (see caveat).
  → `packages/chem-core/src/corpus.ts` — labeled corpus (`mustCommit`/`warnButAllow`/
    `mustRefuse`) + `runCorpus()`; 10 deterministic, engine-free cases regression-lock
    Phase 1B (commit 6/6, warn 2/2, refuse 2/2). Conformer-dependent families
    (chairs, decalins, macrocycles…) are explicitly deferred to Phase 2, not faked.
  → `packages/chem-core/src/oracle.ts` — the **non-mutation discipline barrier**:
    clones every input before handing it to an engine, so an engine can never
    corrupt the molecule under validation (the `AssignStereochemistryFrom3D`
    `replaceExistingTags=True` footgun). Proven by a deliberately-mutating mock.
  → 11 tests passing.
  **Caveat (honest):** this environment has no RDKit (python/native) and no OCL. A
  concrete RDKit-backed `StereoPerceptionEngine` is *not* shipped — an untested
  chemistry bridge would defeat the oracle's whole purpose. It is a drop-in that
  must build its RWMol on a copy, call `AssignStereochemistryFrom3D(replaceExistingTags=False)`,
  and pass the same non-mutation contract test. Wiring it requires RDKit availability
  (a real external dependency / machine side-effect) and the engine corpus from Phase 2.

- **Phase 2 — OpenChemLib core adapter + corpus run.** Lazy `import()` on first spin.
  **Prove the mapping contract** (tag via `setAtomMapNo`, hand OCL a copy) across
  isotopes, query atoms, salts/fragments, unusual valence. **Measure real bundle
  cost** — lazy chunk size, gzip/Brotli, parse/init, first-spin latency in the actual
  Vite/Tauri bundle. (OCL is GWT/J2CL→esbuild monolithic and likely not
  tree-shakeable, so ~1.1 MB raw is probably the floor — treat the number as a raw
  artifact measurement only, not product cost.)

- **Phase 2b — Minimal RDKit WASM spike (parallel, early).** Build size, init time,
  embind maintenance pain for ETKDGv3 + optional MMFF/UFF. Removes the fallback's
  biggest unknown before UI investment.

- ✅ **Phase 3 — Rotation math (pure).** `apps/desktop/src/interaction/rotation3d.ts`
  (sibling to `camera.ts`): trackball → quaternion → 4×4 → orthographic project.
  `quatToViewMatrix` emits a row-major 4×4 in the *exact* convention
  `perspective.ts.applyMatrix` consumes, so the spin's orientation feeds
  `flattenPerspectiveFrom3D` with zero glue. Unit-tested (17 tests incl. a
  flatten-contract test), no doc/React coupling. Done out of order (before 2) since
  it is dependency-free.

- **Phase 4 — In-canvas spin.** `machine.ts`: add `"molecule-spin-3d"` to `DragKind`
  + `DRAG_THRESHOLDS`. `MainWindow.tsx`: `spin3dMachineRef` mirroring
  `objectRotateMachineRef`; transient conformer + quaternion in a sibling ref;
  transient **depth-sorted** SVG overlay (painter's order from z so occlusion reads
  during the spin; no per-frame doc mutation; conformer once at spin start);
  Esc → `cancel`. New `structure.spin3d` (mirror `structureCleanupCommandId`).

- **Phase 5 — Flatten commit + warning/refusal UX.** On release run
  `flattenPerspectiveFrom3D`; commit the molecule (`updateObject`) **plus**
  `setCrossingOverride`s for the projected crossings as one undo group; surface
  warnings; refuse on the commit guard (stereo) and warn on cyclic depth.

- **Phase 6 — Re-edit + round-trip tests.** Re-opens in Ketcher host; round-trip:
  canonical isomeric SMILES/CXSMILES preserved, stereo preserved-or-warned,
  atom/bond counts stable.

- **Decision gate (after 2 + 2b):** OCL ships / RDKit WASM ships / OCL ships **with a
  declared unsupported-feature list**. Sidecar stays out of v1 unless both fail.

- **Later:** `structure.cleanTo2d` (clean relayout via 3D + CoordGen/Indigo);
  high-fidelity engine behind the same contract.

## Hard-stop conditions

No phase advances past these gates:

1. No UI until Phase 1A/1B tests pass.
2. No OCL default until atom mapping proven by tags.
3. No user-facing release unless corpus has labeled outcomes.
4. No silent unsupported chemistry.
5. No launch if OCL and RDKit-WASM both remain unresolved.

## Validation corpus (labeled — a decision tool, not a demo set)

Every fixture carries `mustCommit` / `warnButAllow` / `mustRefuse`. Families: chairs,
cis/trans-cyclohexanes, decalins, norbornane, spiro/bridged/cage, fused aromatics,
medium rings, macrocycles, E/Z alkenes, allenes, tetrahedral centers,
charged/zwitterionic, explicit-H. Adversarial fixtures:

- unspecified tetrahedral center → **must not become specified**
- specified center viewed edge-on → **warn/refuse**
- specified E/Z viewed collinear → **warn**
- **meso / pseudoasymmetric / symmetry-stress** (e.g. meso-tartaric acid) → exposes
  "canonical string says OK but drawing semantics aren't"; ties to the shared-bond
  CSP in the wedge search → **must encode correctly or refuse**
- enhanced stereo group → preserve or **declare unsupported**
- atropisomeric/axial → likely unsupported → **warn/refuse**
- square-planar/octahedral metal → **must not silently rewrite**
- multi-fragment salt → arbitrary fragment placement → **warn** unless single
  fragment selected
- isotope H/D/T at a stereo center → **preserve identity + mapping**
- query/R-group → **return unsupported**, never a fake molecule
- **projection weave** (bridged/fused/steroid that flattens with crossings; rotaxane
  axle-through-macrocycle) → correct over/under `CrossingOverride`s baked from depth →
  **`mustCommit`**
- **cyclic-depth / Escher** (3+ bonds crossing near one knot; near-coincident z) →
  inconsistent pairwise fronts → **`warnButAllow`** (offer re-spin)

## Risks

- **OCL ring/conformer quality (top):** contingent on the corpus (chairs/fused).
  Mitigation: RDKit oracle + RDKit-WASM fallback spiked early.
- **Correlated failure:** OCL generating *and* validating could share a blind spot →
  mandatory app-owned graph-invariant layer + RDKit oracle in tests.
- **Atom mapping:** H saturation/in-place mutation → pass a copy + `setAtomMapNo`
  tagging + adversarial tests (Phase 2 gate).
- **Wedge soundness:** encoding-sound is a hard constraint with backtracking on
  shared bonds; refuse if unsatisfiable.
- **Over/under crossings:** projection creates crossings; front/back baked into
  persisted `CrossingOverride`s from z (display-only, identity-independent) via the
  existing `compareBondDepth`/`page.crossings` model. Cyclic/inconsistent depth →
  reuse the Escher canary → warn.
- **Bundle cost:** OCL likely not tree-shakeable; measure real gzip/Brotli/init.
- **Overlay perf / scope creep / SAB / native:** conformer once; output always 2D
  `molecule`; non-OCL engine concerns deferred to their boundaries.

## Per-slice checklist (repo convention)

After each merged slice: update the build stamp in **both** `AGENTS.md`
(`**Current Build**`) and the `Build` string in `apps/desktop/src/MainWindow.tsx`
(`[month].[day].[hour].[minute]-[agent]`); add/update tests (`AGENTS.md` §13).

## Verification

- **Phase 1A/1B/1C:** `pnpm test` — identity diff catches an inverted center;
  `flattenPerspectiveFrom3D` passes synthetic + vicinal/meso + refuse fixtures;
  corpus runner emits a labeled pass/warn/refuse report vs. the RDKit oracle; oracle
  non-overwrite fixture green. No UI.
- **Phase 2 / 2b:** OCL adapter lazy-loads (zero startup cost); mapping adversarial
  tests green; real bundle-cost recorded; RDKit-WASM size/init/maintenance recorded.
- **Phase 3:** `rotation3d` unit tests pass.
- **Phase 4:** `pnpm --filter desktop tauri dev`; invoke `structure.spin3d`, drag to
  rotate overlay, Esc cancels back to original.
- **Phase 5:** spin cyclohexane to a chair → 2D molecule with correct wedges; edge-on
  specified center warns/refuses; one undo reverts the flatten.
- **Phase 6:** flattened molecule re-opens in Ketcher; round-trip tests green.
