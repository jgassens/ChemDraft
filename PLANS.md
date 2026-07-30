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
  | DistributionResult  // isotope envelope: masses, intensities, truncation policy
  | SpectrumResult      // axes, units, sticks, broadening parameters
  | GeometryResult      // coordinates + atom mapping back to source
  | OrbitalResult       // grid, isovalue, basis
  | CorrelationMapResult;

type AnalysisStatus =
  | "ok" | "partial" | "unsupported" | "not-applicable"
  | "failed" | "cancelled" | "timed-out";
```

Also required: **structured unit identifiers** (not free strings), **multiple** uncertainty objects per
result, structured citations and dataset references, warning **codes** with severity and affected
outputs, random/conformer seeds, raw-artifact references, and **schema versioning with runtime
validation from day one** — matching the repo's existing Zod discipline
(`packages/chem-core/src/schemas.ts` is `.strict()` throughout, with the `degradingEnum` pattern for
forward compatibility; reuse both).

Two things to settle now rather than retrofit:

- **Payload transport.** Decide transferable typed arrays vs JSON, and memory ownership across the WASM
  and worker boundaries, *before* spectra and orbital grids exist. A spectrum is not a few numbers, and
  JSON-serializing grids will force an ugly rewrite. Note the constraint the plugin runtime already
  imposes: everything crossing the panel bridge is structured-clone-safe plain data.
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
| Dimorphite-DL gives a numeric pKa with ± | It gives **protonation-state enumeration**. Its file carries per-group mean and SD, but a group average is not a molecular pKa — every carboxyl gets the same number. |
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

¹H/¹³C NMR predictor (already shipping — **§4 exposure applies**) · Joback/Stein-Brown thermophysical
(large method surface, applicability limits, parameter provenance) · isotope-envelope and mass-analysis
suite · protonation-state enumeration (**not** labeled pKa) · candidate HSQC/HMBC/COSY maps ·
OpenClatura structure→name.

### Sidecars and externally installed engines

**MOPAC ≥ 23.1.0** — bundleable Apache-2.0 sidecar, macOS arm64 first · **xtb** — user-installed or
separately distributed with full LGPL compliance · **ORCA, GAMESS** — detect only, never redistribute,
with an in-UI notice that the user's own license governs · **Psi4 (LGPL-3.0), NWChem (ECL-2.0)** — detect
only, too large for the base app · **Tinker/MM2** — do not bundle without a redistribution or commercial
license.

### pKa — no *cleared embeddable* predictor

A clearance problem, not an absence of technology. All three below are **evaluation set, not approved
list**; each needs artifact-level review of model files, training data, transitives, and redistribution
rights.

- **MolGpKa** (MIT code, ships weights). Blocked on provenance: the published model was trained largely
  on **ACD/Labs-calculated** pKa values from ChEMBL, with **Epik** used to identify acidic and basic
  sites. MIT code is not distribution clearance.
- **pKaLearn** (`MoitessierLab/pKaLearn`, **MIT**, pushed 2026-04-14, Python/conda) — ionizable site
  detection, site-specific prediction, iterative polyprotic handling, dominant-state generation, with
  author-acknowledged limitations around missed centers, tautomers, and training data. ⚠️ Its repository
  contains a **`MolGpKa_retrained/`** directory, so its provenance relationship to MolGpKa's
  ACD/Labs-derived labels must be checked explicitly — it may inherit the same blocker rather than
  resolve it.
- **Uni-pKa** (Apache-2.0, public weights and datasets, microstate enumeration + learned free-energy
  model) — scientifically stronger, expects a Python/Uni-Mol environment.

Dimorphite-derived functionality stays labeled **protonation-state enumeration**.

A pKa result needs a richer output model than the §3 base: microscopic vs macroscopic pKa, acidic vs
basic transition, the two microstates each microscopic pKa connects, solvent and temperature,
charge-state enumeration limits, tautomer handling, and whether the value is experimentally trained,
quantum-derived, or inherited from another predictor.

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
2. Analyze failures and upstream velocity.
3. Contribute fixes upstream.
4. Consider a Python sidecar.
5. **Port to TypeScript only if** the benchmark establishes enough product value to justify maintaining a
   second implementation of a still-developing nomenclature engine. Before any port, **inventory which
   RDKit APIs the rule engine touches against MinimalLib's surface** — every gap is another vendored
   patch, against the budget noted in §7.

OPSIN round-trip is a **structural-equivalence test**, not evidence of preferred-name correctness. Note
OpenClatura's own verification runs through `py2opsin`, which shells out to Java, so a ported path
carries the JVM question separately. **Publication-grade preferred IUPAC naming stays a gap.** The
existing `examples/plugins/opsin-name-to-structure` covers the opposite direction only.

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
- **Phase 1 — Contracts.** New `packages/analysis-core`: `MolecularInterpretation`, `Transformation`,
  the §2 classification triple plus flags, the §3 `AnalysisResult` discriminated union, `AnalysisStatus`,
  structured units, uncertainty, citations, warning codes, the method-contract type, and schema
  versioning with `.strict()` Zod validation and the `degradingEnum` forward-compatibility pattern. Pure
  data — no engine import, so `pnpm lint` and the boundary test stay cheap. Ships with the
  property-based representation-invariance harness and a `propertyCorpus.ts` sibling to
  `chem-core/src/corpus.ts`.
- **Phase 2 — Real RDKit adapter.** Replace `rdkitAdapterStatus = "placeholder"` and delete the
  ten-SMILES fixture table. Parse and sanitize once; emit the `source` interpretation; derive composition
  from `get_json()`; masses from the isotope-aware composition; InChI/InChIKey; the 43 descriptors mapped
  to named methods with contracts. Pinned engine-regression fixtures tagged with RDKit 2026.03.3, so a
  vendor bump fails loudly.
- **Phase 3 — Interpretation ledger in anger.** `largest-organic-fragment` and `neutralized`
  interpretations with real atom mappings and populated `Transformation` ledgers; per-analysis
  interpretation selection; the sodium-benzoate regression as a first-class test.
- **Phase 4 — Worker and session cache.** Persistent analysis worker with cancellation, supersession on
  edit, debounce, molecule-size and memory limits, and the §1 cache key. Transport decision from §3
  settled here and documented.
- **Phase 5 — Analyze surface.** Analyze menu and panel wiring, TS model plus the `lib.rs` native mirror
  (`build_analyze_submenu`, `MENU_COMMAND_IDS`) kept in step with the existing drift check; copyable and
  exportable provenance report showing the active interpretation and its "— change" affordance.
- **Phase 6 — MinimalLib patch #6.** Expose `includeSandP` on `get_descriptors`; add
  `vendor/patches/0006-*`, update `vendor/BUILD.md`, rebuild the artifact, and record the new patch count
  in the dependency inventory.
- **Phase 7 — Release 1 closeout.** Property corpus green across salts, zwitterions, radicals, isotope
  labels, S/P, boron/silicon, charged heterocycles, tautomers, organometallics, oversize, and unsupported
  atom types — with declines where declining is correct. Method contracts complete for every shipped
  capability. Docs and build stamps updated.
- **Phase 8 — Release 2, mass tooling.** IsoSpec through the existing Emscripten lane; isotope envelopes
  with truncation policy in provenance; m/z and adduct tooling; fragment formulas and exact-mass
  bookkeeping; retire the M/M+1/M+2 approximation in the mass-fragment demo. No intensity or MS/MS
  claims.
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

## Definition of done (Release 1)

- No `rdkitAdapterStatus = "placeholder"` and no fixture-backed analysis path outside tests.
- Every shipped number carries a method contract naming its implementation, version, interpretation
  policy, units, convention, and declining conditions.
- The active interpretation is visible and changeable for every analysis; per-atom results map back to
  source atom indices.
- Sodium benzoate reports sodium benzoate's formula, mass, and charge — and says so explicitly when a
  predictor asked for the neutralized fragment instead.
- Out-of-domain structures decline (`unsupported` / `not-applicable`) rather than returning a number.
- Representation-invariance property tests pass over SMILES permutations, atom renumberings, Kekulé vs
  aromatic forms, and hydrogen styles.
- Engine-regression fixtures are pinned to RDKit 2026.03.3 and fail on a vendor bump.
- The dependency inventory lists every chemistry engine, vendored binary, patch count, and bundled
  dataset.
- `pnpm lint`, `pnpm test`, `pnpm build`, the plugin boundary test, and the Rust checks are green.

## Open items owned by the project owner

These block release, not engineering (§4). This branch records them and proceeds.

1. **Core license choice.** `LICENSE`, `package.json` (`UNLICENSED`), and `AGENTS.md` disagree. AGENTS.md
   §8a reserves this decision; no agent changes it.
2. **nmrshiftdb2 decision deadline** and the authorized-licensor confirmation (§4).
3. **Plugin-distribution rules** for first-party plugins that carry data under separate terms.

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
