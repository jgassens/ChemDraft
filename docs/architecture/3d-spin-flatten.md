# Roadmap: 3D Spin → Flatten Perspective Tool

**Status:** Phases 1A, 1B, 1C, 2, 3, 4, 5.0, and 5 complete on `feature/3d-spin`;
all green (`tsc` clean, 568 tests). The full feature works end-to-end and is
browser-verified: draw → Spin 3D → lazy OCL conformer → drag-rotate overlay →
release flattens the perspective into the document (one undo step) → Cmd+Z reverts.
Styrene tested specifically — its double bonds survive the flatten on their original
atom pairs. The chemistry chain is independently RDKit-confirmed end to end. **Next:
Phase 6 (re-edit + round-trip tests; all automated, no UI).** Phase 2b is conditional
(see its entry). Architecture decided: **built into the app, behind the
`chemistry-adapter` seam** — not a plugin. Engine front-runner: **OpenChemLib JS**,
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

- ✅ **Phase 1C — Corpus runner + independent RDKit oracle** (no UI, dev-only).
  → `packages/chem-core/src/corpus.ts` — labeled corpus (`mustCommit`/`warnButAllow`/
    `mustRefuse`) + `runCorpus()`; 10 deterministic, engine-free cases regression-lock
    Phase 1B (commit 6/6, warn 2/2, refuse 2/2). Conformer-dependent families
    (chairs, decalins, macrocycles…) are explicitly deferred to Phase 2, not faked.
  → `packages/chem-core/src/oracle.ts` — the **non-mutation discipline barrier**:
    clones every input before handing it to an engine, so an engine can never
    corrupt the molecule under validation (the `AssignStereochemistryFrom3D`
    `replaceExistingTags=True` footgun). Proven by a deliberately-mutating mock.
  → `tools/rdkit-oracle/` — the **independent external judge**, native/Python RDKit
    in an isolated, gitignored venv (`rdkit==2026.3.3`), wired via a stdin→stdout
    JSON bridge (`oracle.py`) + a dev-only Node client (`client.ts`). The corpus
    cross-check (`corpus-oracle.test.ts`) asks RDKit two independent questions —
    CIP from the 3D conformer vs. CIP from the flatten's 2D wedge depiction — and
    asserts they agree at every encoded center. A "teeth" test flips a wedge and
    asserts RDKit then *disagrees*, proving the check is non-vacuous. Skips (never
    fails) when the venv is absent, so CI without RDKit stays green.
  → 15 tests passing (11 chem-core + 4 oracle cross-check).
  **Guardrails:** RDKit is the dev oracle only — never shipped, never the product
  engine. Stock `@rdkit/rdkit` WASM remains 2D-only and is not this. The engine
  decision is unchanged: OCL v1 candidate, RDKit-WASM fallback spike + OCL corpus
  gate still stand.

- ✅ **Phase 2 — OpenChemLib core adapter + end-to-end gate.** (Core complete; the
  family corpus can keep growing.)
  → `packages/chemistry-adapter` — engine-neutral `ConformerGenerator3D` contract
    (`ConformerAtomMapping`, `generate3DConformer`, force-field/embed reports).
  → `packages/ocl-adapter` — the OCL implementation. Registers OCL torsion
    `resources.json`, tags every original atom with `setAtomMapNo`, runs the
    conformer on a `copyMolecule` COPY (`getOneConformerAsMolecule` mutates in
    place), MMFF94-minimises, and rebuilds the original↔engine atom map via
    `getAtomMapNo`. 9 tests incl. adversarial mapping (multi-fragment, isotope at a
    stereocenter, atom-count-mismatch warning, `optimize:'none'`). Lazy-loadable as
    its own package (dynamic `import()` at first spin keeps OCL out of startup).
  → `tools/rdkit-oracle/ocl-flatten-gate.test.ts` — the **end-to-end gate**: OCL
    conformer → flatten → RDKit, asserting the CIP is identical at THREE independent
    RDKit reads (OCL 2D depiction, OCL 3D conformer, flatten's projected wedges) for
    both enantiomers of `C[C@H](F)Cl`.
  → **Bundle cost (measured):** `openchemlib.js` 1.05 MB raw / **0.32 MB gzip**;
    conformer torsion `resources.json` 1.29 MB raw / **0.45 MB gzip**. Conformer
    generation needs BOTH → **2.34 MB raw / ~0.77 MB gzip** as a lazy chunk. (The
    plan's ~1.1 MB estimate was JS-only; resources more than double it.)
  → **Bug caught by the layered oracle:** OCL's 2D `getAtomY` is screen-down while
    its molfile writer (and 3D conformer) are y-up; reading the 2D layout raw
    produced the MIRROR enantiomer. flatten's conformer-mismatch guard refused, and
    RDKit pinpointed it (depiction=S vs conformer=R). Fixed in `depictSmiles2D`
    (emit y-up) with a non-RDKit regression guard. Vindicates the layered design:
    an engine validating its own output would never have caught this.

- **Phase 2b — Minimal RDKit WASM spike (CONDITIONAL — do not start by default).**
  Originally an early fallback de-risk. OCL has since passed the end-to-end gate
  with independent RDKit confirmation and a measured ~0.77 MB gzip lazy cost, so
  this spike is **only triggered if the ring-family corpus (see Known gaps, G3)
  shows OCL conformer quality failures** (bad chairs, broken fused systems). It
  requires a local emscripten/CMake toolchain and a custom RDKit MinimalLib build —
  do NOT attempt it casually or in a constrained environment. If triggered, the
  deliverables are numbers only (wasm size raw/gzip, init ms, embind surface needed
  for ETKDGv3+MMFF), recorded here; no committed build artifacts.

- ✅ **Phase 3 — Rotation math (pure).** `apps/desktop/src/interaction/rotation3d.ts`
  (sibling to `camera.ts`): trackball → quaternion → 4×4 → orthographic project.
  `quatToViewMatrix` emits a row-major 4×4 in the *exact* convention
  `perspective.ts.applyMatrix` consumes, so the spin's orientation feeds
  `flattenPerspectiveFrom3D` with zero glue. Unit-tested (17 tests incl. a
  flatten-contract test), no doc/React coupling. Done out of order (before 2) since
  it is dependency-free.

- ✅ **Phase 4 — In-canvas spin.** Detailed spec below (§ Phase 4 spec). Select a
  molecule → `structure.spin3d` lazy-loads OpenChemLib (separate ~0.77 MB gzip
  chunk), generates a 3D conformer, and shows a transient depth-sorted SVG overlay
  (painter's order, dimmed backdrop) that the pointer drags rotate via the Phase 3
  trackball; Esc cancels. No document mutation (commit is Phase 5).
  → `apps/desktop/src/interaction/spinOverlay.ts` (pure projection, 8 tests) +
    `oclResources.ts` (browser-only resource-URL via `new URL(...,import.meta.url)`).
  → MainWindow: spin refs, command routing, self-contained `SpinOverlay` that owns
    its own pointer drag (no edits to existing pointer handlers).
  → Verified end-to-end in-browser (web build + Playwright-style drive): conformer
    generates, overlay renders + rotates on drag, Esc tears down, zero console
    errors; production `build:web` emits `resources.json` as a hashed asset and
    code-splits OCL out of startup.

- ✅ **Phase 5.0 — V2000 molfile writer** (prerequisite, done early with Phase 4).
  `packages/chem-core/src/molfile.ts` `moleculeToMolfileV2000` — atom-order
  preserving, `fromDocFrame` y-negation, wedge/charge support. 8 tests (6 structural
  + 2 OCL round-trip).

- ✅ **Phase 5 — Flatten commit + warning/refusal UX.** Releasing a real spin gesture
  flattens the conformer into the document as ONE undo step; an incidental tap just
  ends the drag; refusal keeps the overlay so the user can re-orient.
  → `documentWorkflow.ts` `flattenSpunMolecule` — frame recipe in/out, rescale +
    recenter + page-clamp to land on the existing footprint, rewrites the molfile
    `structure`, clears stale + bakes fresh `CrossingOverride`s, all in one
    `applyPatches`. Refusal returns the document untouched (=== reference).
  → MainWindow `commitSpinFlatten` on drag release; on-overlay hint text.
  → Tests: `apps/desktop/src/spinFlatten.test.ts` (commit mechanics + refusal
    passthrough) and the **styrene end-to-end test** — real OCL conformer →
    flatten → all 4 Kekulé double bonds preserved on their original atom pairs,
    bond-order multiset unchanged, molfile encodes the same double-bond count.
  → Verified live in-browser: draw → Spin 3D → drag → release flattens + commits,
    overlay clears, Cmd+Z reverts in one undo, zero console errors.

- ✅ **Phase 5 UX refinements (from owner review).**
  → **Opening orientation:** OCL embeds at an arbitrary angle that often projects
    edge-on. `initialViewQuaternion` (spinOverlay.ts) PCA-fits the conformer's
    principal plane and turns it toward the viewer with a gentle ~23° tilt, so the
    molecule is readable the instant the overlay appears.
  → **Backdrop:** the dim overlay went from 0.62 → 0.94 opacity so the underlying
    molecule "phantom" is nearly gone (it was too bright to see the 3D clearly).
  → **Interaction model:** drag INSIDE the selection box to rotate; release stays in
    spin mode (grab again to keep rotating); **click OUTSIDE the box to flatten**;
    Esc cancels. (Previously release-to-flatten, which was too eager.)
  → **Ring double bonds:** `flattenSpunMolecule` now recomputes every double bond's
    `doubleBondSide` from the projected geometry via the app's own
    `defaultDoubleBondSide`, so ring double bonds draw INSIDE the ring (they were
    landing outside). Pinned by a benzene ring-interior test.
  → All four verified live (benzene placed, spun, flattened) + unit tests.

- **Phase 6 — Re-edit + round-trip tests.** Detailed spec below (§ Phase 6 spec).

- **Decision gate (after the ring-family corpus, Known gaps G3):** OCL ships / OCL
  ships **with a declared unsupported-feature list** / trigger Phase 2b. Sidecar
  stays out of v1 unless OCL and (if triggered) RDKit-WASM both fail.

## Coordinate frames (CRITICAL — read before Phases 4/5)

Three frames exist. Mixing them up silently mirrors stereochemistry — this exact
bug class has already been caught twice (OCL 2D layout; see Phase 2 notes).

| Frame | y direction | Used by |
|---|---|---|
| **Document / screen** | y DOWN (SVG) | `MoleculeAtom.x/y` in documents, all of MainWindow/layout-engine. Proof: molfile import negates y (`scaleParsedMolfileAtoms`, documentWorkflow.ts) |
| **Math / chemistry** | y UP, right-handed, z toward viewer | `flattenPerspectiveFrom3D` (inputs AND outputs), `rotation3d.ts` quaternions/matrices, `coords3dByOriginalAtom` from ocl-adapter, molfiles |
| **Trackball screen input** | y DOWN in, converted internally | `projectToTrackball` flips y itself — pass raw client/page deltas, get math-frame quaternions out |

**The recipe (Phase 5 must follow verbatim, pinned by tests in perspective.test.ts
"screen-frame (y-down) callers"):**
1. IN: build the flatten input molecule from the doc molecule with `y = -atom.y`,
   wedge/hash styles UNCHANGED. (This maps the doc to exactly the molecule a human
   perceives on screen.)
2. OUT: take `mol2dProjected` and negate y back (`y = -atom.y`), styles UNCHANGED.
3. Never negate only one direction, and never swap wedge↔hash to "fix" a mirror —
   if output looks mirrored, a negation step is missing.
4. Passing raw doc coords without step 1 makes flatten refuse with
   `conformer-mismatch` (safe failure, also pinned by test).
5. Crossings are depth-only and unaffected by the y hop — bake them as returned.

## Phase 4 spec — in-canvas spin (first click-test)

Goal: select a molecule → invoke `structure.spin3d` → drag rotates a live 3D
overlay of the conformer → Esc cancels. No document mutation in this phase at all
(flatten commit is Phase 5; on release, just keep the overlay until Esc).

Wiring (all locations verified against the current code):
1. `apps/desktop/package.json`: add `"@chemdraft/ocl-adapter": "workspace:*"` and
   `"@chemdraft/chemistry-adapter": "workspace:*"` to dependencies; run `pnpm install`.
2. `apps/desktop/vite.config.ts` `resolve.alias`: add
   `"@chemdraft/ocl-adapter": workspacePackage("../../packages/ocl-adapter/src/index.ts")`
   and the same for `chemistry-adapter` (the alias list currently lacks both).
3. `apps/desktop/src/commands.ts` (~line 68, next to `structureCleanupCommandId`):
   `export const structureSpin3dCommandId = "structure.spin3d";`
4. `apps/desktop/src/toolsets/desktop-toolsets.json`: copy the `structure.cleanup2d`
   entries (lines ~97/~116) with `commandId: "structure.spin3d"`,
   `title: "Spin 3D"`, reuse `icon: "style"` for now, no shortcut.
5. `apps/desktop/src/interaction/machine.ts`: add `"molecule-spin-3d"` to the
   `DragKind` union (line ~29) and `"molecule-spin-3d": 4` to `DRAG_THRESHOLDS`
   (line ~81). Nothing else in the machine changes.
6. `apps/desktop/src/MainWindow.tsx`:
   a. Refs (next to `objectRotateMachineRef`, line ~526):
      `spin3dMachineRef = useRef<InteractionState>(initialInteractionState())` plus
      one `spin3dStateRef` holding `{ objectId, quat: Quaternion, lastPointer: {x,y},
      coords3d: Float64Array, atomOrder: string[], bondPairs: [number,number][],
      trackball: TrackballConfig } | undefined`.
   b. Command routing (mirror `structureCleanupCommandId` at line ~2033): on
      `structure.spin3d` with a single selected native molecule, start the spin:
      lazy-load the engine — `const ocl = await import("@chemdraft/ocl-adapter")` —
      then `ocl.setOclResourcesUrl(oclResourcesUrl)` where
      `import oclResourcesUrl from "openchemlib/dist/resources.json?url"` (top-level
      static import of the URL only; the heavy module stays dynamic), then
      `await ocl.oclConformerGenerator.init()`, write the molecule to a molfile via
      `moleculeToMolfileV2000` (Phase 5.0 — build it first if doing 4 before 5.0),
      `generate3DConformer({ molfile })`, store coords + identity quaternion in
      `spin3dStateRef`. If `embed.status !== "ok"`, `setStatus(failureReason)` and
      do not enter spin mode.
   c. Pointer wiring (mirror the objectRotate pointerDown at ~4092 / pointerMove at
      ~3302): while spin mode is active, pointerDown captures, pointerMove computes
      `quat = applyTrackballDrag(quat, lastPointer, current, trackball)` (from
      `./interaction/rotation3d`), updates `spin3dStateRef`, and triggers a re-render
      (one `useState` bump; do NOT touch the document).
      `trackball = { center: moleculeScreenCenter, radius: max(120, boundingRadius) }`.
   d. Overlay component (new function component next to `NativeTemplateGhostOverlay`,
      line ~5872): absolutely-positioned SVG over the page. For each atom i:
      `[px, py, pz] = projectPoint(quatToViewMatrix(quat), centered3d(i))`;
      screen position = `moleculeCenter + (px, -py) * overlayScale` (NOTE the
      y negation — math frame → screen frame; `overlayScale` = molecule's median
      2D bond length / conformer median 3D bond length). Draw bonds as `<line>`s
      sorted by average pz ASCENDING (far first, near last = painter's order);
      stroke heavier + lighter color for near bonds if cheap. Dim the real
      molecule underneath (e.g. `opacity: 0.25` on its group) while spinning.
   e. Esc (extend handlers at lines ~7045/~7090): if spin mode active, clear
      `spin3dStateRef` + machine ref, restore opacity, `setStatus("Spin cancelled")`.
7. Tests: machine threshold test mirroring existing DragKind tests; overlay math
   (centered3d/overlayScale/painter-order) extracted into pure helpers in
   `apps/desktop/src/interaction/spinOverlay.ts` with unit tests — keep React out.
8. Verify: `pnpm lint && pnpm test`, then `./run-app`; draw a molecule with a wedge
   (or paste `C[C@H](F)Cl` as molfile), select it, invoke Spin 3D, drag — the
   conformer should rotate smoothly with correct near/far occlusion; Esc restores.

## Phase 5 spec — flatten commit + warning/refusal UX

**Phase 5.0 (prerequisite, pure + unit-tested): molfile writer.** New
`packages/chem-core/src/molfile.ts` exporting
`moleculeToMolfileV2000(mol: MoleculeObject, opts?: { fromDocFrame?: boolean }): string`.
- Atom block IN `mol.atoms` ORDER (critical: keeps `coords3dByOriginalAtom`
  index-aligned with `mol.atoms`). Line format `%10.4f%10.4f%10.4f SYM` (3-char
  left-padded symbol field, then padding zeros as in any V2000).
- `fromDocFrame: true` ⇒ write `y = -atom.y` (doc y-down → molfile y-up).
- Bonds: `%3d%3d%3d%3d` with 1-based atom indices, order codes 1/2/3 (aromatic→4),
  stereo flag 1 for `display.bondStyle === "wedge"`, 6 for `"hashed"`, else 0.
  fromAtomId is the first index (narrow end).
- Counts line: `%3d%3d  0  0  1  0  0  0  0  0999 V2000` (chiral flag 1 when any
  wedge/hash present, else 0). `M  CHG` lines for nonzero formalCharge
  (format: `M  CHG  n  aaa vvv ...`), then `M  END`.
- Reference implementation of the exact field widths that RDKit+OCL both parse:
  `tools/rdkit-oracle/oracle.py` `_build_molblock` (proven in tests).
- Tests: round-trip via `@chemdraft/ocl-adapter`'s `OCL.Molecule.fromMolfile` →
  atom count, element order, wedge survives; plus a doc-frame fixture asserting the
  y negation (compare against `scaleParsedMolfileAtoms`'s convention).

**Phase 5.1 — commit path.** New workflow function in documentWorkflow.ts
(mirror the cleanup pattern at lines ~4395-4426):
```
flattenSpunMolecule(document, objectId, coords3d, viewMatrix):
  mol = the molecule object (must be editable native graph)
  mathMol = mol with atoms y → -y                      // frame recipe IN
  result = flattenPerspectiveFrom3D(mathMol, coords3d, viewMatrix, { objectId })
  if result.status === "refused": return { document, refused: result }
  projected = result.mol2dProjected with atoms y → -y  // frame recipe OUT
  rescale: s = (median 2D bond length of mol) / (median 2D bond length of projected);
           atoms = projected.atoms * s, then translate so centroid matches mol's
           centroid, then clamp into the page (reuse scaleParsedMolfileAtoms's
           clamping approach)
  structure = moleculeToMolfileV2000(rescaled, { fromDocFrame: true });
           structureFormat = "molfile-v2000"
  patches = [
    { op: "updateObject", objectId, changes: { atoms, bonds, structure, structureFormat } },
    ...for each existing page.crossings entry whose BOTH refs point at this object:
       { op: "clearCrossingOverride", pageId, bonds },   // stale overrides out
    ...result.crossings.map(c => ({ op: "setCrossingOverride", pageId, crossing: c }))
  ]
  return { document: applyPatches(document, patches, { now }), result }
```
One `commitDocumentChange(nextDocument)` call in MainWindow = ONE undo step
(verified: commitDocumentChange at line ~821 pushes a single history entry).
- On pointer release in spin mode (Phase 4's machine reaching `pointerUp` while
  dragging): call the workflow; on commit, clear spin state and
  `setStatus("Perspective flatten: N warnings")`; surface each meaningful warning
  (`ez-edge-on`, `cyclic-depth`, `ambiguous-crossing-depth`,
  `degenerate-drawn-parity`) via `setStatus` lines or the existing warning UI;
  `perspective-cleanup` is baseline noise — show once, softly.
- On refusal: do NOT modify the document; keep the spin overlay alive so the user
  can re-spin; `setStatus(refusalReasons[0])`.
- Tests (documentWorkflow.test.ts style): chiral fixture commits with 1 wedge +
  correct doc-frame y; refusal leaves document identical (===); crossings baked;
  stale crossings cleared; single undo restores everything (one `undo()` call).

**Phase 5 verify:** spin `C[C@H](F)Cl` to a new angle → release → molecule
re-renders with a sound wedge; Cmd+Z restores the old depiction AND old crossings;
spinning a stereocenter edge-on → release → status shows the refusal, document
untouched.

## Phase 6 spec — re-edit + round-trip tests

All automated; no UI work.
1. Round-trip test (chem-core or tools): doc molecule → flatten commit (Phase 5.1
   function) → `moleculeToMolfileV2000` → parse back via OCL → atom/bond counts
   stable, stereo perceived (OCL parity non-zero where encoded).
2. Oracle round-trip (tools/rdkit-oracle): flattened molfile → RDKit
   `perceiveFrom2D` CIP == pre-flatten CIP for every encoded center (this is the
   ocl-flatten-gate extended to the committed doc-frame output — remember the
   doc-frame molfile is y-up again, so no extra negation).
3. Ketcher re-open: feed the rewritten `structure` to the existing Ketcher host
   boundary test (`apps/desktop/src/ketcherBoundary.test.ts` pattern) and assert it
   loads without errors.
4. Repeat-edit: flatten → move an atom via existing workflow helpers → flatten
   again with a new conformer → still sound (no marker duplication; the strip-and-
   re-encode in `buildProjectedMolecule` guarantees this — test pins it).

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

## Known gaps / follow-ups (from the 2026-06-10 code review)

Each is loud-failing or test-guarded today; none blocks Phase 4. Specs are precise
enough to hand to an inexpensive model as standalone slices.

- **G1 — oracle.py ignores formal charges.** Charged corpus fixtures will fail
  LOUDLY (RDKit sanitize error reported per-request), not silently. Fix when the
  charged/zwitterionic family lands: accept optional `charge` per atom in the
  request JSON; emit `M  CHG  n  aaa vvv ...` lines before `M  END` in
  `_build_molblock`; add a charged fixture to `corpus-oracle.test.ts`.
- **G2 — oracle reports tetrahedral CIP only, no E/Z bond stereo.** Add a `bonds`
  field to the oracle response: for each double bond, RDKit
  `bond.GetStereo()` mapped to `"E" | "Z" | "none"` (use
  `Chem.FindPotentialStereoBonds` + `AssignStereochemistry`). Needed before the
  E/Z corpus family can be oracle-judged (the engine-free `ez-edge-on` warning is
  already corpus-locked).
- **G3 — ring/conformer corpus families (chairs, decalins, norbornane, spiro,
  macrocycles) still deferred — now UNBLOCKED by ocl-adapter.** Build
  `tools/rdkit-oracle/ring-corpus.test.ts`: for each family SMILES (list in
  `CORPUS_DEFERRED_FAMILIES`), `depictSmiles2D` → `generate3DConformer` (seeded) →
  flatten → assert labeled outcome + RDKit CIP agreement (same 3-read structure as
  `ocl-flatten-gate.test.ts`). THIS is the OCL ring-quality gate that decides
  whether Phase 2b ever runs.
- **G4 — multi-marker centers.** Two drawn wedges at one center: last bond in
  document order drives the pre-check (documented in perspective.ts). Safe
  (worst case = conservative refusal); revisit only if real-world refusals occur.
- **G5 — `getTotalEnergy` presence.** ocl-adapter reads MMFF energy via an
  optional method guard; if OCL's API drifts, energy is simply absent from the
  report. No action unless energy becomes user-facing.

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
- **Phase 4:** `pnpm lint && pnpm test`, then `./run-app`; invoke `structure.spin3d`,
  drag to rotate overlay (near/far occlusion correct), Esc cancels back to original.
- **Phase 5:** spin cyclohexane to a chair → 2D molecule with correct wedges; edge-on
  specified center warns/refuses; one undo reverts the flatten.
- **Phase 6:** flattened molecule re-opens in Ketcher; round-trip tests green.
