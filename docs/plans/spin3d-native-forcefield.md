# Native Spin 3D force field

## Decision and scope

Prefer a Rust port of Avogadro's Universal Force Field (UFF) and ABC-FIRE optimizer in
the Tauri app, subject to the static-link and optimizer gates below. Use native UFF
for Interactive 3D's initial relaxation, atom tugging and release settle. Keep ordinary
Spin 3D's existing conformer generators and refinement settings.
The UFF preference still selects RDKit UFF when RDKit is the conformer engine. Interactive
3D applies its own force field to the resulting conformer. The registered commands already
have separate entry points. `apps/desktop/src/MainWindow.tsx:12077`,
`apps/desktop/src/spin3dSettings.ts:12`, `apps/desktop/src/conformerWorkerRuntime.ts:230`.

This plan uses the owner-supplied account of Geoff Hutchison's permission to port the
code and request for attribution in [issue #164](https://github.com/jgassens/ChemDraft/issues/164).
The issue was unavailable offline. Upstream paths below refer to the read-only
Avogadrolibs checkout at commit `b296e8024abd93771f6a51f5d9eed4f9ca419e6b` (2026-11-17).
The shipping sidecar pins `416651ddaef33a4e20392392e7c0b505d446491b`, which is absent from
that shallow checkout. Use the new pin for numerical reference fixtures and the shipping
binary for product behavior comparisons. The older [`spin3d-forcefields.md`](spin3d-forcefields.md)
records the OCL and Preferences work and a blocked Open Babel proposal. The current
Avogadro sidecar is a separate implementation. `native/avogadro3d-sidecar/CMakeLists.txt:9`.

| Option | Assessment |
| --- | --- |
| **Rust port in Tauri** | Recommended. One Cargo build across desktop targets, no C++ runtime boundary or auxiliary executable. ChemDraft owns atom typing, numerical parity and the drag policy. Measure the stripped binaries and compressed installers before cutover. |
| **Link Avogadrolibs C++** | The sidecar recipe builds static Core/Calc for all three shipping targets with Qt, OpenGL, Python and optional chemistry integrations off. Reusing that implementation would avoid the numerical port and much of the port-parity oracle work. Linking into Tauri requires an exception-safe C ABI, coordinated Cargo/CMake target, SDK and deployment flags for both Mac architectures, and an MSVC CRT policy for Windows. The in-process proof must verify the CRT setup. Core uses Eigen and at the examined pin Calc uses CppOptLib and Threads. Audit MPL-only Eigen and final linked objects. Existing real helpers are about 1 MB where sizes are recorded. Measure in-app size and build-time deltas at the static-link gate. `native/avogadro3d-sidecar/{CMakeLists.txt,CMakePresets.json}`, `docs/architecture/dependency-inventory.md:109`; upstream `avogadro/core/CMakeLists.txt:1,147`, `avogadro/calc/CMakeLists.txt:32`. |
| **Avogadro WebAssembly** | The checkout has a CI recipe for a Qt 6.11.1 and Emscripten 4.0.7 multithreaded web editor. It pins a superbuild and companion sources and stages `avogadro-web.wasm`, JavaScript and any worker/data assets. The top-level Emscripten profile requires static libraries and Qt/OpenGL. The project owner's request relays the Avogadro maintainer's description of the `web.avogadro.cc` build as unreleased. Open questions include what the site deploys, an obtainable pinned artifact, stable mechanics-only exports, UFF/FIRE access, the bundle's size and redistribution terms, offline operation, and compatibility with Tauri's webviews. Building a mechanics-only WASM module would be a separate project. For the build recipe, see upstream `.github/workflows/build_wasm.yml:24,116,151`, `CMakeLists.txt:38,195`. |

## What ships today

- **Conformers.** Spin 3D reuses saved geometry or uses the progressive worker. RDKit WASM
  provides ETKDGv3 and MMFF94, MMFF94s or UFF refinement. OpenChemLib is an explicit choice
  or fallback and refines with MMFF94. Plugin 3D chemistry has its own worker path with
  RDKit. The sidecar's `embed` event labels a seed snapshot. The sidecar neither embeds
  nor searches conformers. `apps/desktop/src/MainWindow.tsx:5468,5659,6345`,
  `apps/desktop/src/conformerWorkerRuntime.ts:230,392,488,576`,
  `apps/desktop/src/conformerWorkerShared.ts:32`, `packages/rdkit-adapter/vendor/BUILD.md`,
  `apps/desktop/src/chemistry3d/README.md`, `native/avogadro3d-sidecar/src/main.cpp:1802`.
- **Interactive mechanics.** `openInteractive3dWorkspace` arms a headless session on the
  existing Spin overlay, checks availability and metal eligibility, and seeds the session
  from the live conformer in drawn atom order. `engine3dSidecar.ts` serializes the drawn
  graph to V2000 with its Kekulé orders and sends coordinates by atom ID. The sidecar rejects
  V3000, reads formal charge, normalizes other bond codes to single and can add deterministic
  depth jitter to planar seeds. Its optimization graph contains drawn atoms, including any
  drawn H atoms. The real engine caches Avogadro UFF and uses **Hybrid**, which starts with
  ABC-FIRE and switches to L-BFGS. The sidecar sets FIRE's `maxMove = 0.18` Å and
  L-BFGS's `maxStep = 0.18`. A no-Calc protocol scout simulates drag without UFF.
  MMFF, GAFF and Ghemical are absent from the sidecar. `apps/desktop/src/MainWindow.tsx:6300,6325,6361,6383`,
  `apps/desktop/src/engine3dSidecar.ts:107`,
  `native/avogadro3d-sidecar/src/main.cpp:438,468,687,1192,1274,1292,1339,1399,1802`.
- **Session behavior.** After ready the sidecar does 18 initial-relax iterations. Drag clamps
  and pins the target, relaxes a local mobile shell for three iterations, retains optimizer
  state by default, checks geometry and removes rigid-body drift. Release resets the optimizer,
  expands the shell, runs guarded chunks, clamps again and aligns. Deterministic torsion
  trials on release are opt-in through `CHEMDRAFT_ENGINE3D_ANNEAL_SETTLE`. The product
  defaults come from the source. `commit` returns a coordinate snapshot and provenance.
  Visible flatten uses the accepted overlay coordinates through `flattenSpunMolecule`;
  overlay teardown disposes the session. `native/avogadro3d-sidecar/src/main.cpp:723,996,1067,1107,1449,1482,1679,1762,1841,1879,1949,2050`,
  `apps/desktop/src/MainWindow.tsx:5227,5288,6434,6446`, `apps/desktop/src/engine3dSidecar.ts:237`.
- **Transport.** `Engine3DProtocolVersion = 2` uses newline-delimited JSON for
  `createSession`, `ping`, `beginDrag`, `updateDrag`, `endDrag`, `commit` and `dispose`.
  Events report ready, coordinates/revisions, energy, selection, warnings, errors, heartbeat
  and close. The v2 commit validator checks signatures, finite coordinates, exact ID
  membership and nonnegative revision. Its graph signature covers IDs, elements, bond
  endpoints and orders. TypeScript invokes five `engine3d_sidecar_*` commands (status,
  start, send, poll, stop) and reduces replies. Rust resolves the developer environment
  override or sibling binary, starts it over piped stdio, drains bounded messages and
  replaces the existing child on start. `packages/engine3d-api/src/index.ts:1,67,118,214`,
  `apps/desktop/src/engine3dSidecar.ts:75,141,265,331`,
  `apps/desktop/src-tauri/src/lib.rs:1593,7237,7306,7338,7415,7534`,
  `apps/desktop/src-tauri/capabilities/default.json:61`.
- **Build and tests.** `native/avogadro3d-sidecar/src/main.cpp` builds with CMake presets
  `protocol-scout`, `protocol-scout-x86_64` and `windows-msvc` against local ignored
  Avogadrolibs and Eigen checkouts. The real builds are committed under
  `apps/desktop/src-tauri/binaries/` and Tauri stages the target-specific executable
  via `bundle.externalBin`. The audit checks the pin string, build options, dependency
  guards and bundle declaration. The three `smoke:engine3d-*` scripts exercise a real charged
  43-atom drag and commit, sustained fixed-target drift, and annealed-settle energy on
  octane. `native/avogadro3d-sidecar/{README.md,CMakePresets.json}`,
  `apps/desktop/src-tauri/binaries/README.md`, `apps/desktop/src-tauri/tauri.conf.json:41`,
  `package.json:20`, `scripts/audit-avogadro3d-sidecar.mjs`,
  `scripts/smoke-engine3d-{real-structure,hold-steady,anneal-energy}.mjs`.

## Upstream port inventory

Counts are physical lines at the port pin, including comments and blanks. The eight
Calc files and the listed Core source/header files carry BSD-3-Clause headers at lines
1–4, except `core/elementdata.h`, which lacks one. Paths in the table are under upstream
`avogadro/`, unless identified as ChemDraft paths.

| Files and symbols | Treatment |
| --- | --- |
| `calc/uff.cpp` (1,313), `calc/uff.h` (77) | **Port** the reference behavior of `UFF::setMolecule`, `value`, `evaluate`, `gradient` and the five public term energy/gradient pairs. Replace the C++ factory, PIMPL, pointer lifecycle and metadata with an owned prepared model. Preserve accumulation order and the kcal-to-kJ conversion. `uff.cpp:1032,1102,1116,1139,1153,1183,1253`. |
| `calc/uff.cpp` setup | **Port** `Coordination` and the term data in `UFFBond`, `UFFAngle`, `UFFOOP`, `UFFTorsion`, `UFFVdW`. In `UFFPrivate`, port `setAtomTypes` (element, degree, multiple bonds, neighbor resonance), `calculateRij`, `setBonds`, `setAngles`, `setOOPs`, `setTorsions` and `pairKey`/`buildExclusionSet`/`areExcluded`. Preserve the resonance 1.5 and C–N 1.41 corrections, neighbor ordering and 1–2/1–3 exclusions. Typing reads but does not use formal charge. `uff.cpp:27,108,161,307,342,368,448,526,645`. |
| `calc/uff.cpp` evaluation | **Port** `bondEvaluate`, `angleEvaluate`, `oopEvaluate`, `torsionEvaluate`, `vdwEvaluate` and fused `UFFPrivate::evaluate`, with energy-only and per-term test access. Port nonperiodic vdW geometric mixing and its 10 Å hard cutoff. Replace `setVdWs`/`rebuildVdWsIfNeeded` cache scheduling as described below. The five terms contain no Coulomb or charge-equilibration calculation. `uff.cpp:99,670,714,736,761,869,923,978,1032`. |
| `calc/uffdata.h` (241) | **Port** ordered `parameter` / `uffparams` data with row/index and transcription tests. The header declares `float` entries, including values multiplied as floats before promotion. Match those rounding points. The file contains 128 rows including dummy and two rows beyond the 126 scanned upstream. Resolve the separate RDKit provenance before vendoring. `uffdata.h:6,15,32,235`, `uff.cpp:170,701`. |
| `calc/gradients.h` (215), `core/angletools.h` (224) | **Port** analytic `angleGradient`, `dihedralGradient` and `outOfPlaneGradient`, with `dihedralAngle`, `calculateDihedral`, and `outOfPlaneAngle` conventions. Preserve the separate energy-side angle formulas and unit conversions. `distanceGradient` is unused by UFF, whose bond and vdW derivatives are inline. Skip periodic plot helpers. `gradients.h:21,41,93,154`, `angletools.h:24,45,73,89,109,146`, `uff.cpp:736,761,978`. |
| `calc/energycalculator.cpp` (395), `calc/energycalculator.h` (245) | **Replace** `EnergyCalculator` inheritance, molecule masks and `cleanGradients` with a direct evaluator, validated mobile-coordinate mask and typed failure on nonfinite values. Preserve frozen-coordinate semantics. Skip production finite differences, Hessians, batching, default virtual fallbacks and general distance/angle/torsion/out-of-plane restraints (`setConstraints`, `constraintEnergies`, `constraintGradients`). The sidecar uses `setMask`. `energycalculator.cpp:49,62,80,102,115,133,149,288`; ChemDraft `native/avogadro3d-sidecar/src/main.cpp:1274`. |
| `calc/energyoptimizer.cpp` (387), `calc/energyoptimizer.h` (202) | **Port** `optimizeFire` with ABC bias correction and the FIRE portions of `FireParameters`, `OptimizationOptions`, `OptimizerState` and `optimizeSteps`. Preserve velocity, dt, alpha, positive-power count, energy and gradient across valid chunks. Test the FIRE2 branch with bias correction disabled. ABC-FIRE is the proposed app method, with explicit convergence and caps. The oracle comparison determines whether the port also needs L-BFGS, its history and Hybrid dispatch. Skip wall-clock-based `adaptChunkIterations`. `energyoptimizer.cpp:36,211,320,350`, `energyoptimizer.h:20,43,67,99,169`. |
| `core/molecule.{h,cpp}`, `atom.h`, `bond.h`, `graph.{h,cpp}`, `array.h` | **Replace** `Molecule::atomCount`/`bondCount`, `atom`, `bond`/`bonds`, `atomPositions3d`, `formalCharge`, `frozenAtomMask`, `Graph::neighbors`, `Atom::atomicNumber` and `Bond::order`/`atom1`/`atom2` with an indexed graph and coordinate buffers from ChemDraft's model. The C++ harness alone uses `Molecule::addAtom`, `addBond`, `setFormalCharge`. Use ChemDraft's `atomicNumberForElementSymbol` and `nativeBondOrderResolution` to supply an integral Kekulé mechanics view while retaining the original aromatic graph. `core/molecule.h:217,427,471,805,1179,1313`; ChemDraft `packages/chem-core/src/elements.ts:22`, `packages/layout-engine/src/valence.ts:338`. |
| `core/angleiterator.{h,cpp}` (155), `core/dihedraliterator.{h,cpp}` (240) | **Replace** `AngleIterator` and `DihedralIterator` `begin`/`operator++` with neighbor-pair enumeration and neighbor enumeration at both ends of each central bond. Verify tuple order and multiplicity, including a repeated outer atom in a three-membered ring. UFF uses adjacency and integral bond orders. **Skip** `RingPerceiver::rings` and `AromaticityPerceiver` (`core/ringperceiver.{h,cpp}`, `core/aromaticity.{h,cpp}`). The UFF resonance pass also operates in acyclic conjugation. Optional rotor trials use ChemDraft's cycle rejection. `uff.cpp:250,368,526`, `angleiterator.cpp:23`, `dihedraliterator.cpp:25,78,99,126,167`, `ringperceiver.cpp:501`, `aromaticity.cpp:238`. ChemDraft `native/avogadro3d-sidecar/src/main.cpp:1527,1569`. |
| Other Core and Eigen | **Replace** `vector.h` and Eigen's `Vector3d`, `VectorXd`, mapped storage and array operations with `[f64; 3]`, slices and scalar math. Use the necessary `avogadrocore.h` scalar/index/unit conventions, including 4.184 kJ/kcal. **Skip** `UnitCell` minimum-image and periodic distance (`unitcell.{h,cpp}`), `Constraint` (`constraint.h`), `VariantMap` and `Variant` (`variantmap.{h,cpp}`, `variant.{h,cpp}`), `Elements` (`elements.{h,cpp}`, `elementdata.h`), generated export headers and unused Eigen template includes. `uff.cpp:10,135,686,993`, `energycalculator.h:9`, `core/avogadrocore.h:26,88`, `core/elements.cpp:6`, `core/vector.h:9`. |

The audited Calc files total 3,075 lines. The four primary references (`uff.cpp`, `uff.h`,
`uffdata.h`, `gradients.h`) account for 1,846 lines. Select about 210 of the 589 optimizer
lines and short portions of `angletools.h` and `energycalculator`. The two Core iterator
pairs and `angletools.h` total 619 lines before trimming. Estimate **1,350–1,900 Rust lines
for mechanics** (300–450 topology and typing, 550–750 terms and math, 250–350 table,
250–350 FIRE and glue) and **600–1,000** for Tauri, session and drag policy. Optional
anneal parity adds about 150–300. Estimates exclude tests and fixtures and use the
inventory above and the 2,079-line `native/avogadro3d-sidecar/src/main.cpp`, which includes
the process transport and molfile parser.

The hardest parts are typing, torsion periodicity and derivative sign, inversion neighbor
order, singularities, and parameter rounding. Keep the reference's single-central-bond
torsion gate and inversion ordering. Check the element after every typing transition.
The upstream scan stops at index 125, an intra-type scan can cross element boundaries,
and its final constructor check comes after the resonance pass. The table itself assigns
`Sb3+3` to atomic number 50 and `Xe4+4` to 53, with a series of shifted atomic numbers
starting at `Sb3+3`. Preserve the upstream table as the oracle input and use the product
support matrix below to audit every enabled type. Refuse mismatched or unreviewed
assignments with the atom ID and element. Handle corrected data in a separately reviewed
change. Decline unresolved aromatic orders, query/dative bonds, dummy atoms and unsupported
coordination or stereo before relaxation. Upstream's harmonic angle fallback multiplies its derivative by an
extra sine. Very small angles skip gradients and the vdW overlap energy has a separate
floor from its gradient. Use dedicated refusal or documented boundary tests for these
cases. Test valid linear geometry separately from degenerate inputs. Keep the existing
product metal gate while probing table coverage at the evaluator.
`avogadro/calc/uff.cpp:137,161,233,259,424,448,526,820,830,856,869,923,1008`,
`avogadro/calc/uffdata.h:157,235`, `avogadro/core/elementdata.h:11`,
`packages/chem-core/src/elements.ts:22`, `apps/desktop/src/MainWindow.tsx:6325`.

Proposed v3 support with the uncorrected table. The existing product metal gate still
applies before the evaluator. Support is specific to validated types and coordination.

| Element or group | Pinned behavior and proposed v3 product result |
| --- | --- |
| H–In (Z 1–49) | Accept only validated element/type/coordination combinations that pass the product gates. Refuse an unreviewed type or any typing transition that crosses elements. |
| Sn (Z 50) | The intact `Sn3` row shares Z 50 with `Sb3+3`. Accept only a validated `Sn3` assignment if the graph passes the product gates. Refuse any mismatched or unreviewed assignment. |
| Sb, Te, I, Xe (Z 51–54) | The first matches are `Te3+2`, `I_`, `Xe4+4` and `Cs`, respectively. Refuse all four. In particular, organoiodine input loses Interactive 3D under this policy even where v2 runs with a wrong type. |
| Cs–Lu (Z 55–71), Hf–Rn (Z 72–86), Fr–Fm (Z 87–100) | Every scanned row in this range carries a label for the next element, including the multiple rows for W and Re. Refuse the whole range even if a graph passes the metal gate. |
| Md, No, Lr (Z 101–103) | Refuse. Rows 126 and 127 carry `No6+3` and `Lw6+3` with stored Z 101 and 102, but the scan stops at row 125. Z 103 has no row. |
| Dummy atoms and elements above Z 103 | Refuse. |

The owner must select either these explicit refusals or a separate correction with
documented provenance, licensing and validation before generating fixtures. A corrected
table needs its own version, reviewed type/coordination allowlist and acceptance fixtures for any
newly enabled cases. Keep the raw upstream outputs as evidence of the mismatch. Reconfirm
the chosen support matrix and user-visible coverage before cutover. Recommend the scoped
refusal policy for the first release if the owner accepts the coverage loss, including
organoiodine. If that loss is unacceptable, require the validated correction before cutover.

Evaluate all pairs first as a correctness baseline. For interactive performance, build a
list within 12 Å and rebuild before the first evaluation at which an atom has moved at
least 1 Å. Apply the exact 10 Å cutoff each time. This bounds how far a missed pair can
close. Upstream builds at 10 Å, checks displacement every ten evaluations and rebuilds
after a move over 2 Å. Test parity away from the boundary and document the intentional
difference when a pair crosses it. `avogadro/calc/uff.cpp:99,670,714,978`.

## Native API and application flow

Use `apps/desktop/src-tauri/src/engine3d/` with a pure mechanics submodule for topology,
parameters, evaluation and FIRE. Keep Tauri state and drag policy outside the evaluator.
The desktop backend already uses Serde, `spawn_blocking` and Tauri channels. Use those and
the standard library. For rigid alignment use a proper-rotation quaternion fit with a
fixed-size solver and explicit degenerate-rank handling, independently checked against
the sidecar's SVD/Kabsch. Rendering stays in the existing layout and projection pipeline.
`apps/desktop/src-tauri/Cargo.toml:38`, `apps/desktop/src-tauri/src/fonts.rs:46`,
`apps/desktop/src-tauri/src/assistant_mcp/mod.rs:11`,
`native/avogadro3d-sidecar/src/main.cpp:723`, `AGENTS.md` §6 and §9.

Preserve the session model and change its wire shape. Bump the current
`Engine3DProtocolVersion` from **2 to 3** in `packages/engine3d-api/src/index.ts` and
match it in Rust. Preserve v2 serialization and its constant in a migration adapter,
with v2 binaries and fixtures pinned. Test cross-version rejection and the v2 path
separately. V3 uses typed objects over Tauri IPC with no newline framing.

| Proposed Tauri command | Contract |
| --- | --- |
| `engine3d_native_status` | Reports v3 support and method ID, UFF port source pin and optimizer variant. No path discovery or process launch. |
| `engine3d_native_start_session` | Takes a typed v3 graph, immutable graph signature and x/y/z seed coordinates in Å in stable atom order. Returns a session handle immediately after basic validation. Delivers ready, progress, warnings and results on a session-bound channel. |
| `engine3d_native_send_session` | Accepts begin/update/end drag and snapshot requests with session, drag and request IDs. A snapshot resolves to the last accepted revision after the requested settle barrier. |
| `engine3d_native_stop_session` | Idempotently cancels the worker, invalidates its handle and drops its coordinate stream. |

Have TypeScript build the v3 graph through the existing native-graph/bond-order helpers.
Include stable IDs, atomic numbers, formal charges, original order and resolved mechanics
order, component membership and the available isotope, radical and specified stereo intent.
If the owner chooses mapped H, include the mechanics-only H mapping in the immutable graph
and return only drawn-atom coordinates to the overlay. Use a canonical v3 graph signature
covering the immutable fields. Rust validates atom/index
and bond membership, duplicate IDs and bonds, order types, unsupported features, signature,
finite/bounded coordinates and targets, frame sizes and work bounds. Start with a 500-atom
cap including every mechanics H and a 2,000-bond cap, validate against existing workloads, and
measure CPU and memory near the cap. Rust returns only coordinates, revision, method and
status for this immutable graph. It never edits a document or types an unknown atom as
carbon. Bind the new commands to the document webview with explicit Tauri permissions.
The existing bridge permission and signature checks are the starting points.
`packages/engine3d-api/src/index.ts:214,231`, `apps/desktop/src/engine3dSidecar.ts:107`,
`apps/desktop/src-tauri/capabilities/default.json:61`, `AGENTS.md` §7 and §13.

Run one bounded session worker on a background thread. The Tauri command enqueues work
and returns without waiting for optimization. Preserve ordering for begin, end and snapshot.
Coalesce world-space move targets to one pending target per drag, flush the newest target
before end, and rate-limit coordinate and energy snapshots to at most 30 Hz plus phase
boundaries. Check a cancellation token between iterations and periodically inside pair or
setup loops. Use fixed iteration ceilings for numerical results, with a wall-clock watchdog
that reports a timeout or cancellation and keeps the last accepted geometry. Never report a
partial timeout as converged. Close or supersede sessions on Escape, flatten, selection or tab
changes, window close and app quit. Use bounded delivery, drop stale revisions by session and
drag ID, and keep final acknowledgments and errors even when intermediate frames are dropped.
The existing scheduler already has drag coalescing, cancel and open-serial guards.
`apps/desktop/src/MainWindow.tsx:2915,6173,6199,6415,6446,6619`.

Cache prepared topology by session and carry FIRE momentum across valid drag steps.
After each external coordinate change that becomes the next optimizer input, refresh both
cached energy and the masked gradient at those exact coordinates before another chunk.
This includes placing a target, clamping, restoring a rollback snapshot and applying rigid
alignment, even during a fixed-target drag. A single fresh evaluation after consecutive
changes is sufficient if no chunk ran between them. Reset the optimizer whenever the cache
cannot be refreshed exactly. Zero velocity on pinned coordinates and clear optimizer state
after a rollback, mask change or release. After a reset, the next chunk must start with a
fresh evaluation. If Hybrid ships, reset L-BFGS history when external changes invalidate
its position and gradient differences. Port the bond reach limits, mobile shell, drift
removal and geometry guards.
Check safety after clamping and alignment as well as after relaxation. From the accepted
coordinates after those checks, report kJ/mol energy and mobile-gradient RMS together with
the method, revision, actual iterations and status. Use explicit
`unsupported`, `invalid-input`, `not-converged`, `cancelled` and failure reasons.
Keep a blocked or failed interactive request on the last accepted Spin 3D geometry.
`native/avogadro3d-sidecar/src/main.cpp:723,996,1067,1107,1274,1449,1879,1949`;
upstream `avogadro/calc/energyoptimizer.cpp:223,267,299`.

Reuse the MainWindow attach/scheduler and replace the transport adapter behind it. Convert
accepted snapshots to the existing coordinate buffer by stable atom ID, use the live drag
target for transient feedback only, and preserve quaternion, scale, anchor and bond pairs
through `applySpin`. For flatten during a release use the newest validated settle revision
or return a clear pending/error status. Never commit a transient pointer target. Keep one
`ScreenPlacement` for `projectSpin`, `flattenSpunMolecule(..., { placement })`, reopen and
drag or typed rotations. Flatten uses the existing document patch, history and stereo
reconciliation. Add no projection or drawing math to Rust. Exercise `spin3dModel`,
`spinFlatten`, `spinFlattenStereo`, `flattenRoundTrip`, `spinOverlay` and `rotation3d`.
`apps/desktop/src/MainWindow.tsx:5227,5288,5933,6460,6496,16452,16744`,
`apps/desktop/src/interaction/spinOverlay.ts`, `apps/desktop/src/interaction/rotation3d.ts`,
`apps/desktop/src/documentWorkflow.ts:18500,18565`, `AGENTS.md` §9.

## Reference fixtures and acceptance

The owner must freeze the mechanics graph in PR 1 before fixture generation. Hydrogens
affect degree-based typing, bonded terms (including angles, torsions and inversions) and
nonbonded exclusions. Compare the port and oracle only on identical mechanics graphs.

- **Drawn atoms only (recommended for the first release).** This matches the sidecar input.
  For structures with implicit H, define it as approximate drawn-atom UFF for interaction.
  Label any reported energy as applying to the drawn mechanics graph. Limit comparisons to
  the same mechanics graph and method. Limit energy claims to this interaction model.
  Freeze implicit-H product fixtures that test drawn atom IDs, typing, term/exclusion
  setup, drag, energy labeling and tug-to-flatten.
- **Mapped explicit hydrogens.** Bring the conformer's H atoms and coordinates into the
  mechanics graph with a validated parent bond and stable mapping. This makes the UFF
  energy describe the full modeled graph and changes parity with the drawn-atom sidecar.
  Freeze mapped-H product fixtures that test the mapping, typing, terms and exclusions,
  stereo, session bounds and projection back to drawn IDs. Mechanics-only H stay outside
  the document. Refuse missing or ambiguous mappings with a clear reason.

Generate references once offline with a small C++ harness linked to the pinned
`Avogadro::Core` and `Avogadro::Calc`. Configure a separate build directory from the read-only
source and use a locally available, pinned Eigen 3.4.0 with `EIGEN_MPL2_ONLY`. Disable
Qt, OpenGL, Python, testing and optional integrations as in the sidecar recipe. The plan did
not build or run the harness. If a dependency is missing, stage an audited local copy before
fixture generation. Use ChemDraft-authored graph and 3D coordinates, with no downloaded
molecule datasets. Serialize the same ordered atom/charge list, integral bonds and exact
starting coordinates to both solvers. Build each molecule with `Molecule::addAtom`,
`addBond` and `setFormalCharge`, then call `UFF::setMolecule`. For each fixed snapshot,
reinitialize at that geometry and record `value`, `evaluate`, all five term energies and
gradients (zero each output buffer before use), and expected term tuples and type labels
from a test-only diagnostic in a writable source copy. Confirm diagnostic and unmodified
upstream numerical outputs agree. Keep raw per-term values and normalized values. The public
term methods return kcal/mol and kcal/(mol·Å), while total/scaled gradient use kJ/mol and
kJ/(mol·Å). Use no general restraints. For trajectory tests keep a separate model and
`OptimizerState` alive through `optimizeSteps` using explicit FIRE parameters and masks.
Commit the fixture input and expected JSON with round-trip double precision, input/output
hashes, full upstream commit, compiler/build flags, Eigen version, generator and settings.
Tests consume the JSON with no C++ or network dependency. Recompute only when deliberately
changing the pin. Upstream `avogadro/calc/uff.{cpp,h}`, `avogadro/calc/energyoptimizer.{cpp,h}`,
`tests/calc/ufftest.cpp:40,78,113` and `tests/calc/energyoptimizertest.cpp:244,319,468`;
ChemDraft `native/avogadro3d-sidecar/CMakeLists.txt`.

| Fixture group | Molecules and checks |
| --- | --- |
| Small organics and term isolation | Water and methane (stretch and bend), acetylene (linear and triple order), ethanol (mixed typing), n-butane (torsion and 1–4 vdW), hydrogen peroxide (group-16 torsion), formaldehyde and acetamide (inversion and acyclic resonance). Use explicit hydrogens and fixed perturbations, including out-of-plane displacements. |
| Rings and aromatics | Cyclopropane (triangle traversal), cyclohexane chair, benzene and furan with fixed recorded Kekulé orders, and naphthalene (fused ring). Test recorded alternative Kekulé inputs as separate cases and check that the original graph remains aromatic. |
| Charges and scope | Methylammonium and acetate (charges retained, no electrostatic claims), plus a separated charged pair to test vdW inside and outside the cutoff. Use a synthetic octahedral Fe(II) coordinate set with six fluoride ligands and six single mechanics bonds as a calculator-only `Fe6+2` probe. Include SF₆ and record the selected S label and angle terms. Keep any approximate S type in an upstream comparator and require a product refusal for unreviewed coordination. Neither case establishes reliable coordination geometry. Upstream `avogadro/calc/uffdata.h:84,112`, `avogadro/calc/uff.cpp:191,424`. |
| Element support | Include an organoiodine case (iodomethane) and an antimony case (SbH₃). Record the pinned upstream assignments `Xe4+4` and `Te3+2` at the evaluator. Check the v3 result against the approved support matrix, including the `unsupported` result with atom ID and element for refusals. Use representative fixtures across the shifted range and the scan limit, and audit every enabled type. |
| Specified and unspecified stereo | Both enantiomers of 2-butanol and both alkene isomers of 2-butene, plus versions with unspecified tetrahedral/alkene intent. Include explicit and implicit-H display equivalents as distinct inputs. A mirrored tetrahedral or flipped alkene trial must be refused. Check isotope- and radical-bearing graphs either preserve identity or return the designed refusal. |
| Product and numerical boundaries | Keep the exact drawn-atom graph from the 43-atom sidecar smoke and a drawn-atom octane drag transcript as v2 baselines. Freeze the corresponding product fixtures using the owner-approved hydrogen policy. Include a fixed-target 200-frame run, one frozen-coordinate test, separated vdW pairs on both sides of 10 Å, a cutoff-crossing sequence, coincident atoms, unsupported type, unresolved order and malformed or excessively large input. Seed fixed-point tests away from singularities and set aside boundary and refusal cases. `scripts/smoke-engine3d-{real-structure,hold-steady,anneal-energy}.mjs`. |

Freeze the fixture groups and thresholds before comparing the port or tuning the app.
Use analytic production gradients. Independently central-difference each term with
`h = 1e-5 Å` and repeat at half step on smooth perturbed snapshots, away from cutoff
and branch boundaries. Track the difference between upstream's analytic derivative
and the finite difference separately from Rust-to-upstream parity. Investigate any
disagreement before enabling that geometry or term. Record intentional safety/cutoff
differences as separate tests. Start with the following gates.

| Test | Proposed gate |
| --- | --- |
| Typing and setup | Exact labels, term tuples/order, exclusion membership and mask for supported fixtures. Raw table values agree at their declared f32 precision. |
| Per-term and total energy | Check each term sum and total independently in kJ/mol with absolute error ≤ max(1e-6, 1e-8 × abs(reference)). Check the normalized terms sum to the total with restraints off. |
| Analytic gradient | For every Cartesian component of each term and the total after unit conversion, error ≤ max(2e-5, 1e-7 × abs(reference)) kJ/(mol·Å). On smooth coordinates, independently require analytic vs central difference error ≤ max(1e-4, 1e-4 × abs(reference)) kJ/(mol·Å). Verify that masking leaves frozen coordinates exact in the evaluator/optimizer, before any whole-frame alignment. |
| Optimizer agreement | Use ABC-FIRE on both sides with the exact options, starting coordinates and mask. Store checkpoints at 1, 10 and 100 iterations plus the endpoint. Compare a single run to 10-step chunks with no target or mask change. Checkpoint gates are ≤ 1e-4 Å max atom displacement and ≤ max(1e-4 kJ/mol, 1e-7 × abs(reference)) energy error. Record and test upstream FIRE2 separately on an analytic quadratic or a water fixture. |
| Fixed-target optimizer state | In the 200-frame run, compare cached energy and the masked gradient at each accepted frame and before the next chunk with a fresh evaluation at those coordinates. Exercise clamping, alignment and rollback. Compare every post-processed chunk against a reference that uses the same momentum/reset policy and post-processing and evaluates fresh energy and gradients at every chunk input. Require the energy, gradient and optimizer checkpoint tolerances above. |
| Endpoint agreement | On predetermined converging starts, run a maximum of 10,000 iterations, checking each iteration or the same fixed chunk boundary on both sides. Compute RMS as sqrt(sum of squared mobile Cartesian gradient components / number of mobile components). Both endpoints must reach ≤ 1e-2 kJ/(mol·Å) RMS and differ by ≤ 5e-3 in the same units. Require final energy difference ≤ max(0.02 kJ/mol, 1e-5 × abs(reference)) and no energy increase over the initial geometry. After translation and proper rigid alignment with fixed atom correspondence, require all-atom RMSD ≤ 0.02 Å and heavy-atom RMSD ≤ 0.01 Å. Symmetry or multiple minima still use fixed, paired starts. Treat cap exits as capped and record separate expected status/geometry checks. Do not widen tolerances to make different basins pass. |
| Product drag and settle | Compare traces against the committed v2 binary using the same drawn seeds, targets and phase order and each existing smoke's finite geometry, drift, bond and energy assertions. Require bounded fixed-target drift, no regressions in flatten safety, and pass the packaged benchmark below. Require annealed energy improvement with checked geometry if that option ships. Apply numerical parity only on identical mechanics graphs and test v2 UX against the owner-approved product model. |

In the oracle PR, freeze paired ABC-FIRE and Hybrid runs on the same approved fixtures
before running them. Adapt upstream `utilities/benchmarks/optimizerbenchmark.cpp:337–356`.
Use one upstream pin, starting geometry, mask, chunk schedule and convergence definition
per pair. Match the sidecar's `maxMove = 0.18` Å and Hybrid's `maxStep = 0.18`.
Record the Hybrid handoff and actual iterations, force evaluations, mobile-gradient RMS,
energy, geometry and status through default release (up to eight 12-iteration chunks) and
through an extended tail of up to 10,000 iterations. Start each release pair from the same
frozen pre-release snapshot so earlier drag differences cannot change the starting basin.

Freeze the release criteria in the oracle PR before the comparison and before the optimizer
PR. Proposed criteria for comparable basins are that ABC-FIRE passes the same safety gates,
every release case that Hybrid converges within the production budget reaches the same
1e-2 kJ/(mol·Å) RMS threshold within that budget, and accepted geometry, energy and RMS
at the production budget satisfy the endpoint agreement tolerances above. When Hybrid
reaches the cap, apply the same energy, geometry and RMS difference tolerances without
the absolute convergence requirement and label each run with its actual status. For the
extended tail, require ABC-FIRE to meet the endpoint gate on every predetermined run that
Hybrid converges and reach the RMS threshold in at most 125% of Hybrid's iterations,
rounded to the next chunk.
If ABC-FIRE misses an approved gate, implement native Hybrid with L-BFGS and require
Hybrid-to-Hybrid oracle parity and the product release gates before cutover. Keep v2 as
the default wherever it ships if the Hybrid work is deferred or fails its gates. Defer
Linux native enablement in that case.

Assert that topology, bond orders, formal charge, isotope/radical metadata, stable IDs and
component membership are identical before and after every accepted optimization. Obtain
specified tetrahedral and E/Z intent using existing host perception. Pass ordered stereo
witnesses to Rust and validate their geometry at the seed and each accepted step. Reject
near-degenerate or inverted witnesses, roll back the step and reset momentum. Carry
unspecified intent through unchanged. Validate final geometry independently with the
engine's 3D stereo perception, then compare the flattened result using canonical isomeric
SMILES (normalize only removable H consistently), formula, formal charge, stereoisomer
identity and atom, bond and component counts. Reuse or extract the tested
`assertComponentStereo`/stereo-graph logic where the Spin 3D data admits the same
mapping. Unsupported axial stereo, radicals, isotopes or labels require a specific refusal
if the current path cannot represent them. For test pages, also verify superatoms/R-groups,
reaction roles, annotations and unrelated objects survive unchanged, and compare flatten
coordinates within the projection tolerance and check one undo restores the original.
`apps/desktop/src/chemistry3d/{stereo.ts,engine.ts,flatten.ts}`,
`apps/desktop/src/MainWindow.tsx:5227,5288`,
`apps/desktop/src/documentWorkflow.ts:18500,18565`, `AGENTS.md` §7 and §9.

## Platforms and rollout

Use one scalar f64 implementation with stable atom and term order, stable tuple and pair
iteration independent of hash order, no fast-math or target-specific vector reductions,
and no wall-clock or RNG inputs to the optimizer. Do not use explicit FMA in parity-sensitive
expressions unless the reference does. Transcendental functions and accumulation may differ
slightly by compiler, CPU and OS. Use the numerical gates above on every host and require the
same accept/refuse decision for deterministic fixtures. Test cutoff, stereo and convergence
boundaries with values on both sides. Count chunks by iterations. Frame output timing can
vary, and comparison uses fixed inputs and accepted final revisions.

| Target | Current packaging and required verification |
| --- | --- |
| **macOS Apple silicon** | Has a real arm64 sidecar. Test the native core and packaged app without a bundled helper. Verify UFF provenance, drag, release, undo/reopen and cancellation on Apple silicon. Keep the app's macOS deployment floor. `apps/desktop/src-tauri/binaries/README.md`, `native/avogadro3d-sidecar/CMakePresets.json`, `.github/workflows/ci.yml:58`. |
| **macOS Intel** | Has a real x86_64 sidecar. Run the numerical suite and packaged smoke on Intel, using the existing Intel runner, and verify the bundle's architecture and minimum OS. Add the native suite to the release gate even if the current Intel CI job stays advisory. `apps/desktop/src-tauri/binaries/README.md`, `.github/workflows/macos-intel-smoke.yml:23`, `tools/release/verify-macos-app.mjs`. |
| **Windows x64** | Has a real MSVC x64 sidecar. Run native tests and the document-window smoke with the CI-built NSIS installer, including rapid input, focus, cancel and quit. Verify the installed app has no sidecar artifact or console flash. `apps/desktop/src-tauri/binaries/README.md`, `.github/workflows/{ci,windows-release}.yml`, `AGENTS.md` §1. |
| **Linux** | The two committed GNU Linux sidecar files, x86_64 and aarch64, are text placeholders. The runtime detects their marker and reports Interactive 3D unavailable without a separately configured executable. Regular Spin 3D still uses the conformer worker. The Linux Rust CI job already exists, and the release workflow currently packages amd64 .deb/AppImage and explicitly expects the placeholder in the .deb. Give Linux desktop the same native Interactive 3D engine and teach the package checks to require the absence of the placeholder. Run native tests and an installed amd64 .deb smoke under Xvfb plus an AppImage smoke. Run the suite on aarch64 before any Linux aarch64 support claim. A standalone browser build continues using the conformer worker and has no Tauri tug session. `apps/desktop/src-tauri/binaries/README.md`, `apps/desktop/src-tauri/src/lib.rs:7338,7365`, `apps/desktop/src/MainWindow.tsx:6335`, `.github/workflows/ci.yml:145`, `.github/workflows/linux-release.yml:36,145,160`. |

Develop with v3 behind a developer-only selector while v2 remains the shipped default
on its supported platforms. Compare the two implementations using shared transcripts.
Switch to v3 once the native numeric, UX and platform gates pass. Use v2 only as an
explicit temporary rollback during the transition. Show which backend ran. Invalid or
unsupported chemistry and failed stereo checks must never trigger a fallback. Linux
starts using v3 at cutover. No document migration is needed because sessions and their
UFF parameters are ephemeral. Existing behavior stores flatten geometry and uses the
document history path. Before deletion, rollback is selecting the retained v2 adapter
for new sessions. After deletion, rollback is a release revert from the known-good tag
or a hotfix disabling Interactive 3D while retaining regular Spin 3D.
`apps/desktop/src/MainWindow.tsx:5288,5323,6446`, `apps/desktop/src/engine3dSidecar.ts:237`.

Use a repeatable packaged-build benchmark for the default enablement PR. The proposed
reference machines are an Apple M1 Mac mini with 16 GB RAM, a 2018 Intel Mac mini with an
i7-8700B and 16 GB RAM, and a Windows x64 desktop with a Ryzen 5 5600X and 16 GB RAM.
Freeze the actual machines and OS versions in the bridge PR before timing. Record CPU,
RAM, OS and webview versions, display refresh rate and power setting. Use the same machine
and display for each v2/v3 pair. Run the same release-mode instrumented packaged build
with the developer selector set for each backend, including the CI-built NSIS package on
Windows. Keep hardware, display and build settings fixed within each pair.

Freeze replay files for the 43-atom smoke, the 200-frame fixed-target hold and a supported
near-cap graph. Record seeds, atom IDs, display state, world-space targets and their pointer
event timestamps, phase order and session options. Use the same input cadence for both
backends, with one update every 40 ms in the timed drag segment. Use fresh sessions for
each replay after app warm-up. Run five warm-up replays per backend and case, then 30
measured replays per backend and case in alternating backend order. Save the raw timings
and associate accepted revisions with input IDs. Report coalesced targets, timeouts and
missing final frames alongside the timings.

Measure drag latency on the document webview's monotonic clock from entry to the pointer
handler to completion of the overlay update that applies the corresponding accepted
coordinate revision. For release, measure from the pointer-up handler to the overlay
update that applies the final validated settle revision. Both measures include scheduling,
IPC, mechanics and overlay application, and end before display scan-out. Use engine and
IPC timing separately for diagnosis. For each machine, case and phase, sort the matched
latencies and take p95 at rank `ceil(0.95 × n)`, with one-based ranks. Require v3 p95 ≤
1.20 × v2 p95 for drag and release, no increase in the rate of coalesced targets, and
no timeouts or missing final frames. Verify overlay responsiveness in the manual pass.

Retire the child process in a separate PR after the native release passes. Remove
the three real binaries, both Linux placeholders, `externalBin`, v2 transport and Rust
bridge, permissions, startup overrides, and sidecar-only build/audit wiring. Preserve
the regression inputs and run their checks through a Rust in-process session harness
and real Tauri smoke. If the optional anneal is deferred, keep its historical comparison
data and document removal of the dev flag. Update the Intel workflow, Linux package
file list, macOS verifier and its fixtures, and release docs. Keep the offline oracle
recipe and Avogadro attribution in stable locations independent of the removed executable.
`native/avogadro3d-sidecar/`, `apps/desktop/src-tauri/tauri.conf.json:41`,
`apps/desktop/src-tauri/src/lib.rs:7237,12403,12507`,
`apps/desktop/src-tauri/permissions/autogenerated/engine3d_sidecar_*.toml`,
`scripts/{dev.mjs,audit-avogadro3d-sidecar.mjs}`, `run-app:46`,
`.github/workflows/{macos-intel-smoke,linux-release}.yml`,
`tools/release/{verify-macos-app.mjs,macos-release.test.mjs,macos-appcast.test.mjs}`,
`docs/releasing/{linux.md,macos-updates.md}`.

## Licensing and attribution

Use the upstream BSD-3-Clause terms for the adapted Avogadro source. Add source comments
with the upstream file names, commit, original copyright, SPDX identifier, and a short
list of the Rust changes. Credit the Avogadro project and thank Geoff Hutchison for port
guidance in the implementation PR and project attribution. Cite Rappé et al. for UFF
and use the upstream optimizer's references, “Guénolé 2020” for FIRE2 and
“Echeverri Restrepo et al. 2023” for ABC-FIRE. Full titles and DOIs are
to be filled in before the attribution doc ships.
Preserve the no-endorsement language. ChemDraft's core remains Apache-2.0.
Upstream `LICENSE`, `avogadro/calc/energyoptimizer.h:41`,
`avogadro/calc/energyoptimizer.cpp:276` and `AGENTS.md` §4.7.

- **UFF parameter data.** `avogadro/calc/uffdata.h:1,6` is BSD-3-Clause and says the table was
  formatted from RDKit's `Code/ForceField/UFF/Params.cpp`. The file names no separate
  data license and links to a moving branch. The repository has RDKit's BSD-3-Clause text in
  `packages/rdkit-adapter/vendor/RDKit-LICENSE.txt`, which confirms the vendored RDKit build
  terms. The exact source revision and header for the imported table are unavailable in
  these offline copies. Before redistribution, archive a matching RDKit source/license
  snapshot and check parameter lineage and any separate terms. Include the applicable full
  RDKit copyright/terms, plus the Avogadro notice, with the data. Record any BSD-compatible
  changes to the table separately from code adaptation.
- **Excluded upstream dependencies and data.** The CppOptLib derivatives and L-BFGS
  headers are MIT (Patrick Wieschollek and contributors), under
  `thirdparty/cppoptlib/LICENSE` and their headers. The upstream Core target uses
  fast_float, whose accompanying choices are listed under
  `thirdparty/fast_float/LICENSE-{APACHE,BOOST,MIT}`. Eigen is a separate header-only
  dependency with MPL-2.0 and some LGPL modules. The existing sidecar build restricts
  it to MPL-2.0. No Eigen or CppOptLib implementation is copied into the Rust port.
  The reference build remains an offline development tool. No Avogadro element data
  is copied. `avogadro/core/elementdata.h:51,272,423` cites IUPAC, Jmol and NIST for
  different tables without declaring separate terms in that header. No EEQ tables
  or external molecule datasets are involved. `avogadro/calc/CMakeLists.txt:4,34`,
  `avogadro/core/CMakeLists.txt:147`, `native/avogadro3d-sidecar/CMakeLists.txt`,
  `docs/architecture/dependency-inventory.md:109`.

Propose two new entries in both `NOTICE` and
`docs/architecture/dependency-inventory.md`, with the full accompanying license texts
bundled from a stable location. Update the license resources in Tauri and
`tools/release/required-license-files.mjs` in the same PR. Keep the existing Core/Calc
and Eigen sidecar entries during migration. Remove the sidecar-specific entries at
retirement after checking other shipped consumers. Leave independent Eigen and RDKit
notices for their own packages. `NOTICE:89,220,229`,
`docs/architecture/dependency-inventory.md:92,109`,
`apps/desktop/src-tauri/tauri.conf.json:42`.

| Entry | Content |
| --- | --- |
| Avogadrolibs UFF and ABC-FIRE (adapted Rust source) | BSD-3-Clause, Copyright (c) 2011-2020, Kitware, Inc. Avogadro project and Geoff Hutchison attribution, upstream commit, ported source paths, modifications, location of full text, and that it is compiled into desktop ChemDraft. Include the source URL and mark the artifact as built with the app. |
| UFF parameter table (Avogadro adaptation of RDKit data) | Record the checked RDKit source and applicable BSD-3-Clause copyright/terms, the Avogadro adaptation at the port pin, a table hash, the original data reference, and location in the Rust source and license bundle. This is a separate data entry from the existing RDKit WASM artifact. |

No new Rust crates are planned. Fixed-size vector math for three-dimensional geometry,
scalar loops for FIRE and a small fixed-size proper-rotation fit account for the
numeric work. Serde and Tauri are already in `apps/desktop/src-tauri/Cargo.toml`.
Any decision to adopt a math crate would require a separate license and size review.

Verbatim BSD-3-Clause text from upstream `LICENSE` at the port pin.

```text
Copyright (c) 2011-2020, Kitware, Inc.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
    list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
    this list of conditions and the following disclaimer in the documentation
    and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors
    may be used to endorse or promote products derived from this software
    without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR
TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Delivery sequence

When this slice is activated, link this plan from `docs/plans/PLANS.md` and preserve the
unrelated active slice.

1. **Provenance and oracle.** Block fixture generation on the owner's hydrogen and
   element-support decisions. Resolve the table rights, capture the approved source
   revisions, write the harness and freeze the fixture partition and gates. Run the
   frozen ABC-FIRE and Hybrid comparison, including the release tail, and record the
   resulting optimizer requirement. Commit repeatable input/output fixtures and
   verify the harness against unmodified Avogadro evaluation. Capture v2 smoke traces
   with seeds, options and targets.
   Acceptance requires stable fixture checksums on repeated runs of the pinned host
   build and documented differences between the two reference revisions.
2. **Static-link decision gate.** Before the Rust port starts, build a minimal release-mode
   Tauri proof of life that calls static Avogadro Core/Calc through a C ABI on Apple
   silicon, Intel macOS and Windows x64. For each target, record Cargo/CMake and toolchain
   changes, SDK/deployment or CRT settings, added build steps and clean and incremental
   build times. Compare stripped executable and compressed installer deltas against
   matching baseline builds. On Windows use the CI-built installer. Use caller-owned
   buffers and show that malformed input and a forced C++ exception return typed
   failures across the boundary. Compare measured UFF energy, gradients, optimizer
   behavior and runtime on small frozen inputs against the standalone pinned oracle.
   Compare those results and maintenance costs with the Rust scope, size and parity-work
   estimates, and record any unmeasured Rust costs as estimates. Rust remains the
   preference for a single Cargo build and long-term maintenance. The owner chooses
   after reviewing the measurements. Record the rationale before starting the port.
   If the owner chooses C++, revise the implementation steps before work starts.
3. **Topology and bonded energy.** Implement immutable indexed input, ordered table,
   type report and bond/angle setup. Include the two license entries and full text.
   Acceptance requires exact validated typing, tuple and mask equality, bond and
   angle energy and gradient gates, and rejection of out-of-range or incomplete types.
4. **Torsion, inversion and vdW.** Finish the five-term model and analytic derivatives.
   Verify per-term and total parity, numerical derivatives, cutoff behavior and
   deterministic exclusions on all target test hosts. Measure pair-cache speed and
   confirm it agrees with the all-pairs reference at each geometry.
5. **Optimizer and drag policy.** Implement the method required by the oracle gate.
   Add stateful chunking, masks, geometry/stereo guards and alignment. Pass checkpoint,
   endpoint, frozen-coordinate and fixed-target state gates plus the existing geometry
   and sustained-drag assertions through a Rust session test.
6. **Tauri v3 bridge PR.** Land the typed bridge behind the developer selector with v2
   still the shipped default. Verify stale-session handling, bounded queues, timeout,
   repeated cancel, wheel/rotation overlap, final revision selection and graph/stereo preservation
   through the normal UI and flatten entry points. Update `packages/engine3d-api/README.md`
   with separate v2 newline-delimited stdio and v3 typed Tauri contracts. Freeze the
   packaged benchmark machines, build settings and replay files.
7. **Native default PR.** Run the packaged drag and release benchmark. Confirm the
   owner-approved element coverage and hydrogen policy with the frozen product
   fixtures. Run the root TypeScript, Vitest and build gauntlet, Rust fmt/clippy/test,
   all named Spin 3D suites, `git diff --check`, the sidecar baseline smokes while retained,
   and the native smoke on the platform matrix. Update and run
   `docs/manual-stress-checklist.md` on both Mac architectures and Windows, with a Linux
   desktop smoke. Record app and installer size, verify the worktree launch label
   and bump the app build stamp as required by `AGENTS.md` §14–16. Switch the default
   after all numerical, product and platform gates pass.
8. **Retire v2.** Remove the helper and packaging dependencies after native-default
   verification. Require a bundle scan on each platform, packaged license verification,
   and a complete native tug-to-flatten smoke with no helper installed. Retain reference
   fixtures and close out the slice per `AGENTS.md` §16.

## Owner decisions

- Confirm the first release moves Interactive 3D mechanics only. Should native UFF also
  replace RDKit UFF for ordinary conformer refinement in a later slice?
- Before PR 1 fixture generation, choose drawn-atom UFF or mapped explicit H. Confirm
  the selected graph and its energy claims before cutover.
- Before PR 1 fixture generation, approve the proposed refusal matrix or require a
  separately validated corrected table. Confirm the resulting coverage before cutover,
  including any loss of Interactive 3D for organoiodine input.
- After the static-link proof of life, choose Rust or C++ and record the rationale
  before the Rust port starts.
- Should the developer-only torsion-trial anneal be ported before retirement, or should
  the first native release use only the default settle? Should users ever be able to select
  an optimizer, or should ABC-FIRE remain an internal method?
- Approve the ABC-FIRE versus Hybrid release criteria before running the oracle comparison.
  Confirm that metals and coordination beyond validated cases stay out of the initial scope.
- Confirm the length of the temporary v2 rollback period and whether Linux aarch64
  verification is required for this release or before a future aarch64 package.

## Review changes

1. Refresh FIRE's cached energy and gradient after coordinate changes and test fixed-target chunks.
2. Compare ABC-FIRE with Hybrid in the oracle PR and define the release gates and fallback.
3. Make hydrogen handling a blocking owner decision and specify fixture and energy requirements.
4. Add the element support matrix, iodine and antimony fixtures, and a blocking coverage decision.
5. Require a cross-platform C ABI/static-link proof before the Rust port decision.
6. Split the bridge and default PRs and define the packaged latency benchmark.
7. Update the protocol README in the bridge PR and link this plan when the slice is activated.
8. Attribute the web build's unreleased status to the owner-relayed maintainer comments.
9. Quote the optimizer's author/year references and defer full titles and DOIs to attribution closeout.
