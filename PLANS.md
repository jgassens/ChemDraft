# ChemDraft Plans

# ChemDraft property & prediction suite — branch `chemdraft-analyzers`

Everything under this heading is the **full scope of work for this branch**. The sections after it
("Landed on `main` before this branch") are shipped-state records carried forward from the trunk so a
merge does not drop them; they are context, not scope.

## Context

The goal is to bring ChemDraw 26.0's computed-property surface to ChemDraft: composition and mass,
mass-spec m/z, tPSA/logP/MR, pKa/logS, thermophysical QSPR, ¹H/¹³C NMR, topological descriptors,
3D/molecular mechanics, and the Chem3D-style quantum interfaces.

**The repository already holds most of the useful machinery.** It vendors a pinned, patched **RDKit
MinimalLib WASM** (BSD-3-Clause, `packages/rdkit-adapter/vendor/`, RDKit 2026.03.3) and depends on
**OpenChemLib 9.22.1** (BSD-3-Clause). The conformer path already uses the real RDKit artifact, while
`packages/rdkit-adapter/src/index.ts` is still `rdkitAdapterStatus = "placeholder"` with
fixture-backed analysis over ten hardcoded SMILES. The first release is **wiring and contract design,
not dependency acquisition.**

Re-verified 2026-07-30 on this branch by loading `vendor/RDKit_minimal.{js,wasm}` through the same
Node path as `packages/rdkit-adapter/src/testing.ts` (aspirin, `CC(=O)Oc1ccccc1C(=O)O`):

| Source | Returned |
| --- | --- |
| `version()` | `2026.03.3` |
| `mol.get_descriptors()` | 43 descriptors: `tpsa` 63.60, `CrippenClogP` 1.3101, `CrippenMR` 44.7103, `exactmw` 180.042258736, `amw` 180.159, `kappa1/2/3`, `chi0n`–`chi4v`, `hallKierAlpha`, `labuteASA`, `Phi`, `NumRotatableBonds` 2, `lipinskiHBA` 4 / `lipinskiHBD` 1, ring and stereo counts |
| `mol.get_inchi()` + `RDKit.get_inchikey_for_inchi()` | `InChI=1S/C9H8O4/c1-6(10)13-8-5-3-2-4-7(8)9(11)12/h2-5H,1H3,(H,11,12)`, `BSYNRYMUTXBXSQ-UHFFFAOYSA-N` |
| `RDKit.get_qmol` + `mol.get_substruct_matches` | SMARTS `[CX3](=O)[OX2H1]` → `{"atoms":[10,11,12],"bonds":[10,11]}` |
| OpenChemLib `MoleculeProperties` | `logP` 1.13, `logS` −1.93, `polarSurfaceArea` 63.60, `donorCount` 1, `acceptorCount` 4 |

Three implementation facts that fall out of that run and shape Phase 2:

- **There is no formula, charge, or elemental-composition field among the 43 descriptors.** Composition
  must be derived from `mol.get_json()` — RDKit JSON carries per-atom `z`, `impHs`, `chg`, `nRad`,
  `isotope`, `stereo` against a `defaults` block (`{z:6, impHs:0, chg:0, nRad:0, isotope:0}`), which is
  exactly the source-preserving basis §1 requires. Confirmed on
  `[13CH3]C(=O)O[C@H](Cl)c1ccccc1.[Na+].[Cl-]`: 14 heavy atoms, and after `add_hs_in_place()` a Z
  histogram of `{H:9, C:9, O:2, Na:1, Cl:2}` with the ¹³C isotope label preserved.
- **`get_inchi` is a molecule method; `get_inchikey_for_inchi` is a module function.** The module-level
  surface is only `get_mol`, `get_mol_copy`, `get_mol_from_png_blob`, `get_mol_from_uint8array`,
  `get_mols_from_png_blob`, `get_qmol`, `get_rxn`, `get_mcs_as_{json,mol,smarts}`, and
  `get_inchikey_for_inchi`.
- **`mol.get_frags()` returns a live `JSMolList` handle, not JSON.** Component splitting has a
  `delete()` obligation, same as every other handle.

**Five things are mandatory before implementation:** the interpretation ledger (§1), the classification
split (§2), run/result separation with schema versioning (§3), parallel tracks with an nmrshiftdb2
contingency and deadline (§4), and the job architecture (§5). Everything else can ride the phases.

The two failure modes to design against: **well-provenanced answers to ambiguously transformed
molecules**, and **engineering blocked on questions only distribution needs answered.**

## 1. One parse, many named interpretations

The single most important correction to earlier drafts. Parsing and sanitizing once through RDKit is
right; applying **one** normalized representation to every calculation is not.

Formula, charge, and isotope composition must describe what the user *drew*. logP may legitimately want
a neutralized largest organic fragment. pKa requires tautomer and protomer enumeration. A force-field
job operates on a hydrogenated, conformer-specific derivative. InChI needs both source-preserving and
standardized forms. **Sodium benzoate must never silently become benzoic acid because a predictor
prefers neutrals.**

Architecture: **parse once → preserve the source representation → derive explicitly named
interpretations → calculate against a specified interpretation.**

```ts
interface MolecularInterpretation {
  id: string;                     // "source", "largest-organic-fragment", "neutralized", …
  label: string;                  // shown in the UI
  sourceHash: string;
  interpretationHash: string;
  componentPolicy:
    | "whole-input" | "largest-organic-fragment"
    | "per-component" | "reject-multicomponent";
  explicitHydrogenPolicy: string;
  isotopePolicy: string;
  aromaticityModel: string;
  tautomerPolicy?: string;        // REQUIRED for tautomer-sensitive methods — see below
  protomerPolicy?: string;
  conformerId?: string;
  transformations: Transformation[];   // ordered ledger
}

interface Transformation {
  name: string; version: string;
  atomMapping: ReadonlyArray<readonly [sourceIdx: number, derivedIdx: number]>;
  componentsRemoved: string[]; componentsRetained: string[]; componentsNeutralized: string[];
  bondOrderChanges: number; aromaticityChanges: number;
  hydrogenChanges: number; tautomerChanged: boolean; chargeChanges: number;
  unrepresentableFeatures: string[];   // what the engine could not carry across
}
```

Three requirements that follow:

- **The atom mapping is load-bearing, not bookkeeping.** Per-atom results — a pKa site, an NMR shift, a
  highlighted substructure — must map back to the atoms the user actually drew. Without the mapping,
  every per-atom feature silently breaks the moment an interpretation reindexes. The existing
  `ConformerAtomMapping` discipline in `packages/chemistry-adapter` (tag before handoff, rebuild the map
  afterward) is the precedent to follow, not reinvent.
- **The active interpretation is inspectable and overridable in the UI**, per analysis: *"largest organic
  fragment · counterion removed — change"*. A transformation the user cannot see is a transformation
  they cannot catch.
- **`tautomerPolicy` is non-optional for tautomer-sensitive methods.** Wrong-tautomer NMR prediction is
  the classic silent-wrong-answer case. Enforce at the type level where possible, at registration time
  otherwise.

Cache keys become: source hash + interpretation hash + method + parameters + engine/model/data hashes.

## 2. Classification: three axes, and flags do the work

An earlier draft used a single `ScientificClass` enum. Its values overlapped badly — PM7 is
simultaneously a simulation and an empirically parameterized method; "convention-dependent" cuts across
masses, descriptors, identifiers, and simulations; a deterministic calculation can still be an empirical
prediction.

```ts
type DerivationClass =
  | "graph-derived" | "convention" | "fragment-rule"
  | "database-lookup" | "statistical-model" | "force-field" | "electronic-structure";

type ClaimClass =
  | "identity" | "composition" | "descriptor" | "prediction" | "simulated-observable";

type Determinism = "deterministic" | "seeded" | "stochastic";

interface ClassificationFlags {
  conventionDependent: boolean;
  experimentallyCalibrated: boolean;
  trainedOnExperimentalData: boolean;
}
```

**These enums are not perfectly disjoint either** — a fragment method *is* a statistical fit — and
chasing taxonomic purity here is wasted effort. So: **the enums are for display and grouping; the flags
are what code branches on.** Any behavior that depends on classification (warning banners, export
gating, "is this a measurement?" checks) reads the flags. Resist adding a fourth axis.

## 3. `AnalysisRun` plus a discriminated result union

Separate shared execution metadata from individual outputs.

An **`AnalysisRun`** carries source hash, the interpretations used, methods, engine environment,
timestamps, seeds, executable/model/data hashes, a deterministic run fingerprint, and status. It
contains results as a **discriminated union**, so each kind *requires* what it needs:

```ts
type AnalysisResult =
  | ScalarResult        // value, unit
  | IdentifierResult    // InChI, InChIKey, SMILES — stops masquerading as a property
  | CompositionResult   // formula, charge, per-element and per-component breakdown (see below)
  | DistributionResult  // isotope envelope: masses, intensities, truncation policy
  | SpectrumResult      // axes, units, sticks, broadening parameters
  | GeometryResult      // coordinates + atom mapping back to source
  | OrbitalResult       // grid, isovalue, basis
  | CorrelationMapResult;

type AnalysisStatus =
  | "ok" | "partial" | "unsupported" | "not-applicable"
  | "failed" | "cancelled" | "timed-out";
```

**`CompositionResult` is a recorded extension to the seven variants above.** Release 1's first
deliverable — source-preserving formula, charge, components, isotope specification — has no home among
them, and flattening per-element counts and a per-component breakdown into an `IdentifierResult` string
throws away exactly the structure that makes a salt legible as a salt. Added deliberately, noted here so
it reads as a decision rather than drift.

Also required: **structured unit identifiers** (not free strings), **multiple** uncertainty objects per
result, structured citations and dataset references, warning **codes** with severity and affected
outputs, random/conformer seeds, raw-artifact references, and **schema versioning with runtime
validation from day one** — matching the repo's existing Zod discipline
(`packages/chem-core/src/schemas.ts` is `.strict()` throughout).

`chem-core`'s `degradingEnum` is deliberately **not** carried over. It exists because a document read
from a foreign file must degrade an unrecognised arrow kind rather than fail the whole page; analysis
results are computed in-process, so degrading an unknown value there would turn a typo into a silent
`"unknown"`. Revisit only if a vocabulary gains an explicit `"unknown"` member — none does in Release 1
— and never for a result `kind`, which must fail loudly rather than be dropped (AGENTS.md §8a).

Two things to settle now rather than retrofit:

- **Payload transport — settled: typed arrays.** Bulk numeric channels (spectra, geometries, orbital
  grids, isotope envelopes) are `Float64Array`/`Int32Array`, which are structured-clone-safe *and*
  transferable; small fixed-arity data stays plain JSON. The rule is: anything whose length scales with
  atom count, grid size, or point count is a typed array. Decided in Phase 1 rather than after spectra
  exist, because JSON-serializing grids would force an ugly rewrite. This also satisfies the constraint
  the plugin runtime already imposes — everything crossing the panel bridge is structured-clone-safe.
- **Uncertainty will often be unknown.** Where redistributable experimental validation data is scarce —
  logP and pKa especially — several methods will ship `metric: "unknown"` plus a citation. The type
  permits it; plan for it rather than treating it as a gap to fill later.

**Sequencing:** land the result union and schema versioning with release 1. Grow the full `AnalysisRun`
layer when the first sidecar arrives — it is over-built for in-process descriptors.

## 4. Two parallel tracks

Earlier drafts made Phase 0 "blocking." That is over-broad: **licensing blocks distribution, not
engineering.** Run both concurrently.

**Distribution track (project owner's call; blocks release, not work).** Choose the core license —
`LICENSE` says licensing is unfinalized and the repo is not licensed for public redistribution,
`package.json` says `UNLICENSED`, and `AGENTS.md` describes the project as open source; these are
inconsistent. AGENTS.md §8a says explicitly that the root `LICENSE` is the owner's call and must not be
changed by an agent, so this branch **records** the inconsistency and does not resolve it. Set
plugin-distribution rules. Complete the dependency inventory: RDKit, InChI, OpenChemLib, the Avogadro
sidecar components, Eigen, freetype, and every vendored binary are **currently absent** from
`docs/architecture/dependency-inventory.md` (36 rows, zero chemistry-engine entries), though every
JavaScript UI package is there down to transitive licenses. Record exact version, hash, source URL,
license, notice files, local modifications, build flags, transitives, and bundled datasets or models —
then **generate** the acknowledgements view from it rather than maintaining it by hand.

Recording those inventory facts is ordinary engineering and happens on this branch (Phase 0). Choosing
the license is not.

**Engineering track, starting now.** Run and result schemas, the real RDKit adapter, the interpretation
ledger, the worker execution model, the regression corpus. None of this has a licensing dependency.
**Releases stay blocked until the distribution track completes.**

### nmrshiftdb2 is present-tense exposure

The NMR predictor **already ships** (standalone repo `~/programming/chemdraft-nmr-plugin`, trusted
update catalog entry `org.chemdraft.nmr.predictor`). This is not a longest-lead item to sequence; it is
live exposure to an unresolved interpretation.

The nmrshiftdb2 Database License requires software relying on the database to be OSI-approved *and* to
constitute functional end-user software, stating explicitly that open-sourcing a nonfunctional subset is
insufficient. The unresolved question is whether an MIT-licensed plugin that performs the prediction
**but can only run inside an unlicensed or proprietary ChemDraft host** satisfies that clause. Calling
the component a plugin does not settle it.

Required now:

1. Seek written confirmation from the **authorized licensor**, not merely a repository maintainer.
2. Set a decision deadline. **Owner input needed — this branch cannot pick the date.**
3. Define the contingency in advance: retrain on unencumbered data, gate the feature, or pull it.
4. Meanwhile, harden the defensive design — the plugin holds the actual prediction engine, data access,
   and result composition (not a shim over host-side logic); it is distributed independently; it can run
   in a documented generic host or standalone harness; and the database and its derivatives stay
   separately identified under their own data terms. AGENTS.md §8a already forbids describing a packaged
   plugin as "MIT" without the database carve-out; that stays true.

An Apache-2.0 core might ease the plugin-on-proprietary-host question, but that is speculation about an
unsettled interpretation — **do not let it steer the license choice.**

## 5. Execution and job architecture

A MOPAC optimization is not an analysis result; it is a **computational job that produces results**.
Model that distinction before quantum engines arrive.

**WASM worker.** Persistent, so the engine is not re-initialized per call. Cancellation and supersession
when the structure edits mid-calculation. Debouncing for interactive analysis. Memory and molecule-size
limits. Deterministic execution where the engine permits. A session cache on the §1 keys — nearly free,
and it is what makes the Analyze panel feel instant. The plugin runtime's `PluginWorkerBridge` is the
isolation precedent; core analysis runs in its own worker, not through the plugin bridge.

**Sidecars.** Per-job isolated temp directories. Argument arrays with no shell interpolation. Executable
identity and hash capture. CPU, memory, wall-clock, and output-size limits. Network disabled by default.
Controlled environment. Retention rules for input decks and outputs. Cancellation semantics that include
child processes. The Avogadro sidecar under `apps/desktop/src-tauri/binaries/` is the existing pattern
to extend, including its `pnpm audit:engine3d-sidecar` gate.

Runtime failures — SCF non-convergence, elements PM7 does not cover — map onto `AnalysisStatus` and
`applicability`, **never** onto prose warnings.

**Phase 4 build cost, scoped honestly.** Bundling MOPAC means per-architecture Fortran builds plus macOS
codesigning and notarization through `externalBin`. ChemDraft ships **macOS arm64 only** today
(`appcast.xml`: arm64, `minimumSystemVersion` 10.13; of the five sidecar files only
`avogadro3d-sidecar-aarch64-apple-darwin` is a real 1.1 MB binary — the Linux, Intel-macOS, and Windows
entries are 113–141-byte stubs), so scope the first MOPAC integration to macOS arm64 and treat
cross-platform as a separate, later cost rather than assuming three platforms up front.

## 6. Corrections register

Errors from earlier drafts, recorded so they do not reappear.

| Claim (wrong) | Correction |
| --- | --- |
| MOPAC is Apache-2.0 from **22.1.0** | **23.1.0** — verified against tags: `v22.1.0` ships `COPYING` + `COPYING.lesser` (GPL/LGPL-3.0 pair) and no `LICENSE`; `v23.0.3` still has no `LICENSE`; `v23.1.0/LICENSE` is Apache License 2.0. Pin ≥23.1.0 and archive that tag's notices. |
| MOPAC is "the only credible IR path at any license" | Overstated. xtb supports vibrational frequencies, Psi4 is LGPL-3.0, NWChem is ECL-2.0. Correct claim: *the most practical compact, permissively bundleable route to approximate vibrational spectra.* |
| PM7 frequencies need a universal **0.92** scaling factor | No such universal constant. Scaling depends on electronic model, target (harmonic vs observed fundamentals vs ZPE), and calibration set. Report unscaled-and-labeled, or apply a cited method-specific model with provenance and validation range. |
| NIST atomic/isotope data are public domain under 17 U.S.C. §105 | Too broad. NIST distinguishes ordinary federal works from **Standard Reference Data**, which can carry copyright, license terms, or foreign-rights restrictions. Record each dataset's title, version, endpoint, and terms. |
| An xtb subprocess "sidesteps LGPL entirely" | It weakens the combined-work argument; it does not remove obligations from redistributing an LGPL binary. Prefer detect-user-installed, or a separately downloadable component with a full compliance package. |
| FreeSASA covers Connolly surface and volume | FreeSASA computes **solvent-accessible** area (rolling-probe *center*). ChemDraw's Connolly outputs are **solvent-excluded** surface and volume. **Connolly SES/volume remains a gap.** |
| MM2 has no open implementation | **Tinker implements MM2-1991 and MM3-2000** — free for academic/nonprofit use, but not open source, restricts redistribution, commercial license required. Ship UFF/MMFF unless licensed. |
| Dimorphite-DL gives a numeric pKa with ± | It gives **site location**. Its file carries per-group mean and SD, but a group average is not a molecular pKa — every carboxyl gets the same number. Since measured: those averages score MAE 2.77 against 2.33 for predicting the dataset mean, so the shipped method takes atoms from the table and values from a model trained here (§8). |
| STOUT is wrong "roughly 10% of the time" | Unsupported by the cited sources — the rate was invented. STOUT is separately defunct (repo, weight buckets, Zenodo record, web app all 404/410) and its V2 labels came from OpenEye Lexichem. |
| Structure→name "is not shippable in 2026" | **Obsolete** — see §8. |
| MolGpKa ONNX export is a "~3–5 day spike, ~14 MB" | **Removed.** That specificity read as measured; it came from source reading, not a recorded export experiment. |
| "Published equations → no license needed" | Fine for independently implementing Wiener or Zagreb. **Not** a sufficient provenance statement for QSPR parameter tables, group definitions, reference code, or validation datasets. |
| Graph-derived HSQC/HMBC/COSY are "not a gap" | Overstated. HMBC depends on longer-range coupling and suppression conditions; COSY reflects scalar coupling, not graph distance. Ship as **candidate correlation maps**, never simulated spectra. |
| ESOL belongs in a plugin because it is empirical | **Self-contradictory** — that is exactly the rule §2 replaces. Small, permissive, stable, broadly useful models belong in core with full coefficient, domain, and uncertainty metadata. |

## 7. Engine findings

### The engines disagree; the fix is a documented method decision

| Molecule | tPSA (RDKit / OCL) | Rotatable bonds (RDKit / OCL) | logP (RDKit Crippen / OCL) |
| --- | --- | --- | --- |
| aspirin | 63.60 / 63.60 | 2 / **3** | 1.310 / 1.131 |
| sulfamethoxazole | 98.22 / **106.60** | **3** / 2 | 1.366 / **0.441** |
| caffeine | 61.82 / **58.44** | 0 / 0 | −1.029 / −0.178 |
| ethyl phosphate | 66.76 / **76.57** | 2 / 2 | 0.116 / **−3.193** |

1. **tPSA.** RDKit's `includeSandP` defaults to `false` and MinimalLib's `get_descriptors` exposes no way
   to set it, so every sulfonamide and phosphate reads low. Re-confirmed on this branch: sulfamethoxazole
   returns `tpsa` 98.22 with no parameter available on the binding. Fix the parameter, don't switch
   engines — see the patch-budget note below.
2. **logP is not one number.** A 3.3 log-unit spread on ethyl phosphate means these cannot be averaged or
   presented interchangeably. **The ordinary UI shows one documented default — Crippen logP.** Confine
   OCL's value to an expert comparison view; two prominent logP numbers read as replicated measurements.
3. **Rotatable bonds disagree in both directions.** The definition is a choice — name it in
   `method.parameters`, surface it in the tooltip.

### The MinimalLib patch budget

The vendor tree already carries **five** patches (`vendor/patches/0001`–`0005`, recipe in
`vendor/BUILD.md`). Release 1 adds a **sixth** for `includeSandP`. That is fine, but the budget is real
and worth tracking explicitly — a tenth patch is a maintenance smell, and every patch is a rebuild
obligation.

The alternative is implementing Ertl tPSA natively over RDKit's normalized molecule and SMARTS matching.
That is legitimate — it is a descriptor *on top of* RDKit, not a second molecular interpretation, so it
does not violate the rule below. **Recommendation: take patch #6.** It keeps RDKit authoritative for the
number and is less code than a maintained reimplementation. But record the patch count in the dependency
inventory and revisit if it grows.

### Derive composition from the interpretation, not a second implementation

Formula, formal charge, and elemental composition come from the **sanitized RDKit molecule under a named
interpretation** — concretely, from `mol.get_json()` plus `add_hs_in_place()` on a copy — not an
independent native graph walk. Computing a formula looks trivial until the structure carries isotope
labels, radicals, explicit vs implicit hydrogens, query atoms, pseudoatoms, unusual valences,
disconnected salts, or coordination bonds — and a second interpretation of valence and hydrogen counts
creates avoidable divergence from the engine used for every other descriptor. A native
isotope-*distribution* engine is sensible; a native molecular-*interpretation* engine is not.

This also retires the fixture table in `packages/rdkit-adapter/src/index.ts`: ten hardcoded SMILES with
hand-entered masses are a second implementation by another name.

### Prefer WASM over new native FFI

`apps/desktop/src-tauri/Cargo.toml` holds only pure-Rust crates plus `objc2` — no `cc`, `bindgen`, or
`extern "C"` precedent anywhere. IsoSpec is a small, dependency-light C++ library with a C API, and the
repo has a proven Emscripten lane. Reserve the sidecar pattern for programs with their own execution
lifecycle.

## 8. Dependency triage

### Core (in-process or already-bundled WASM), contingent on the final core license

Formula, formal charge, elemental composition · average, monoisotopic, and explicit-isotopologue masses ·
InChI/InChIKey · SMARTS matching · TPSA (`includeSandP` exposed) · Crippen logP and MR · HBD/HBA and
rotatable bonds (definition named) · ring, stereocenter, heavy-atom counts · Fsp³, kappa, chi, Hall-Kier,
Labute ASA · **ESOL** (small, permissive, stable — with full coefficient, domain, and uncertainty
metadata) · ETKDG, UFF, MMFF94.

Wiener, Balaban, Zagreb, eccentricity, and cyclomatic number are cheap once the descriptor pipeline
exists, but sit **below mass tooling** in priority absent demonstrated demand.

**IsoSpec** (BSD-2-Clause) could legally sit in core; placing it with the mass tooling is a product
decision. MMFF94 parameter provenance deserves a discrete compliance note but does not gate descriptor
work.

### First-party plugins — for product reasons, not licensing

¹H/¹³C NMR predictor (shipping, from its own repository — **§4 exposure applies**) · Joback/Stein-Brown
thermophysical (large method surface, applicability limits, parameter provenance) ·
protonation-state *enumeration* — the microstate-graph work, distinct from the per-site pKa that
landed in core (§8) · candidate HSQC/HMBC/COSY maps ·
OpenClatura structure→name · OPSIN name→structure.

**This list is a plan, not an inventory** — of the six, one ships and the rest are unbuilt. It is also
now one item shorter than it was: the **isotope-envelope and mass-analysis suite landed in core**, not
as a plugin, and Phase 5 argued the case deliberately (§8a's one-renderer rule is about the renderer,
not about pretending core analysis is a plugin). Plugins still reach that engine — `chemistry.compute`
serves it across the boundary — so the placement cost nothing.

### Sidecars and externally installed engines

**MOPAC ≥ 23.1.0** — bundleable Apache-2.0 sidecar, macOS arm64 first · **xtb** — user-installed or
separately distributed with full LGPL compliance · **ORCA, GAMESS** — detect only, never redistribute,
with an in-UI notice that the user's own license governs · **Psi4 (LGPL-3.0), NWChem (ECL-2.0)** — detect
only, too large for the base app · **Tinker/MM2** — do not bundle without a redistribution or commercial
license.

### pKa — shipped, by training our own rather than embedding someone else's

**Status 2026-08-02: shipped.** Every candidate below was rejected — on provenance, on deployability,
or on retrieval — and the way through was to stop looking for a model to embed. The open Dwar-iBond
labels are downloadable, so a model was trained here from them directly. What ships:

| | |
|---|---|
| site location | Dimorphite-DL's 41-entry SMARTS table, which contributes **no pKa value** |
| primary estimate | a 4-member message-passing network trained here on 12,096 per-site labels, **MAE 0.73** (Murcko folds), **1.13** on 398 external rows |
| second estimate | a Hammett LFER from the physical-organic literature — four series — **MAE 0.176** on the 227 sites it reaches |
| combined, where both fire | **MAE 0.168**, and the interval is 5.1x tighter than the model's at 92% coverage |
| per-site confidence | forest tree disagreement (r = 0.52) or, better, cross-method disagreement (r = 0.94) |
| metals | declined outright, on the measurement below |

Provenance is clean by construction: the supervised signal is measured pKa throughout, so no value
carries `inherited-from-another-predictor`. The reasoning that got here is preserved below, because the
rejections are the substance of the decision.

Three findings changed the code after it was written, and each is recorded where it applies:

- **A cross-validation split can flatter a model by 0.4 log units.** The published figure was 1.18 for
  months. Folds were grouped by canonical SMILES — which reads like a scaffold split and separates only
  identical molecules, 3,030 groups for 3,031 rows — so every congeneric series straddled the folds.
  Bemis-Murcko grouping gave 1,167 groups and MAE 1.62 for that same forest; external data it had never
  seen (Novartis + SAMPL, n=38) gave 1.24. The current model scores 1.04 on Murcko folds. The training
  script was not vendored, which is why nobody could read the grouping; it is now, with the correction
  written into its header.
- **An unexplained regression that gets rationalised is a defect that gets shipped.** Adding the second
  label source moved internal MAE the wrong way, 1.219 to 1.273, and the code comment explained it as
  the model shifting toward drug-like chemistry. It was not. 27.7% of the added labels pointed at the
  wrong atom — the site index was taken with explicit hydrogens present and the molecule was then
  written out without them — so the model was being taught that carbons in drug scaffolds have basic
  pKa values. The rationalisation was plausible, written down, and wrong. Correcting it: MAE 1.19 to
  1.04, and 1,137 "basic" labels on carbon and 325 "acidic" labels on protonless atoms both go to zero.
- **The site table cannot value what it locates.** Scored against 1,750 labelled sites, its per-type
  averages give MAE 2.77 where exactly one type matches — worse than the 2.33 of predicting the dataset
  mean. The table was already implemented and reporting numbers when this was measured; the numbers
  came out.
- **Averaging two methods is worse than the better one alone** (0.229 against 0.158). The consensus
  weights by each method's measured error instead.
- **Cross-method disagreement beats any single model's internal confidence** — r = 0.88 against 0.52 —
  which is the concrete argument for having a second method at all.

The candidates below remain **evaluation set, not approved list**; each would still need artifact-level
review of model files, training data, transitives, and redistribution rights before being embedded.

- **MolGpKa** (MIT code, ships weights). Blocked on provenance: the published model was trained largely
  on **ACD/Labs-calculated** pKa values from ChEMBL, with **Epik** used to identify acidic and basic
  sites. MIT code is not distribution clearance.
- **pKaLearn** (`MoitessierLab/pKaLearn`, **MIT**, pushed 2026-04-14, Python/conda) — ionizable site
  detection, site-specific prediction, iterative polyprotic handling, dominant-state generation, with
  author-acknowledged limitations around missed centers, tautomers, and training data. ⚠️ Its repository
  contains a **`MolGpKa_retrained/`** directory, so its provenance relationship to MolGpKa's
  ACD/Labs-derived labels must be checked explicitly — it may inherit the same blocker rather than
  resolve it.
- **Uni-pKa** (`dptech-corp/Uni-pKa`, **Apache-2.0**, last push 2025-04-01; public weights and datasets,
  microstate enumeration + learned free-energy model) — scientifically stronger, expects a
  Python/Uni-Mol environment.
- **QupKake** (`Shualdon/QupKake`, **BSD-3-Clause**, last push 2024-06-04) — GFN2-xTB features plus a
  GNN, micro-pKa, published in *JCTC* 2024 (`10.1021/acs.jctc.4c00328`). **Not on PyPI**: installed from
  source, and it pins `xtb == 6.4.1`, a native binary, on top of torch / torch-geometric /
  pytorch-lightning. Deployability is therefore a real evaluation axis for it, not a footnote.
- **pkasolver** (`mayrf/pkasolver`, **MIT**, last push 2026-05-20) — the older GNN generation. Its
  strongest model was transfer-learned against **Schrödinger's Epik** and *cannot be distributed*; only
  the weaker variant ships. A concrete instance of the blocker this section is about.
- **OPERA** (`kmansouri/OPERA`, **MIT**, last push 2025-07-03) — the EPA/NIEHS open QSAR baseline over
  the DataWarrior measured set. Government-funded and fully open, which makes it the natural *floor* to
  beat rather than a candidate to embed.

**The question that decides this is provenance, not licensing.** A licence governs whether we may ship
a file. What matters more here is stated three paragraphs down, as a requirement this section already
imposes on any pKa result: it must record *"whether the value is experimentally trained,
quantum-derived, or **inherited from another predictor**."* That third category is not a legal
classification. It is a statement about what a number is, and it is the one this branch exists to keep
honest.

A model trained on another model's outputs inherits that model's systematic errors. Its ceiling, on any
chemistry where the teacher was wrong, *is* the teacher's wrongness — and nothing in its output says so.
That is the same failure shape as OpenClatura dropping an arsonic acid and Joback summing around a
group it has no parameter for: confident, well-formed, and quietly describing something else.

**Both live candidates were read at artifact level on 2026-08-02, and they fall on opposite sides of
that line.**

*QupKake — **inherited from another predictor**.* Its three checkpoints ship in the repository
(`qupkake/models/*.ckpt`), so obtaining it is trivial. But its own `data/README.md` says the initial
pKa model was trained on `chembl_crest_combined_set.csv.gz`, whose columns are `cx_most_apka` /
`cx_most_bpka` over **1,551,870 ChEMBL rows** — "cx" is ChemAxon. Experimental data enters only at the
transfer-learning stage. So the base model was fitted to reproduce a commercial predictor across 1.5M
molecules, and a smaller experimental set then corrects it by an unknown amount in unknown places.
Shipping it would oblige us to label every value `inherited from another predictor`, which is accurate
and is also most of the argument against shipping it.

**The predicted blind spot was measured, and it is not "thin" — it is total.** Counting bracketed metal
atoms across every training and test set both projects ship:

| set | molecules | containing a metal |
|---|---:|---:|
| QupKake pretraining (ChEMBL, ChemAxon labels) | 1,551,870 | **0** |
| QupKake transfer set (experimental) | 5,637 | **0** (one arsenic, not a metal) |
| QupKake Novartis test | 280 | **0** |
| QupKake literature test | 122 | **0** |
| Uni-pKa finetuning (Dwar-iBond, experimental) | 8,232 | **0** |

The detector was checked against this repo's own corpus first — it hits ferrocene, cisplatin, sodium
benzoate, and calcium chloride, and passes over aspirin and benzene — because a surprising zero is
usually a broken instrument. It is not broken. **Across 1.57M molecules, neither model has seen a
single metal-containing structure**, in training or in test. The lone non-organic atom in either
project's experimental data is one arsenic — the same element that broke OpenClatura.

**Neither model has any way to say so.** Asked for the pKa of a metal complex, both will return a
number, extrapolated past everything they were fitted to, with nothing in the output marking it. That
is the failure this branch keeps meeting, now measured rather than predicted — and it means the
organometallic gap is not a coverage weakness to be improved at the margin but an absence of signal.
Any pKa capability shipped here must decline on metals outright; there is no evidence on which it could
do anything else.

*Uni-pKa — **experimentally trained**, but not simply obtainable.* Its ChEMBL stage is
`loss_func="pretrain_mlm"` — **masked language modelling, self-supervised over structures**, not
regression against someone else's pKa predictions. The supervised signal comes entirely from
`finetune_mse` on `dwar-iBond.tsv`: **8,232 rows carrying a per-row `ref.` column** ("DataWarrior index
5074", and so on) — experimental values with traceable attribution. That is the cleanest provenance
story of anything here. The cost is retrieval: the weights are not in the repository, only "available"
through a Bohrium notebook, with the datasets on AISSquare.

**So the two problems are different in kind.** QupKake's is what its numbers *are*; Uni-pKa's is
logistics. Only the second is the sort a request — or a retraining run on the open Dwar-iBond set,
which *is* downloadable — could dissolve.

**Accuracy claims for these are recorded as unverified.** Figures circulating for QupKake (RMSE 0.5–0.8;
"would have won SAMPL6/SAMPL8") and for Rowan's Starling are from prose, not from anything run here.
This branch's record on prose-shaped claims is poor — Joback's critical pressure looked entirely
plausible and was 2× wrong, and OpenClatura's "99% coverage" was real but meant something other than
accuracy. §9's gate is "model/data-license clearance **and external validation**"; nothing above has
passed the second.

*(Starling (Rowan) is noted and excluded: weights are not distributed, so it cannot be embedded whatever
its accuracy. Useful as a comparison point, not a candidate.)*

Dimorphite-derived functionality stays labeled **site location**. It contributes the atoms, never a
value — see the measurement above.

**Groundwork done 2026-08-02, and the implementation followed it.** Dimorphite-DL 2.0.2 (Apache-2.0)
installs and runs, and its site table was read at artifact level so that the implementation starts from
verified ground rather than from a plausible reading. It is **41 entries** in
`smarts/site_substructures.smarts`: name, SMARTS, then repeating triples of *(site index, pKa mean, pKa
standard deviation)* — two entries (phosphate, phosphonate) carry two sites each.

**The site index is the position in the match tuple, not the SMARTS atom-map number**, confirmed at
`protonate/site.py:251` (`idx_atom = self.idxs_match[pka.idx_site]`) after the two readings disagreed
on real entries. `Nitro` is the clean discriminator: index `3` selects the hydroxyl oxygen under the
positional reading and the carbonyl `=O` under the map-number reading. Getting this backwards would
have reported the wrong atom as ionizable for most of the table — a per-atom error with nothing in the
output to reveal it, which is the same class as Joback's `nA`.

Two further notes worth carrying: a `*` prefix on the name marks *"an aromatic nitrogen that needs
special treatment"*, and the file's own comments warn that **with recursive SMARTS RDKit counts only
the first atom as the match** — subsequent atoms define the environment, which shifts every position
after it.

**Why the table was worth having even before a value existed for it.** It is rule-based: SMARTS plus a
tabulated pKa range per *site type*. It has none of the training-data provenance problem measured above,
and on a metal complex it simply matches nothing — which is the correct answer rather than a silent
extrapolation. It kept its place once a real estimator arrived; what it lost was its numbers.

**Done:** the `IonizationResult` kind alongside `CompositionResult` — sites, atom indices, per-site
value and interval, `basis`, `ambiguity` when several site types claim one atom, `agreement` when two
methods do, `derivation` where a method can show its working, and `unassessed` for sites it knows exist
and refuses to score. Plus its zod schema, report rendering, and the run wiring.

Delivered against the richer output model this section asked for: microscopic pKa (each value is one
transition on one atom, never a molecule-wide figure), acidic-vs-basic stated as a *limitation* rather
than a field — the method reports acidity of the site as drawn and says so in capitals, because for
amines that is not the number most people want — solvent and temperature fixed at aqueous/room and
declared, and provenance recorded per value.

**The forest is gone; a graph network ships instead.** `pkaModel.ts` had said for months that "a GNN
would score better and could not ship", and the data reached the same wall from the other side: the
IUPAC weak-base labels are clean and they made every held-out figure worse, because a 60-tree forest
has nowhere to put them. Growing it recovers the accuracy and destroys the artifact — 1.114 cvMAE at 60
trees and 10 MB, 1.054 at 300 trees and 208 MB.

**"Could not ship" was about the RUNTIME, not the weights.** Importing PyTorch into a desktop app is
out; a network is not. The shipped model is 426k parameters in **4.5 MB** — smaller than the 6.0 MB
forest — and its inference is gather, scatter-add, matmul and ReLU, which is ~150 lines of TypeScript in
`pkaGnn.ts` with no framework and no second runtime.

| | forest | **network** |
|---|---:|---:|
| cvMAE, Murcko-grouped, same 12,096 labels | 1.023 | **0.728** |
| external, 398 rows never trained on | 1.239 | **1.129** |
| SAMPL6 matched one-to-one | 0.786 | **0.553** |
| — within 1 log unit of measured | 71% | **94%** |
| SAMPL6, right step count (assay window) | 4 | **10** of 24 |
| macroscopic, azoles | 0.620 | **0.21** |
| macroscopic, all 32 values | 0.354 | **0.330** |
| artifact | 6.0 MB | **4.5 MB** |

Two things fall out rather than being designed in. The network reads the graph, so `descriptors` is
empty — the whole-molecule mass/TPSA/logP channel through which a sodium counterion moved acetic acid's
answer no longer exists. And it learned amide N-H acidity at **14.97 ± 0.46** where the forest said
10.64 ± 5; the real value is 15–17.

**The parity fixture caught a design error of mine immediately**, which is the fifth Kekulé-dependence
in this model and the first caught before shipping. My bond features used bond ORDER, which is not
Kekulé-invariant: RDKit-python and MinimalLib choose different structures, so the same aromatic ring is
featurised differently. It failed on a quinolinium, TypeScript 4.284 against PyTorch 4.914. Aromatic
bonds now carry a flag with their order withheld; a non-aromatic order is invariant and kept. Bond-in-
ring uses the shared bounded cycle walk, not RDKit's ring perception, because biphenyl's central bond
joins two ring atoms and lies in no ring.

The interval comes from a 4-member ensemble — the same semantics as the forest's tree disagreement, so
the confidence rings, the titration-curve filter and the Hammett weighting read it unchanged. It tracks
error slightly less well than the forest's did, r = 0.42 against 0.52, and that is worth knowing.

**The electrostatic coupling has switched itself off.** Fitted against Dwar-iBond alone it chose W = 7
and was worth 1.36 log units on zwitterions; pKaCHU took it to W = 1 and 0.037; the network takes it to
zero, and every W above that makes the validation zwitterions monotonically worse — 0.32, 0.36, 0.44,
0.69 at W = 0, 0.5, 1, 2. The fit now switches the term off itself below a floor of 0.05 log units
rather than being hand-set, so if a future corpus makes it worth something again the fit will say so.
It was never physics the model could not learn: it was physics the LABELS did not contain, and then
physics the FOREST could not represent.

**The SAMPL6 metric was wrong and is fixed.** Pairing predictions to measurements by titration ORDER
stops being meaningful once a model reports a step the assay cannot see, and this one does: SM19
predicts 9.43 against a measured 9.56 while index-pairing scores its FIRST value, 2.11, against it and
records 7.45. That is the metric misaligning, not the model failing. Scoring is now one-to-one closest
matching with unmatched predictions counted separately, so a model cannot buy accuracy by emitting more
values. It reframes the residual cleanly: **valuation is excellent (0.52 MAE, 97% within 1) and
over-detection is the entire remaining problem** — 48 unmatched extra steps against the forest's 38.

**The IUPAC data was re-tested and is still out — for a different reason, which is the point.** The
capacity objection is gone: the network pays 0.003 cvMAE to hold those rows where the forest paid
0.060, against a harder baseline, and it gets BETTER on held-out external data (1.131 → 1.080) and finds
the right step count on 12 of 24 SAMPL6 molecules instead of 9. And it wrecks amino acids — glycine's
first macroscopic step reads **−0.55** against a measured 2.35, alanine −0.49 against 2.34, histidine
−3.32 against 1.85, taking the macroscopic zwitterion error from 0.46 to 1.65. A model that puts
glycine's carboxyl three log units under water is not shippable however good its average looks. The
**balance hypothesis was tested, and is half right — the other half matters more.** Taking the acidic
rows too brings the ratio to 0.767 against the core's 0.735 and halves the damage (zwitterions
1.65 → 0.89) while external accuracy improves again, 1.129 → 1.060. Still out at 0.89 against 0.32, but
the reason is no longer about this dataset.

Compare the two models site by site and they agree on everything an experiment can measure — acetic acid
4.30 both, glycine's CATION 2.29 against 2.19 (measured 2.35), phenol 9.92 against 9.96. They differ on
one thing: glycine's NEUTRAL form, **4.33 against 8.56**, where the real value is near 4.4.

That species does not exist in water. Glycine is a zwitterion, so nothing labels its neutral form and
nothing could have corrected the rebalanced model about it. **The fold builds it anyway** —
`pKa(n) = log10(Z(n)/Z(n-1))` sums over every microstate, populated or not — so macroscopic accuracy
rests on predictions no training set constrains, and adding well-labelled data can move them arbitrarily
while every labelled figure improves. External MAE got BETTER in the same run that made amino acids
worse, and that is not a contradiction: external tests labelled microstates, the fold requires unlabelled
ones.

This is what the electrostatic coupling term was introduced for years ago — "Dwar-iBond records only
microstates a titration can populate, never an amino acid's neutral form" — but as a standing fragility
of the METHOD rather than a gap in one corpus. The term is now zero because the network learned the
electrostatics; the exposure underneath it did not go away.

So the next lever is not another dataset. It is either labels for unpopulated microstates, which QM can
supply and experiment cannot, or a fold that does not need them. Two hypotheses were checked and
discarded on the way, recorded in `iupac_labels.py` so they are not retried: that the ingest selects for
mono-protic molecules (38.5% polyprotic against the corpus's 47.2% — too small), and that its acidic
labels drag predictions down (median 7.49 against 6.23, so they would push the other way).

**End-to-end accuracy, measured at last.** Every figure this method published was an ORACLE-SITE one:
the site and its direction supplied, so what was measured was how well a known site is valued. That is
the field's convention, and it also cannot describe what a user gets, because a user supplies a
structure and nothing else. `sampl6.real.test.ts` supplies a structure and nothing else, on the SAMPL6
blind challenge — 24 drug-like molecules, 31 measured macroscopic values, checked to share no skeleton
with any training row and one Murcko scaffold.

| | oracle-site | end to end (SAMPL6) |
|---|---:|---:|
| MAE | 1.02 | **2.03** |
| right number of titration steps | — | 4 of 24 |
| within 2 log units | — | 65% |

The gap is the honest measure of what is left, and it is not valuation — SM22's phenol reads 7.48
against a measured 7.43, SM10's amide 8.94 against 9.02. It is **over-detection**, and each cause was
chased with the same evidence gate the unactivated-amine rule set: does the corpus contain labels the
rule would suppress?

| candidate rule | corpus labels against it | shipped |
|---|---:|---|
| an N-substituted pyrrole-type ring N is not basic | 1 of 11,472 | **yes** |
| an amide N is not basic (blanket) | 35 of 11,472 (+22 amidine-like) | no |
| an UNACTIVATED amide N is not basic | 1 of 11,472 | **yes** |
| gate on the model's measured per-class accuracy | — | no, would not help |
| score only within the assay's 2–12 window | — | no difference, question closed |

The pyrrole one matters more than its SAMPL6 effect suggests, which is nil: the interval filter already
suppressed those particular rungs. What it fixes is **confident** fabrication — N-methylindole was
reporting a titration curve at pH 4.75 with an interval of 2.40, well inside the filter, for a molecule
with no basic nitrogen at all. Pyrrole protonates on carbon, near −3.8. N-substituted azoles are
everywhere in drug chemistry and no curated test had one.

The amide rule failed its gate twice as stated, and then passed once narrowed. "Unactivated" means the
nitrogen carries ONE carbonyl and nothing else but saturated carbon and hydrogen — the same idea as
`isUnactivatedAmine`. Acylaminothiazoles near 8.9 and acylsulfonamides near 4.9 keep their basicity;
acetamide, urea, N-methylacetamide and formamide stop inventing one. The single label it does suppress
is a bridged anti-Bredt lactam whose geometry really does pyramidalise the nitrogen. End to end:
MAE 2.22 → **2.14**, right-step-count 5 → 6, within 2 log units 58% → 61%, still answering all 24. The per-class gate was rejected on measurement rather than principle — every
class involved in the over-detection is one the model is decent at (1.1–1.4), and the badly calibrated
classes (sulfonyl oxygens at 4.65) never appear. The residual is site LOCATION, and no confidence gate
reaches it.

A fairness worry about the benchmark itself was also checked and dismissed. Pyrazine's second ring
protonation is genuinely near −5.8, the fold predicts it correctly at −2.4, and no UV-metric assay could
ever list it — so counting it as an "extra value" would penalise correct chemistry. Scored inside the
assay's own 2–12 window the figures are IDENTICAL, because the interval filter already removes every
out-of-window step. The extras are real over-detection.

**What the residual actually is.** Of 1,348 aromatic-nitrogen basic labels in the corpus, only 5.2% sit
below pH 2 — but most ring nitrogens in a real fused heterocycle do. The labels are selected for
measurability, so the model has seen very few examples of a nitrogen that barely protonates and pulls
them toward the mode near 5. SM11's four ring nitrogens all score 4–6 where one is 3.89 and three are
unmeasurable. That is a training-distribution problem, not a rule problem, and no suppression rule
reaches it — which is why the two attempts above were declined rather than forced.

**The data that fixes it was fetched, ingested, and measured — and does not ship.** The IUPAC
Dissociation-Constants compilation (Zenodo 21533589) is the right source: after filtering to neat water
at 20–30 °C, 11.5% of its basic labels are below pH 2 against our 5.2%, and it reaches −9.44. Its
inferred sites are sound — 2,509 of 2,510 match a trusted site — and its values agree with the existing
corpus on 79.6% exactly and 99% within one log unit. It also does what it was fetched to do: SAMPL6 gets
the right number of titration steps on 6 of 24 molecules instead of 4, and azole macroscopic error falls
0.62 → 0.42.

Every other held-out measure gets worse:

| corpus | cvMAE | external (398) | macro (32) | SAMPL6 MAE | right count |
|---|---:|---:|---:|---:|---:|
| core, 12,096 | **1.023** | **1.239** | **0.354** | **2.033** | 4 |
| + IUPAC basic, 13,565 | 1.083 | 1.264 | 0.583 | 2.119 | **6** |
| + all IUPAC, 15,194 | 1.114 | 1.262 | 0.493 | 2.262 | **6** |

A 65% rise in error on the macroscopic set — amino acids and diacids, the commonest chemistry there is —
does not buy two molecules on a step-count metric.

**The cause is capacity, and that was measured too.** cvMAE falls monotonically as the forest grows —
1.114 at 60 trees, 1.108 at 120, 1.080 at 200, 1.054 at 300 with unlimited depth — and the artifact goes
roughly 10 MB, 33 MB, 58 MB, 208 MB. This forest ships inside a desktop app and is parsed in a worker,
so 60 trees is near the practical limit. **The corpus has outgrown the model class**, which is the wall
`pkaModel.ts` already names: "a GNN would score better and could not ship."

`iupac_labels.py` stays in the tree, working, with the measurement in its header and its output off by
default. It is the first thing to revisit the moment inference is not a JSON forest parsed in a browser
— which is now the single highest-value change available to this method.

What was done meanwhile is narrow: a rung whose interval spans more than half the aqueous range is not
folded into the macroscopic curve, since such a rung locates no step. It is still reported with its
interval — nothing is hidden — but urea no longer gets a curve drawn through four values the model
cannot stand behind. End-to-end MAE 2.43 to 2.22, right-step-count 1 to 5, curated fifteen unchanged.

An earlier threshold taken from the model's own upper interval quartile was tried and REJECTED: it is a
property of the interval distribution, so a quarter of all sites exceed it by construction, and it
silenced acetic acid. A filter that silences acetic acid is measuring a histogram, not confidence.

**The benchmark found a crash on its first run.** `CIP_bonds` entries are flat triples
`[atom, atom, descriptor]`, not `[atoms[], descriptor]`, so the filter read an atom index as the
descriptor — never `"(?)"`, so always passing — and then called `.join` on a number. Every molecule with
an assigned double-bond stereocentre threw out of the entire analysis run; `C/C=C/C` was enough. It had
been wrong since it was written, and no chosen test molecule had an E/Z bond.

**Macroscopic pKa: done.** `protonation.ts` enumerates every protonation microstate, scores each edge
with the microscopic model, and folds the ladder into what a titration measures —
`pKa(n) = log10(Z(n)/Z(n-1))`, exact rather than fitted, verified against the analytic statistical
factors for equivalent sites. `vendor/pka-model/macro_validate.py` measures it against fifteen
polyprotic molecules with tabulated constants — run it to regenerate this table:

| | values | raw ladder | + coupling term | + tautomer exclusion |
|---|---:|---:|---:|---:|
| independent sites (diacids, diamines) | 18 | 0.33 | 0.33 | **0.33** |
| zwitterionic (both an acid and a base) | 10 | 0.45 | 0.37 | **0.28** |
| azoles (one proton, two heteroatoms) | 4 | 1.69 | 1.69 | **0.54** |
| everything | 32 | 0.54 | 0.51 | **0.34** |

Every column is regenerated by one script rather than quoted from an old run, which is why these numbers
move when the model does. Oxalic acid at 1.97 is the worst case anywhere in the set.

**The regression recorded here has resolved.** Correcting 1,462 mis-sited training labels took the
per-site model from MAE 1.19 to 1.04 but took this table the wrong way, 0.44 to 0.52 — noted rather than
explained away. Adding pKaCHU took it to **0.34**, better than either. The cause was the corpus:
Dwar-iBond records only microstates a titration can populate, so it never contained an amino acid's
neutral form, and the fold was being asked for a species the model had no evidence about.

**The electrostatic coupling has collapsed to noise, which is the same story from the other side.** It
existed because zwitterions scored 2.06 against 0.28 for everything else, and both halves of a scaffold
split independently chose W = 7. Refitted on the pKaCHU corpus the optimum is **W = 1**, worth 0.037 log
units, and the shipped W = 6 is now WORSE than switching the term off entirely. A hand-fitted physical
correction that buys 0.04 is not earning its place; it was compensating for absent labels, not for a
limit of the model. `coupling_fit.py` now runs inside `run_all.sh` and writes its own artifact — it
never did either, which is exactly how a parameter fitted to a corpus that had since been replaced went
on shipping.

**Azoles: the enumeration was building a species that does not exist.** Imidazole's two ring nitrogens
scan as independent sites — one drawn with a hydrogen, one without — so the enumeration happily
deprotonates the first while protonating the second. That is not a separate species; it is the proton
MOVING, giving the tautomer with the hydrogen on the other nitrogen. Reaching the real tautomer needs
the ring's double bonds rearranged, and all the enumeration does is assign charges, so what it built was
`c1c[nH+]c[n-]1` — an ylide the model scores at 6.95 where real neutral imidazole is 13.84. Seven log
units of a fictitious species, sitting in the partition sum. Excluding those microstates moved
imidazole's first macroscopic pKa from 3.28 to 6.83 against a measured 6.95, pyrazole from 0.00 to 3.42
against 2.49, and histidine's imidazolium from 2.82 to 6.45 against 6.00 — and left every molecule
without such a pair bit-identical.

**The zwitterion coupling is fixed, by adding the physics the labels could not teach.** The microscopic
model barely responds to a neighbouring charge — on glycine it shifts the carboxyl 0.6 log units where
the real effect is 2.6, and moves the ammonium the wrong way — because Dwar-iBond only records
microstates a titration can populate, never an amino acid's neutral form. A one-parameter Coulomb term
across acid/base site pairs, `dpKa = -W·q/d`, fitted against MACROSCOPIC values (an aggregate the
per-site labels do not contain), closes most of it. Both halves of a scaffold split independently chose
W = 7 with a flat optimum from 6 to 8.

Like-charge pairs get no correction, and that restriction is measured: ethylenediamine already scores
6.93/9.98 against 6.85/9.93 untouched, and applying the term there pushed the independent molecules
from 0.28 to 0.95.

Zwitterions stay flagged — still the weakest case, and worst where several acid/base pairs act at once
(glycine 0.38, alanine 0.18, histidine 1.73).

**Still open:** the two microstates each microscopic value connects (the ladder computes them but does
not surface them), and tautomer handling.

**OpenChemLib has no pKa predictor** — verified three ways; `pKaPredictor`/`pKaPlotter` are
DataWarrior-side, and `grep -ri pka` over the installed 9.22.1 package returns nothing.

### Structure→name — OpenClatura, conservative sequence

**OpenClatura** (`lamalab-org/openclatura`) invalidates the earlier "no viable option" verdict.
Verified: **MIT**, created 2026-05-08, pushed 2026-07-25, Python, and decisively **deterministic and
rule-based over RDKit with no machine learning**, producing an inspectable nomenclature decision trace
with optional OPSIN round-trip verification. Explicitly **beta**, covering "a broad slice" —
alkanes/alkenes/alkynes, common functional groups, simple heterocycles, fused/spiro/bridged systems,
Blue Book retained names — without enumerating what is unsupported.

Its reported **"PubChem/QM9/ZINC22 coverage is 99/97/100 %"** is **not** naming accuracy. Coverage
plausibly means a name was returned or that it round-tripped; neither establishes the name is preferred,
maximally systematic, stereochemically complete, or currently compliant.

Sequence, deliberately conservative:

1. **Benchmark the upstream Python implementation** on 1,000–5,000 curated structures, scoring
   separately: structural round-trip · correct stereodescriptors and locants · acceptable systematic
   name · preferred IUPAC name where known · unsupported structures **rejected** rather than misnamed ·
   salts, isotopes, fused/bridged rings, organometallics, zwitterions, multicomponent inputs.
   **✅ Done 2026-08-01 — `docs/benchmarks/openclatura-structure-to-name.md`.** 4,999 NCI structures
   plus a 26-entry adversarial set, round-tripped through the vendored OPSIN.
2. Analyze failures and upstream velocity. **✅ In the same report.**
3. Contribute fixes upstream. **← the recommended next step.**
4. Consider a Python sidecar.
5. **Port to TypeScript only if** the benchmark establishes enough product value to justify maintaining a
   second implementation of a still-developing nomenclature engine. Before any port, **inventory which
   RDKit APIs the rule engine touches against MinimalLib's surface** — every gap is another vendored
   patch, against the budget noted in §7.

**The benchmark's verdict: do not port, and do not ship it as a naming feature yet — but the gap is
narrow enough that step 3 is worth doing.** The engine is better than feared and fails in a worse
shape than feared, and both halves matter.

**Better than feared:** 98.7% of the names it produced round-trip exactly, stereochemistry is a genuine
strength (R/S, E/Z, meso, and ring stereo all exact), and it declines *every* metal — 38/38 Cu, 31/31
Co, 23/23 Hg, plus ferrocene, cisplatin, SeO₂. That is correct behaviour and deserves crediting.

**Worse in shape:** 36 structures (0.72%) got a confident, well-formed, OPSIN-parseable name for a
*different molecule*, and **14 of those name a smaller one** — seven arsenic compounds have the whole
arsonic acid group silently deleted, so `NC(=O)CNc1ccc([As](=O)(O)O)cc1` names as
"2-(phenylamino)acetamide". The adversarial set fails the same way: `[13CH3]C(=O)O` and
`[2H]C([2H])([2H])C(=O)O` both name as "acetic acid", and TEMPO names as its closed-shell
hydroxylamine. **The isotope case is the one this branch should recognise on sight** — it is exactly
what §8's envelope refused to do, committed in the naming direction.

**The specific defect is not inaccuracy, it is a misplaced boundary.** Arsenic never round-trips once
in 20 structures, so it is plainly unsupported — yet 14 decline and 6 are silently stripped. A tool
that declined all 20 would be usable with a documented gap. This one cannot tell you which case you are
in, and AGENTS.md §8a is explicit that a confident wrong answer is the more dangerous failure. That is
also why step 3 is attractive: the fix is "make unnameable features decline instead of dropping", not
"improve the nomenclature", and upstream is active (last push the day the benchmark ran).

Two provenance notes. **Pin by commit, not version** — pip installs `0.2.0` while
`openclatura.__version__` reports `0.1.5`, the same trap as IsoSpec's tag-vs-CMakeLists mismatch. And
*preferred IUPAC name where known* remains **unassessed**: a round-trip cannot establish it, and doing
so needs a reference set of preferred names this benchmark does not have.

OPSIN round-trip is a **structural-equivalence test**, not evidence of preferred-name correctness. Note
OpenClatura's own verification runs through `py2opsin`, which shells out to Java, so a ported path
carries the JVM question separately. **Publication-grade preferred IUPAC naming stays a gap.**

**The opposite direction is now built** (2026-08-01), after this file spent some time implying it
already was. `examples/plugins/opsin-name-to-structure` had been a **placeholder — one README, whose
own first line said OPSIN "is not installed or integrated"** — and that directory is gone, because the
plugin is real and lives in its own repository (`~/programming/chemdraft-opsin-plugin`), the same shape
as the NMR predictor.

**OPSIN 2.9.0 (MIT) is vendored by the host, not the plugin**, with a `jlink`ed Java runtime, because
there is no JavaScript or WebAssembly port of OPSIN anywhere and macOS ships no JRE. The engine runs in
Rust; the plugin reaches it through `chemistry.compute`, so there is one OPSIN in the product and no way
for a plugin to ship a second, worse name parser beside it. Details in
`apps/desktop/src-tauri/resources/opsin/BUILD.md`.

**It reports a structure; it does not draw one.** `proposePatch` takes a fully-formed object with 2D
coordinates, and laying a molecule out is the drawing application's job — so the plugin returns SMILES
and says so plainly rather than half-inserting something. Insertion needs a host structure-from-SMILES
capability, which is a host change and not this plugin's to make.

`advanced-style-pack` and `journal-style-pack` are still placeholders, and only `mass-fragment-demo` and
`molscribe-ocsr` are registered in `registerBundledPlugins.ts`. A directory named after a capability
reads exactly like that capability existing, so `tools/plugin-extract/examplePlugins.test.ts` now
requires every one to be either a real plugin or a self-declared placeholder.

### Other genuine gaps

Instrument-like 2D NMR simulation · credible ¹⁹F/³¹P/¹⁵N shift prediction · collision-energy-dependent
MS/MS · Connolly solvent-excluded surface and volume · IR/Raman/UV-Vis ML with a production runtime and
clean model/data licenses · redistributable MM2 · BioByte cLogP/CMR parity · logD vs pH (downstream of
pKa).

## 9. Rollout

### Release 1 — the tight scope

Source-preserving formula, charge, components, isotope specification · average, monoisotopic, and
explicit-isotopologue masses · InChI/InChIKey · named RDKit descriptors (TPSA with `includeSandP`
exposed, Crippen logP/MR, HBD/HBA, rotatable bonds, ring and stereo counts, Fsp³, kappa, chi, Hall-Kier,
Labute ASA) · a copyable/exportable provenance report · representation-invariance and unsupported-input
tests.

Underneath it: the result union and schema versioning (§3), the interpretation ledger (§1), the real
RDKit adapter replacing the placeholder, the persistent worker with cancellation and session cache (§5),
and the Analyze menu wiring — keeping the TS model and its native mirror in
`apps/desktop/src-tauri/src/lib.rs` (`build_analyze_submenu`, `MENU_COMMAND_IDS`) in step, as there is a
drift check.

### Release 2 — mass tooling

Isotope envelopes via IsoSpec, **with the truncation policy recorded in method provenance**, replacing
the first-order M/M+1/M+2 approximation in `examples/plugins/mass-fragment-demo/src/massAnalysis.ts:143`
· m/z and adduct tooling · fragment formulas and exact-mass bookkeeping with **no** intensity or MS/MS
claims.

OpenClatura, general pKa, MOPAC, Joback, expanded NMR, and correlation maps are **not dependencies of
either release.**

### Later phases

**Estimates.** Joback and Stein-Brown with method-specific uncertainty and unsupported-group reporting ·
protonation-state enumeration · NMR improvements · candidate 2D-correlation diagrams clearly
distinguished from simulated spectra. `AGENTS.md` §8a scientific-claim rules bind these.

**Joback landed 2026-08-02** — normal boiling point, critical temperature, critical pressure, and
critical volume, each with its own contract, RDKit SMARTS fragmentation, and Joback's published mean
absolute error carried as a real `Uncertainty`. Classified `fragment-rule` / `prediction`: an estimate
is not a descriptor, and filing one as such would put a ±13 K boiling point in the same table as a
computed ring count. Stein-Brown, protonation states, and correlation maps are still open.

**The unsupported-group half is the half that mattered**, exactly as §9 implies by asking for it.
Joback is a *sum over groups*, so a structure containing something unparameterised still yields a
number — describing a smaller molecule. The same failure the envelope refuses for isotope labels and
the OpenClatura benchmark found in naming, so it gets the same answer: every heavy atom lands in
exactly one parameterised group or the method declines. Phenylboronic acid and sodium benzoate decline
rather than reporting a boiling point for the fragment that happened to match, and `=NH` declines
separately because Joback publishes no Tb or Tc term for it — null is not zero.

**Validated against an independent implementation**, Caleb Bell's `thermo` (MIT), the same discipline
RDKit-vs-IsoSpec gives the envelope and OPSIN gives naming. It paid immediately: the first critical
pressure read Joback's `nA` as the heavy-atom count, giving n-octane **50.3 bar against the correct
25.35** — `nA` counts hydrogens. Both are plausible-looking critical pressures, so only a second
implementation catches it.

**Two things the wiring exposed.** The `source` interpretation declared four policies and left the
tautomer one implicit, so the registry refused to run any tautomer-sensitive method against it — and
Joback is genuinely tautomer-sensitive, since keto and enol acetylacetone have different group counts.
Fixed by *stating what was already true* (`as-drawn — no tautomer standardisation`) rather than
weakening the flag. And the corpus's C320 alkane turned whole runs `unsupported`, because Joback's Tc
denominator goes negative at that size — `thermo` returns a negative critical temperature there, so
declining was right and only the *status* was wrong. An out-of-range correlation is the method's domain
working, like a water loss from a molecule with no oxygen, so it is `not-applicable`; a missing
parameter stays `unsupported`, matching Crippen logP on sodium.

**Computational sidecars.** MOPAC ≥23.1.0 on macOS arm64 (heat of formation, ionization potential,
dipole, HOMO/LUMO, PM7 optimization, vibrational frequencies) · optional compliant xtb · detection
adapters for user-installed ORCA, GAMESS, Psi4, NWChem · the §5 job protocol.

**Experimental.** OpenClatura per the §8 sequence · general pKa only after model/data-license clearance
and external validation · Connolly SES/volume only after identifying or implementing the correct geometry
algorithm.

## 10. Verification

`pnpm test` (vitest) and `pnpm lint` (`tsc --noEmit`), plus `tools/plugin-extract/boundary.test.ts`,
which enforces that plugins import only `@chemdraft/plugin-api`.

**ChemDraw is not the correctness oracle.** Matching it can mean reproducing its conventions rather than
improving accuracy. Five layers:

1. **Engine regression** — pinned outputs from the exact RDKit/OCL/IsoSpec/MOPAC version, so a dependency
   bump is a visible failure, not a silent number change. **→ Phase 2**, because the pins are what make
   release 1's numbers reviewable.
2. **Method conformance** — published worked examples or independently implemented references.
3. **Experimental validation** — measured logP, solubility, boiling point, pKa, NMR shifts, where
   redistribution rights permit.
4. **Product comparison** — ChemDraw differences, each explained by method and parameterization.
5. **Representation invariance** — implemented as **property-based testing** over SMILES permutations,
   atom renumberings, Kekulé vs aromatic forms, and hydrogen styles. **→ Phase 1**, because this harness
   is what actually validates the interpretation ledger.

### The machine-readable method contract

Each capability declares one contract: public name · exact implementation and version · default
interpretation policy · units and conventions · supported and known-unsupported chemistry · validation
corpus with legal provenance · accuracy claims · conditions under which it declines · version-increment
triggers.

That single artifact generates documentation, tooltips, test fixtures, acknowledgements, and half the
result provenance — and it is what prevents the UI and the science from drifting apart.

### Corpus

Deliberately include salts, disconnected structures, zwitterions, radicals, isotope labels, S/P
compounds, boron and silicon, charged heterocycles, tautomers, organometallics, very large structures,
and unsupported atom types. **A predictor that returns a number for everything is more dangerous than one
that explicitly declines an out-of-domain structure** — `applicability.status`,
`AnalysisStatus.unsupported`, and `not-applicable` exist for this.

`packages/chem-core/src/corpus.ts` is a good pattern to copy but is scoped to 3D flatten cases; add a
sibling property corpus rather than extending it.

Confirm no GPL/AGPL package enters the core graph: `pnpm licenses list` for JS, `cargo tree` /
`cargo-deny` for Rust.

## Delivery sequence

Each phase is one independently green commit (code + tests together), in the house style of the toolbar
slice above. AGENTS.md binds throughout: §8a scientific-claim rules, §9 command registry, §10 chemistry
invariants, §13 testing requirements, and the Toolbar Button Contract (no decorative disabled buttons —
an Analyze item ships only when it computes something).

- **Phase 0 — Plan of record.** This PLANS.md section. Dependency-inventory rows for RDKit MinimalLib
  (version, patch count, build flags, BSD-3-Clause), InChI, OpenChemLib, the Avogadro sidecar
  components, Eigen, and freetype — facts only; the license *choice* stays with the owner (§4).
- **Phase 1 — Contracts. ✅ landed.** New `packages/analysis-core`: `MolecularInterpretation`,
  `Transformation`, the atom-mapping algebra, the §2 classification triple plus flags, the §3
  `AnalysisResult` discriminated union, `AnalysisStatus`, structured units, uncertainty, citations,
  warning codes, the method contract plus its registry, and schema versioning with `.strict()` Zod
  validation. Pure data — no engine import. Ships with the property-based representation-invariance
  harness and a `propertyCorpus.ts` sibling to `chem-core/src/corpus.ts`. 99 tests.

  The invariants the schemas actually enforce, since they are the part that has to survive review: a
  non-value status cannot carry a payload and `"ok"` cannot lack one; every non-ok status carries a
  warning; a seeded or stochastic method carries a seed; a convention-dependent method names its
  conventions and a calibrated one cites its parameters; `metric: "unknown"` cannot smuggle a number
  back in; a run cannot reference an interpretation it does not carry; and a tautomer-sensitive method
  cannot run against an interpretation with no `tautomerPolicy`.
- **Phase 2 — Real RDKit adapter. ✅ landed.** `rdkitAdapterStatus` is `"real"`; the ten-SMILES fixture
  table is gone. Parse and sanitize once; emit the `source` interpretation; derive composition from
  `get_json()`; masses, InChI/InChIKey, canonical SMILES, and 37 named descriptors, each behind a
  method contract. Engine-regression fixtures pinned to RDKit 2026.03.3 — exact values, so a vendor
  bump is a visible failure. `createRdkitAdapter` replaces `createRdkitPlaceholderAdapter` at
  `MainWindow.tsx`, which now passes molfile formats through instead of collapsing them to `"unknown"`
  and registers the WASM loader before the first analysis.

  **The decline rule, and why it is the phase's real deliverable.** RDKit answers every descriptor for
  every structure it parses, and some of those answers come from an unparameterised element taking a
  fallback: Crippen logP reads **−2.95 for sodium benzoate against +0.05 for the benzoate anion**, a
  three-log-unit swing produced entirely by sodium. Nothing in the engine flags it. So each contract
  declares `parameterizedElements`, and a structure carrying an element outside that set gets
  `unsupported` plus a warning naming the element — never a number. Crippen logP/MR and Ertl TPSA carry
  the organic set; every topological count is unparameterised and answers regardless, so ferrocene
  still reports its rings and its composition while its logP declines.

  Two findings from the phase worth keeping. The invariance harness caught RDKit's TPSA differing by
  7.1e-15 between two spellings of aspirin — summation order over fragment contributions, now stated in
  every real-valued descriptor's conventions rather than buried in a test tolerance. And the corpus
  parse check caught `C[n+]1ccnc1`, which RDKit rejects outright: every assertion on that entry had
  been passing vacuously.
- **Phase 3 — Interpretation ledger in anger. ✅ landed.** `largest-organic-fragment` and `neutralized`
  with real atom mappings and populated `Transformation` ledgers, per-analysis interpretation
  selection, and the sodium-benzoate regression as a first-class test.

  **A declined method now gets a second chance, and both answers stay in the run.** Sodium benzoate
  carries `rdkit.crippen-logp` → `unsupported` (Na has no parameters) *and*
  `rdkit.crippen-logp@largest-organic-fragment` → 0.0501, labelled "Crippen logP · largest organic
  fragment · Na removed" and carrying an `interpretation.derived` info warning. Nothing is substituted;
  the UI chooses which to lead with. `fallbackInterpretations: []` computes strictly against the
  drawing, and `interpretationOverride` is the "— change" affordance §1 asks for — overriding sodium
  benzoate to `neutralized` chains both steps and returns benzoic acid, C7H6O2, logP 1.3848.

  **Neither derivation re-decides chemistry**, which is what §7 demands. Component selection edits
  RDKit's JSON and hands it back to `get_mol`, which round-trips atom order, isotope labels, and CIP
  assignments exactly. Neutralisation *cannot* go through JSON — `impHs` there is authoritative rather
  than a hint, so zeroing charges yields a radical on every aromatic carbon — so it strips `M  CHG`
  from a V2000 molblock and re-parses, letting RDKit recompute the hydrogen count. That path also fails
  in the right direction: a quaternary ammonium and a nitro group both come back `null`, so the
  interpretation is reported unavailable rather than fabricated.

  Three details worth keeping. RDKit's `extensions` block is keyed to the original atom numbering, so a
  subset that carries it makes `get_mol` return null — it is dropped, and re-perception is RDKit's job.
  `chargeChanges` counts *atoms neutralised* rather than net charge, because a zwitterion's net is zero
  while two atoms changed. And when a discarded component is organic and no smaller than the one kept —
  ferrocene's second cyclopentadienyl — the ledger records that the choice was arbitrary.
- **Phase 4 — Worker and session cache. ✅ landed.** A persistent analysis worker
  (`apps/desktop/src/analysisWorker.ts`) keeps the 7.5 MB WASM resident for the session, and
  `AnalysisScheduler` in `analysis-core` owns the policy — debounce, supersession, cancellation, the
  session cache, and the size guards — so all of it is testable in Node against a fake transport that
  never loads a byte of WASM. Measured through the app's own loader: **311 ms cold** (including WASM
  instantiation), **30 ms warm**, **0 ms cached**.

  **Every outcome is an `AnalysisRun`.** §5 says runtime failures map onto `AnalysisStatus`, "never
  onto prose warnings", and that applies to scheduling too: a superseded request resolves with a
  result-less run of status `cancelled` carrying `analysis.superseded`, not a rejected promise. A
  caller that renders `run.results` needs no special case, and every one of these validates against
  `AnalysisRunSchema`.

  The organising idea is a **slot** — a thing being analysed, holding at most one live analysis. A
  second request for the same slot supersedes the first, because the user edited and the older answer
  is about a molecule that no longer exists. A superseded run that completes late is discarded and
  never enters the cache, which is the race that otherwise leaves a stale panel.

  **Two honest limits rather than one dishonest one.** Input length is checked before anything parses,
  and heavy-atom count in the adapter, which is the only layer that knows it. MinimalLib exposes no
  WASM heap cap, so bounding the molecule is what bounds worst-case memory — that is the enforceable
  proxy, and claiming a memory limit would overstate it. Cancellation is likewise cooperative and
  coarse: `analyzeStructure` is one synchronous WASM call per method with no yield point, so a cancel
  stops the *reply*, not the computation.

  Caught only by running it: `@chemdraft/analysis-core` was missing from the desktop app's
  dependencies. `tsc` resolved it through `tsconfig.base.json` paths and vitest through its alias
  table, so both passed while Vite could not resolve the import at all.
- **Phase 5 — Analyze surface. ✅ landed.** Analyze ▸ **Molecular Properties…** (`analyze.molecularProperties`)
  runs the suite through the Phase 4 worker and opens a panel. The command exists in the TS model, in
  `commands.ts`, and in the `lib.rs` native mirror (`MENU_COMMAND_IDS`, `build_analyze_submenu`); the
  existing drift check parses the Rust list and fails if the two disagree.

  **`buildAnalysisReport` is the deliverable underneath it.** §9 asks for "a copyable/exportable
  provenance report"; it lives in `analysis-core`, is engine- and UI-neutral, and renders to plain text
  and Markdown, so what lands on the clipboard is the artifact the tests pin rather than whatever the
  panel happened to draw. Sections group by `classification.claim` — the display side of §2's bargain,
  and the only place in the codebase a claim class decides anything.

  **Declined methods get their own "Not computed" section.** A report that omits what it could not
  compute makes "TPSA unavailable" indistinguishable from "TPSA not asked for", and §10 is blunt about
  which of those is dangerous. The status line counts both: *"Analyzed: 46 properties, 3 declined"*.

  **The panel is core-owned chrome around the shared `PluginReportRenderer`.** AGENTS.md §8a's
  one-renderer rule is about the renderer, not about pretending core analysis is a plugin — the command
  carries no `pluginId` and never enters the plugin runtime. The header carries §1's disclosure line,
  *"Computed on: largest organic fragment · Na removed — identity changed"*, with the ledger beneath it
  and a select that is the "— change": choosing another interpretation re-runs the same selection and
  replaces the report.

  Two display defects the live panel exposed and this phase fixed: masses rendered at full float
  precision (`144.01872368000002 Da`), now bound to the precision they are conventionally quoted to;
  and every row repeated the interpretation the header already stated, so the suffix is dropped when
  the whole report is about one interpretation and kept when a derived row sits beside a declined one.
- **Phase 6 — MinimalLib patch #6. ✅ authored and shipped.**
  `vendor/patches/0006-minimallib-tpsa-includeSandP.patch` adds an optional details JSON to
  `get_descriptors` and honours `{"includeSandP":true}` by recomputing **only** `tpsa` through RDKit's
  own `calcTPSA(m, force, includeSandP)` — every other descriptor stays exactly as
  `Descriptors::Properties` produced it. Verified to apply in sequence after `0001–0005` against a
  pristine checkout of the pinned commit. Patch count recorded as **six** in `vendor/BUILD.md` and the
  dependency inventory.

  **The artifact was rebuilt 2026-07-30**, clearing both pending reasons at once — `0006` and patch
  `0003`'s `useRandomCoords`, which had been outstanding since June 2026. Colima's default profile
  (6 CPU / 10 GiB) with the June deps image still cached made the compile ~14 minutes rather than the
  overnight job it was feared to be. `RDKit_minimal.wasm` is now `48b725a2…`; the `.js` reproduced
  **byte-identical**, because embind registers bindings at runtime from the wasm.

  Both patches were verified live by running one probe against the old and the new binary with nothing
  else changed — `CS(=O)(=O)C` tpsa 34.14 → **42.52** under the flag (previously 34.14 either way),
  sulfamethoxazole 98.22 → **106.60000000000001**, no other descriptor moved, and `generate_3d_embed`
  now returns different coordinates for `useRandomCoords` false vs true where before they were
  identical. The S-included 106.60 independently matches the OpenChemLib value the corpus was written
  against: the two engines never disagreed about chemistry, only about which table was in use.

  **The runtime still detects the capability by value, and that is not a stylistic choice.** Measured
  against the pre-rebuild binary, `get_descriptors('{"includeSandP":true}')` did **not** throw — it
  silently ignored the argument and returned the same `tpsa` 34.14 for `CS(=O)(=O)C`. Detecting by "did
  the call succeed" would have reported patch #6 as present and labelled an S-excluded number with the
  S-included convention, which is the exact failure this branch exists to prevent. Any future artifact
  that lags the patch set fails identically, so the probe stays. `detectEngineCapabilities` compares the
  number on a sulfone probe, and `rdkit.tpsa`'s contract follows it: version 2.0.0 with the S-included
  convention now that the artifact really honours it, 1.0.0 with "not selectable — see BUILD.md" against
  any binary that does not. Because the version is part of `methodKey`, the rebuild also invalidated
  every cached TPSA rather than serving old numbers under the new convention.

  **This is a visible change in shipped numbers.** Every sulfonamide, sulfone, and phosphate now reports
  a higher TPSA than the same build did yesterday — correctly, and with the convention disclosed on the
  contract, but users comparing against previously exported reports will see the shift.
- **Phase 7 — Release 1 closeout. ✅ landed.** The corpus is green across every adversarial category it
  declares, method contracts are complete for every shipped capability, and AGENTS.md carries the rules
  (§6.17 `analysis-core`, §8b the property-suite scientific-claim rules). The build stamp is generated
  from git, so there is nothing to hand-edit.

  **Three gaps the closeout found, none of which a feature test would have.** `oversize` and
  `stereochemistry` were declared corpus categories with no entries — a coverage gap that reads exactly
  like coverage — so the tag list is now a value and a test asserts every category has an entry. The
  acetylacetone entry was filed as `-enol` while carrying the keto SMILES; adding the real pair made the
  mislabelling visible, and the pair now demonstrates tautomer sensitivity (same formula, same
  heavy-atom count, different logP and HBD) rather than asserting it. And `closeout.real.test.ts` locks
  what no single feature test covers: every contract produces a result somewhere, every result has a
  contract, every corpus run is schema-valid, no result can claim to be a measurement.

  **The copyleft scan found one thing worth recording.** No GPL or AGPL in either graph, and the Rust
  graph is permissive-only — but `rollup-plugin-dts` is LGPL-3.0-only. It is a root devDependency used
  only by `scripts/build-sdk.mjs`, so it is not linked, bundled, or redistributed; "no copyleft" would
  have been an overstatement, so the inventory says so. Two packages whose licence pnpm could not parse
  (`eve-raphael` "Unknown", `font-face-observer` "BSD") were resolved from their own LICENSE files to
  Apache-2.0 and BSD-2-Clause.
- **Phase 8 — Release 2, mass tooling. ✅ all three clauses landed.**

  **Landed: m/z and adduct tooling, and fragment/exact-mass bookkeeping.** Nine electrospray adducts
  ([M+H]⁺ through [M−2H]²⁻) and seven neutral losses from the protonated ion, each with its own method
  contract, in an "Ions (m/z)" report section of their own. Verified live: aspirin gives [M+H]⁺
  181.0495, [M+Na]⁺ 203.0315, [M+2H]²⁺ 91.0284, [M−H]⁻ 179.0350.

  **Every mass comes from RDKit — no second mass table, and no invented electron constant.** Measured
  on the vendored build, `[NH4+]` is exactly one electron mass below NH₃+H, so RDKit's `[H+]` is the
  proton (1.00727645) rather than hydrogen. That makes `[M+H]⁺ = M + mass([H+])` and
  `[M−H]⁻ = M − mass([H+])` both correct with the engine's own bookkeeping, and the ion-component
  masses are read once per module and then only added and subtracted.

  **No intensity claims, and two kinds of decline.** The section is positions only. An adduct or loss
  is `not-applicable` for an already-charged structure (there is no neutral M for `[M+…]` to refer to)
  and a loss is `not-applicable` when the composition cannot supply it — gated on element counts only,
  which the contract states plainly: it will offer a water loss from a molecule whose oxygens are all
  ketones, because that check is arithmetic, not chemistry.

  **The isotope envelope: engine and wiring both landed 2026-07-30.** It needs per-isotope
  abundances, and neither the vendored RDKit nor OpenChemLib exposes any — checked directly, not
  assumed (see the dependency inventory). IsoSpec `v2.3.5` is now vendored at
  `packages/isospec-adapter/vendor/` (BSD-2-Clause, **unpatched**, 234 KB WASM), built through the same
  Emscripten lane as the Phase 6 rebuild and reusing that image purely as a toolchain. Its two
  truncation policies map straight onto `DistributionResult.truncation.policy`, and its monoisotopic
  peak for sulfamethoxazole (253.052112) agrees with RDKit's 253.05211 — two independent engines with
  different tables.

  `isospec.isotope-envelope` is now a method of the run. The contract lives in
  `packages/rdkit-adapter/src/envelope.ts` rather than in either adapter, and that placement is forced:
  the envelope needs RDKit's composition *and* IsoSpec's distribution, so neither engine owns it. The
  run names both engines and puts both artifact hashes in the fingerprint, so rebuilding either
  invalidates the cache. IsoSpec loads lazily — a run that does not ask for the envelope pays nothing —
  and if it cannot be loaded the method still appears and declines, because a capability that quietly
  vanishes is worse than one that says it is missing.

  **The envelope shipped with two declines; both were cleared on 2026-07-31 and neither by relaxing
  the rule that produced them.** Each had been stated as a reason rather than a gap, which is what made
  it possible to go back and answer them.

  *Charged structures now compute, as m/z.* IsoSpec's tables carry explicit `electron` and
  `missing electron` entries beside the 292 isotopic ones, so the correction is arithmetic on the
  engine's own numbers — no second mass table and no constant in TypeScript, the same rule the adduct
  masses follow. Each isotopologue loses z electron masses (gains them, for an anion) and is divided by
  |z|. **Dividing by |z| is the part that is not cosmetic:** at 1+ it is invisible, at 2+ the isotope
  spacing halves to ~0.4985, which is how a reader gets charge state off a pattern — reporting the
  ion's mass instead would draw 1.0 spacing and misstate the charge, self-consistently. Verified
  against RDKit, which does its own electron bookkeeping: acetate 59.013853, `[NH4+]` 18.0338255 — the
  exact structure §8's mass work used to establish that RDKit's `[H+]` is the proton. The two engines
  agree to ~1e-8, which is how differently they round AME rather than a disagreement about chemistry.
  The unit travels on the result (`thomson` against `dalton`), so no renderer infers the axis.

  *Labelled structures now compute too*, through IsoSpec's general `Iso` constructor, which takes
  isotopes rather than a formula. A labelled atom becomes its own dimension holding one isotope at
  probability 1; unlabelled atoms of the same element keep their natural-abundance dimension. **That
  per-position split is the whole point and it is checkable:** acetic acid's M+1 is 2.18% from two
  carbons, and 1-¹³C acetic acid's is 1.09% — the labelled carbon is ¹³C with certainty and contributes
  no satellite, the other still does. Dropping the label would say 2.18%; treating the element as
  labelled would say 0. The two follow-ups compose: a labelled anion computes on the m/z axis with no
  special case on either side.

  **The artifact was rebuilt for it** (2026-07-31, same `v2.3.5` commit, IsoSpec still unpatched), so
  the hashes moved and every pin with them. The wrapper validates array lengths, per-dimension
  normalisation, and probability range *before* constructing anything — IsoSpec walks the flattened
  arrays by a running sum with no bounds checking, so a short array is an out-of-bounds read inside the
  WASM heap that returns numbers rather than failing. The unlabelled formula path stays the default
  because IsoSpec resolves those element names itself and so cannot be narrowed by the symbol table the
  explicit path needs; a test pins the two routes together to 1e-12, and the in-image smoke test does
  the same before the artifact can be exported.

  **What still declines is a label naming an isotope the tables do not carry.** RDKit will report a
  mass for `[99C]` because it just adds mass numbers; there is nothing to convolve, and the alternative
  is a different molecule.

  The report renders the peaks as a spectrum with the truncation in its title, capped at 40 rendered
  rows (the result keeps every peak, and a capped table says so).

  **The mass-fragment demo's M/M+1/M+2 approximation is gone** (`a9892e1a`, 2026-07-31), and with it
  the repo's second abundance table. It could not simply import the engine — ADR-0028 §1 limits a
  plugin's runtime source to `@chemdraft/plugin-api`, which is *why* the approximation existed — so the
  fix was to fill in `chemistry.compute`, a permission declared since the API was written with nothing
  behind it. The host serves it through the ordinary analysis client, so a plugin's envelope and the
  Analyze panel's envelope are one computation and cannot drift. Chloroform is the case that shows why
  this was more than provenance: the real envelope is 100.00 : 95.99 : 30.71 : 3.28, and an
  approximation that stops at M+2 by construction silently omitted a **30.71% M+4 peak** — on the
  molecule the demo existed to showcase.

  **The abundance set is a convention and must be disclosed like `includeSandP`.** IsoSpec's tables
  carry no provenance in its own repository, so the defensible claim is "the values the shipped engine
  used" — which is why the wrapper exposes `isotope_table()` and the tests read it from the binary.
  Measured: 292 entries, every element normalised to 1, masses matching AME to ~1e-9, and ¹³C at
  `0.010788` against CIAAW's representative `0.0107` — 0.82% relatively higher, moving C₂₀'s M+1 from
  0.21400 to 0.21576. Not an error (CIAAW publishes carbon as an interval because it varies by source),
  but a reader reproducing the number from a textbook table will not match, so the contract must say so.
  There is now exactly one abundance table in the repository — this one, whose provenance is documented.
  The demo plugin's undocumented eight-element table was retired with the approximation it fed.

  One design flaw the new methods exposed and fixed: `aggregateStatus` let a single `not-applicable`
  result drag a whole run down, so aspirin reported `not-applicable` overall because it has no nitrogen
  to lose. A method that does not apply is its contract working, not a shortfall — `unsupported` still
  counts, because that is a real capability gap. The status line says "2 not applicable" rather than
  "2 declined" for the same reason.
- **Later phases** as scoped in §9 — estimates, computational sidecars, experimental. Not this branch's
  release gate.

## Verification commands

Per phase:

```bash
pnpm vitest run packages/analysis-core packages/rdkit-adapter packages/chem-core
```

At closeout:

```bash
pnpm lint
pnpm test
pnpm build
git diff --check
pnpm licenses list
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Launch through `./run-app` or `./run-app --dev` and confirm the worktree label in the window title and
build stamp reads `chemdraft-analyzers` before trusting a manual pass.

## Definition of done (Release 1) — verified 2026-07-30

- ✅ No `rdkitAdapterStatus = "placeholder"` and no fixture-backed analysis path outside tests.
- ✅ Every shipped number carries a method contract naming its implementation, version, interpretation
  policy, units, convention, and declining conditions — locked by `closeout.real.test.ts`, which also
  fails on a contract that never produces a result or a result with no contract.
- ✅ The active interpretation is visible and changeable for every analysis; per-atom results map back
  to source atom indices.
- ✅ Sodium benzoate reports sodium benzoate's formula, mass, and charge — and says so explicitly when
  a predictor asked for the organic fragment instead, keeping both results in the run.
- ✅ Out-of-domain structures decline (`unsupported` / `not-applicable`) rather than returning a number.
- ✅ Representation-invariance property tests pass over SMILES permutations, atom renumberings, Kekulé
  vs aromatic forms, and hydrogen styles — integer counts exactly, real values to 1e-9 with the
  summation-order sensitivity stated in each contract.
- ✅ Engine-regression fixtures are pinned to RDKit 2026.03.3 and fail on a vendor bump.
- ✅ The dependency inventory lists every chemistry engine, vendored binary, patch count, and bundled
  dataset, plus the closeout copyleft scan.
- ✅ `pnpm lint`, `pnpm test` (2269), `pnpm build`, the plugin boundary test, `cargo fmt --check`, and
  `cargo test` (47) are green.

**Engineering scope is complete, and the two named follow-ups are done** (2026-07-31). The envelope
computes for charged structures, on the m/z axis with the electron bookkeeping taken from IsoSpec's own
table, and for isotope-labelled ones, through the general `Iso` constructor the formula parser could
not reach. Both are recorded in the Phase 8 entry above. What still declines there is a label naming an
isotope the tables do not carry — a decline with a stated reason, like the two it replaces.

**Releases stay blocked on the distribution track** (§4): the core licence, the nmrshiftdb2 deadline,
and the plugin-distribution rules are the project owner's calls, not engineering's.

*(Every item this section once listed as build-blocked has landed: the MinimalLib rebuild carrying
patches `0003` and `0006` and the first IsoSpec build on 2026-07-30, and the IsoSpec rebuild adding the
explicit-isotope entry point on 2026-07-31. Nothing is waiting on Docker.)*

## Open items owned by the project owner

Two of the three were settled on 2026-07-31; one remains, and it is not an engineering task.

1. ✅ **Core license — Apache-2.0**, chosen by the project owner. Applied to `LICENSE` (full text),
   `package.json`, and AGENTS.md §8a/§8c, with a `NOTICE` file carrying the attributions Apache-2.0 §4(d)
   obliges a redistributor to pass on: RDKit (BSD-3-Clause), IsoSpec (BSD-2-Clause), and the statically
   linked InChI. The example plugins and the two SDK packages stay MIT — a permissive core never
   required them to match.
2. ✅ **Plugin-distribution rules — written** as AGENTS.md §8c, with a mechanical gate
   (`assertBundledDataLicensed`) that refuses to build a distribution whose package ships a dataset while
   declaring only a code licence. The rule is a *labelling* obligation, not the licence-inheritance rule
   it is often mistaken for: permissive licences never require a plugin to adopt the host's terms.
3. ⏳ **nmrshiftdb2** — the authorized-licensor confirmation and a decision deadline.

   **The Apache-2.0 choice substantially changes this item and it should be re-read, not carried
   forward as written.** The clause requires software relying on the database to be OSI-approved and to
   constitute functional end-user software. The awkward reading was an MIT plugin that could only run
   inside an **unlicensed** host — and that host no longer exists: the core is now OSI-approved,
   functional, end-user software. What remains is a confirmation worth *having*, not a live exposure,
   and the defensive design in §4 (the plugin owns its engine and data, is distributed independently,
   runs in a documented generic host, and names the database under its own terms) is unchanged and
   still holds. Whether to seek written confirmation, and by when, is the owner's call.

---

# Landed on `main` before this branch (context, not scope)

The records below describe work already shipped on the trunk. They are preserved verbatim so merging
this branch does not drop them.


## Host-managed plugin updates (2026-07-25) — on `main` (PR #21, merge `a7c88a69`)

A concurrent session's implementation was ported file-by-file rather than merged: its branch forked
before the toolbar slice, so taking its tree would have reverted eight commits of tool wiring. It
landed on `main` alongside the toolbar slice through PR #21. Only two things were carried forward
from an earlier parked snapshot, both reworked.

(Every branch involved — the concurrent session's, the parked snapshot's, and the shared feature
branch — has been deleted. PR numbers and commit SHAs are the durable references; branch names are
not, so this file names them only where one still exists.)

Ported forward from the parked snapshot:

- `pruneOrphanedPluginPackages`, which reclaims checksum-addressed directories left by a failed
  update or an incomplete cleanup. Its first version keyed off "no records", which
  `loadInstalledPluginRecords` also returns for an unreadable, truncated, or partially-invalid
  catalog — so a momentary IO problem would have deleted a healthy install's payload. The catalog
  now reports `absent` / `loaded` / `unreadable`, and the sweep acts only on the first two.
- The published `.sha256` is fetched and must agree with the digest GitHub recorded for the asset,
  which makes the existing sidecar-must-exist rule mean something. It reuses the same bounded,
  redirect-validating download path as the package, so it is size-capped while streaming rather
  than after buffering, and accepts the uppercase digests Windows publishers produce.

Fixed in the incoming implementation:

- `uninstallPlugin` validated the recorded staging path *after* unregistering the plugin, so a path
  the validator rejects left the plugin gone from the session but still in the catalog — an
  unremovable ghost. Validation now happens before any runtime state changes.
- Rollback re-activated the superseded descriptor even when it had never been deactivated, which
  could throw and abort the rollback, leaving the host registered against a candidate whose
  directory was about to be deleted.
- A disabled-plugin update tore down only the candidate, leaving the old worker running against
  files that were then removed.
- The trusted redirect host was spelled out in both TypeScript and the capability file with nothing
  keeping them in step; a test now pins them together, since GitHub has moved that host before.

### Objective

Add a separate, user-initiated plugin update path to the existing Plugin Manager. ChemDraft owns
the update source, download, package verification, worker handshake, replacement transaction, and
rollback. Plugins remain sandboxed and receive no new network, filesystem, or native-execution
capabilities. Sparkle continues to update only the ChemDraft application bundle.

The first trusted catalog entry is the standalone NMR Predictor plugin
(`org.chemdraft.nmr.predictor`). A check must distinguish update available, up to date, unsupported,
and failed states without silently installing anything. Applying an offered update requires an
explicit user action and must show the target version and package-integrity details.

### Safety and compatibility contract

- Update metadata is host-owned and allowlisted by plugin id; an installed plugin cannot choose its
  own download URL.
- Remote version and checksum metadata are treated as untrusted input and validated before use.
- The downloaded archive must pass the existing SHA-256, CRC/path, strict manifest, API-version,
  permission-review, and worker-handshake gates.
- The archive manifest id must match the installed plugin id, and its version must be strictly newer.
- Replacement is transactional: keep the current package and registration usable until the new
  package has passed staging and handshake, then commit the new package and record. Any failure
  restores the old package, record, registration, and enabled/disabled preference.
- Update checks and installs are user-initiated in this slice. No background polling, silent
  download, silent install, or restart-time mutation.
- A checksum proves integrity only, not publisher identity. The UI and documentation must not call
  an unsigned package cryptographically signed or fully automatic; publisher-signature support is
  a separate follow-up.

### Verification

- Focused tests cover catalog allowlisting, metadata parsing, semantic version comparison, download
  checksum enforcement, manifest-id/version enforcement, successful replacement, rollback, and
  disabled-plugin preservation.
- Plugin Manager DOM tests cover checking, up-to-date, available-update, progress, confirmation,
  success, and error states.
- Run `pnpm lint`, `pnpm test`, `pnpm build`, `git diff --check`, and the relevant Rust checks when
  native code changes.
- Launch this worktree through `./run-app` or `./run-app --dev` and verify the visible worktree
  label in the window title and build stamp matches the branch you meant to test.

## Sparkle macOS updates (2026-07-24)

The desktop app uses Sparkle 2 to check the signed macOS appcast automatically and offer newer
versions through Sparkle's native UI. File > Check for Updates… triggers a visible user-initiated
check. Sparkle replaces the application bundle only; installed plugin packages remain in the stable
Application Support `installed-plugins` directory and are revalidated by the normal runtime after
relaunch. Plugin/API incompatibility remains the plugin author's responsibility and must not block or
rewrite an app update.

## Runtime union merge (2026-07-16, merge commit `1232a444`)

The plugin program (M1–M36: plugin runtime, NMR/mass analyzers, worker isolation, packaging,
installer, manager) merged into the trunk per ADR-0030: trunk = `main`, plugin architecture = the
plugin program's, with main's four unique plugin pieces (stable command registry,
toolset-contribution stage, disk-backed plugin storage, patch-review tray) ported onto that runtime
and one unified panel renderer serving both the in-app surface and floating panel windows. That
program's full plan and milestone records live in the planning workspace
(`~/Documents/programming/Chemdraw-NMRplugin`) and in `docs/nmr-plugin-planning/`; they are not
duplicated here. Remaining plugin-separation work (publish the SDK, strip bundled NMR,
from-zero install test) is queued there as PLAN-plugin-separation Phases 2+.

The sections below are the trunk's active plan.

## Rings Toolbar and Molecule Inspector Tabs (completed 2026-07)

The Rings/Structure/Atom Labels slice shipped: ring appearance lives in its own compact
`core.ringInspector` toolbar, and the Molecule Inspector carries Structure and Atom Labels tabs with
multi-molecule targeting, mixed values, sparse per-atom overrides, `.cds` style-sheet import through
the style compatibility boundary, `.template` export, and a shared font catalog backed by the raster
export font database. Durable schema and architecture notes live in
`docs/architecture/toolbars-and-toolsets.md` and `packages/toolset-registry/README.md`.

# Toolbar Wiring and Honesty (2026-07-25) — on `main` (PR #21, merge `a7c88a69`)

Status: all eight phases implemented and hardened across two review rounds, landed together with the
plugin-updates slice above. `TRANSITIONAL_STUB_COMMAND_IDS` is empty — shipped toolsets contain zero
permanently disabled buttons.

An external review plus three adversarial passes found roughly nineteen defects in the first cut of
this slice. All five P1s and the P2s are now fixed with regression tests: imported structures keep
an honest `structureFormat` when edited; CDXML arrows use the real `ArrowType` spellings both ways;
arrow resize transforms the endpoints, not just the frame; axis-aligned arrows get a frame that
contains their glyph; formula text distinguishes a charge magnitude from an atom count and keeps
span styling; Escape cancels an in-flight placement instead of arming it; brackets and arrows are
painted once; brackets and curved art warn when they degrade in foreign CDXML; chains stop at the
page edge and rebuild in one pass; stamps centre on the click and clear stale interaction state;
arrows and orbitals can start on top of an existing object; and the Customize gallery offers
neither transitional stubs nor the compat-only art variants.

A second max-effort review over the combined branch found fifteen more, all now fixed with
regression tests. The four that mattered most: the plugin-update capability scope listed the package
`.zip` but not the `.zip.sha256` fetched right after it, so trusted updates could never complete —
the guard test had only checked that the `.zip` pattern *existed* rather than matching real URLs
against the compiled patterns; rotating a reaction arrow applied the angle twice, because the
anchors were rotated and `rotation` incremented while both renderers apply that transform
themselves; flipping never touched arrow anchors at all, so a mirrored scheme kept every arrow's
original direction; and the formula body pattern backtracked exponentially — measured at 8.8 s for
26 digits, doubling per digit — so a pasted numeric label froze the UI thread. The rest covered
plugin-update failure paths that lost catalog records or deleted live payloads, a chain that could
seed a bond-less carbon at a page edge, CDXML inventing `FullHead` for an unrecognized arrow, and a
Customize gallery that keyed off the user's own layout and so deleted any art tool they removed.

Known remaining gap: the Art inspector still styles only graphics and molecules, so Color Controls
and Object Settings route a bracket or arrow selection to a status message rather than a working
panel. Widening `ArtInspectorStyleObject` is its own slice.

## Objective

An audit found 32 non-functional toolbar buttons/commands: 8 drawing-tool stubs hardcoded to
"Requires an active structure editor" (`apps/desktop/src/drawingTools.ts`), 15 manifest-only stubs
with no live handler (`apps/desktop/src/toolsets/desktop-toolsets.json`), 4 orphaned
`view.toolset.*` customization commands and 4 unwired `style.*` commands
(`apps/desktop/src/commands.ts`), and the Customize gallery offering all of them for drag-out. Two
documented policies conflicted: the older contract tolerated disabled-with-reason placeholders,
while `docs/architecture/native-art-toolbar-chrome-plan.md` mandates hide-don't-disable.

This slice adopts the strict policy repo-wide and wires real functionality wherever existing
infrastructure supports it. After it, shipped toolsets contain zero permanently disabled buttons:
every visible button performs its action, and `disabledReason` is reserved for transient,
state-dependent unavailability (selection-dependent commands and similar).

Key mechanic: `apps/desktop/src/toolsets.ts` merges live `CommandSpec`s over manifest items, so a
live command's enabled state and `disabledReason` win. Un-stubbing means registering live behavior;
the JSON `disabledReason` strings are only fallbacks for commands with no live spec.

## Command retirements (the narrow, explained fix)

These command IDs are retired in this slice. Retirement is deliberate and documented here per the
AGENTS.md command-ID stability rule; each can return via git when its feature slice lands.

- `view.toolset.resetLayout`, `view.toolset.resetAllLayouts`, `view.toolset.createUserToolset`,
  `view.toolset.cloneToolset` — the Customize Toolbars dialog performs these actions directly
  through `layoutStateEdits.ts`; the standalone command entries were dead redirects.
- `style.bondStroke`, `style.textSize`, `style.preset.synthetic` — reasonless disabled stubs with
  zero references; superseded by the live style widgets and Molecule Inspector.
- `style.importStyleSheet` — redundant: the Molecule Inspector already imports `.cds` style sheets
  through the style compatibility boundary.
- `tool.mechanismArrow` — mechanism arrows need a real subsystem (atom/bond anchoring, curved
  geometry, half-head markers, renderers, CDXML mapping; `packages/mechanism-tools` is a type stub).
  Deferred to its own future slice; no decorative button meanwhile.
- `tool.templateGrid` — the template library (`packages/template-library`) is an empty stub; a
  template corpus plus grid-picker UI is its own future slice.
- `tool.arrows` — pure duplication of `tool.reactionArrow`'s command-grid submenu.
- `tool.toolOptions` — no defined behavior; lived only in the hidden `core.style` toolset.
- `tool.shape` — manifest items re-point to the live `tool.art.rect` command (shared `Art_Shapes`
  asset per the one-asset-per-command rule); the vague duplicate ID retires.
- `tool.shapeShadow` — retired outright: shadow art variants (`tool.art.rectShadow`,
  `tool.art.circleGloss`, …) are deliberately compat-only and stay out of shipped toolbars; shadow
  styling is applied through the Art inspector's effects.

`surface.canvas.addPageAfter` stays as disabled metadata: the surface registry does not drive
rendered UI (PLAN.md 6.15 sanctions it explicitly — "may exist only as disabled metadata until
`document.addPageAfter` is implemented and wired").

## Disposition of all audited items

| Disposition | Items | Phase |
| --- | --- | --- |
| Wire | tool.atom, tool.settings, style.color, tool.dagger, tool.symbol | 2 |
| Wire | tool.reactionArrow, tool.resonanceArrow, tool.equilibriumArrow, tool.retroArrow | 3 |
| Wire | tool.lobe, tool.shadedLobe, tool.pOrbital, tool.sOrbital | 4 |
| Wire | tool.bracket, tool.squareBracket | 5 |
| Wire | tool.chain, style.formulaText | 6 |
| Re-point | tool.shape → tool.art.rect | 2 |
| Retire | tool.shapeShadow (shadow variants are compat-only; Art inspector effects own shadows) | 2 |
| Retire | mechanismArrow, templateGrid, arrows, toolOptions, importStyleSheet, bondStroke, textSize, preset.synthetic, 4 × view.toolset.* | 1 |
| Keep | surface.canvas.addPageAfter (non-rendered metadata) | — |

## Design decisions

- **Arrows are semantic objects.** The four wired arrow tools create `reaction-arrow` document
  objects (`packages/chem-core`), not art graphics: the semantic type already has canvas rendering,
  selection/move/transform support, SVG export, and CDXML export+import. Art-route arrows would make
  tool-drawn and CDXML-imported arrows different object types. `arrowKind` gains `"resonance"`
  (additive; round-trips verbatim). Head geometry gets one shared plan in `packages/layout-engine`
  (`planReactionArrowGeometry`: forward filled head, equilibrium harpoon pair, retrosynthesis open
  double-shaft, resonance double-head) consumed by both the canvas renderer and SVG export.
- **Unwirable remainder is deleted, not hidden.** No new schema `hidden` field, no seeded layout
  state. Deletion is git-reversible and keeps exactly one honesty mechanism.
- **The Customize gallery excludes permanent stubs** using a static manifest-derived set (specs from
  `getToolsetCommandSpecs()` are availability-independent) — never live `enabled === false`, which
  would wrongly hide transiently disabled commands like Undo and the align/boolean family.
- **Chain uses press-drag rubber-band**: one gesture, one undo entry, no modal click-state machine.
  Segment count from drag length / `bondLengthPx`; zig-zag `±(180 − chainAngleDegrees)/2` about the
  drag axis, with `chainAngleDegrees` resolved from the target molecule's style.

## Delivery sequence

Each phase is one independently green commit (code + pinned-test updates together). The
"expected stub set" test introduced in Phase 1 asserts the exact remaining stub command IDs and
shrinks every phase, reaching empty in Phase 6 and locked by a policy test in Phase 7.

- **Phase 0 — Docs.** This PLANS.md section; AGENTS.md Toolbar Button Contract and §9 updates;
  PLAN.md §6.11/§6.13 updates; build stamp.
- **Phase 1 — Cleanup.** Delete the retired commands (`commands.ts`, `drawingTools.ts`,
  `desktop-toolsets.json` including the two retired IDs inside `tool.reactionArrow`'s submenu);
  gallery stub filter at the `MainWindow.tsx` call site; rewrite the placeholder-count test into the
  exact-stub-set test; update customize-command, chrome-cluster, and manifest-position tests; add a
  gallery-exclusion test.
- **Phase 2 — Quick wires.** `tool.atom` activates the existing atom-label editor on atom click;
  `tool.settings` toggles the Molecule Inspector toolset; `style.color` opens the existing
  object-color controls for the selection; shape/shapeShadow manifest re-points; `tool.dagger` and
  `tool.symbol` become glyph-stamp tools (one text object per click, command-grid submenu of common
  chemistry symbols).
- **Phase 3 — Arrows.** Enum + CDXML import case; shared geometry plan; canvas + SVG renderers on
  the plan; `insertNativeReactionArrow` with click-place and drag-place; enable the four tools.
- **Phase 4 — Orbitals.** Four parametric art-shape rows (teardrop lobe, gradient shaded lobe,
  mirrored two-lobe p orbital, radial-gradient s orbital) with their chemistry command IDs; the art
  pipeline provides pointer handling, transform chrome, and SVG export for free.
- **Phase 5 — Brackets.** Shared `bracketGlyphPathD` generator moves into `layout-engine`; real SVG
  export fragment replaces the labeled-box fallback; `insertNativeBracket` click placement; canvas
  glyph consumes the shared generator.
- **Phase 6 — Chain + formula text.** `planNativeChain`/`applyNativeChainPlan` press-drag tool with
  live preview, Esc cancel, single history entry; `style.formulaText` becomes a one-shot formatting
  command (element-trailing digits → subscript, trailing charge → superscript) over selected text
  objects.
- **Phase 7 — Closeout.** Policy lock test (zero permanently disabled specs in shipped toolsets;
  gallery exclusion holds); usage-hint invariant covers every definition; final stamps.

## Verification

Per phase:

```bash
pnpm vitest run \
  apps/desktop/src/App.test.ts \
  apps/desktop/src/drawingTools.test.ts \
  apps/desktop/src/toolsets.test.ts \
  apps/desktop/src/commands.test.ts \
  apps/desktop/src/documentWorkflow.test.ts \
  apps/desktop/src/toolbars/CustomizeMainToolbar/galleryModel.test.ts \
  packages/layout-engine/src/index.test.ts
```

plus `packages/chem-core` and `packages/cdx-compat` suites when touched. At closeout:

```bash
pnpm lint
pnpm build
git diff --check
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Manual stress pass in the running app after Phases 3, 5, and 6: draw each arrow kind and resize its
heads, place and resize both bracket kinds, drag a chain off an existing atom and off empty canvas,
apply formula text to a typed formula, and confirm SVG export matches the canvas for each.

Definition of done:

- Shipped toolsets contain zero permanently disabled buttons; every visible button performs its
  action.
- The Customize gallery cannot produce a decorative disabled button.
- Reaction, resonance, equilibrium, and retrosynthesis arrows are semantic objects that round-trip
  CDXML.
- Orbitals, brackets, symbols, chain, and formula text create real document objects with undo/redo,
  save/reopen, and SVG export parity.
- AGENTS.md, PLAN.md, and this file describe the shipped state; build stamps updated.
