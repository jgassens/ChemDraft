# Evaluation: can Avogadro's WebAssembly build replace the native 3D sidecar?

Status: research note, 2026-11-22. This note changes no code. It answers the owner's question in
[issue #164](https://github.com/jgassens/ChemDraft/issues/164) and sits beside
`docs/plans/spin3d-native-forcefield.md` (branch `plan/spin3d-native-forcefield`), the plan behind
PRs [#413](https://github.com/jgassens/ChemDraft/pull/413) and [#414](https://github.com/jgassens/ChemDraft/pull/414).

**Short answer: no, not now.** Today the public Avogadro WebAssembly build is a whole Qt editor
application. It is not a mechanics library that can be called from JavaScript. Its optimizer needs
the multithreaded build, so it needs `SharedArrayBuffer` and cross-origin isolation, and the wasm is
about 6.3 MB compressed. It also links Qt statically, and Qt's loader is marked
`LicenseRef-Qt-Commercial OR GPL-3.0-only`. Recommendation: **keep the sidecar for now. Revisit a
headless Avogadro WASM later, behind the same session protocol, once upstream ships a library
profile.** Meanwhile #413 and #414 are the other path to removing the per-platform binary (§6).

## 1. What the sidecar does today

**Where it lives.** The source is `native/avogadro3d-sidecar/src/main.cpp` (2,079 lines, C++17). It
statically links avogadrolibs Core and Calc at the pinned commit `416651dd…`, plus Eigen 3.4.0 built
with `EIGEN_MPL2_ONLY`. Only Open Babel and the GPL plugins have fatal CMake guards
(`native/avogadro3d-sidecar/CMakeLists.txt:27-33`). The presets turn off Qt, Python, spglib and
libmsym, and `pnpm audit:engine3d-sidecar` checks those settings as text. The app sends it a V2000 molfile and
the seed coordinates of the current conformer, keyed by atom ID.

**It does not embed or search conformers.** Conformers come from the RDKit MinimalLib WASM (ETKDGv3,
then MMFF94, MMFF94s or UFF) or from OpenChemLib, in a web worker. The sidecar only relaxes and
drags an existing geometry with UFF.

Calls against `packages/engine3d-api`. `Engine3DProtocolVersion = 2`; transport is newline-delimited
JSON over stdio, at most 4 MB per message. Rust starts the binary with `engine3d_sidecar_start_session`
and relays lines with `_send_session`, `_poll_session` and `_stop_session` (`lib.rs:8529–8900`); the
web side polls every 80 ms (`engine3dSidecar.ts:87`).

| Request | Input | Sidecar work | Output |
|---|---|---|---|
| `createSession` | V2000 molfile, `atomIdByMolfileIndex`, graph and bond signatures, optional `coords3dByAtomId` seed | Parse the atoms, bonds and formal charges; add deterministic depth jitter to planar seeds; build the UFF model once and cache it; run 18 iterations of Hybrid optimization (ABC-FIRE, then L-BFGS, `maxMove` = 0.18 Å) | `response`, a `ready` event (capabilities `forceField: "UFF"`), `coordinatesChanged` (`embed`, then `initial-relax`), `energyChanged` |
| `beginDrag` | `atomId` | Pin the atom | `response`, `selectionChanged` |
| `updateDrag` | `atomId`, world-space target | Clamp the target; relax a local shell (graph radius 4) for about 3 iterations, with FIRE state kept across frames; reject unsafe steps; remove rigid-body drift (Kabsch) | `response`, `coordinatesChanged` (`drag`), `energyChanged` |
| `endDrag` | `atomId`, `cancelled?` | Reset the optimizer; widen the shell; run guarded chunks; realign. An annealed settle is available but off by default (`CHEMDRAFT_ENGINE3D_ANNEAL_SETTLE`). The sidecar transmits `cancelled` but gives it no cancellation meaning | `response`, `coordinatesChanged` (`settle`), `energyChanged` |
| `commit` | — | Snapshot | Coordinates, revision, both signatures, engine name and source commit, the force-field report (`avogadroBacked: true`) |
| `ping` / `dispose` | — | Heartbeat or teardown | `response`, then `heartbeat` / `closed` |

**Performance.** No per-frame timing budget is recorded in the repo. `updateDrag` normally returns
its frames through the send call (`apps/desktop/src/engine3dSidecar.ts:233-252`); the 80 ms poll is
a separate path. `CHEMDRAFT_ENGINE3D_TIMING` prints phase timings to stderr, but no benchmark file
holds them. Three smokes check behavior, not speed. The workflow
`.github/workflows/macos-intel-smoke.yml` runs them on `macos-15-intel`. `.github/workflows/ci.yml`
runs the Rust `engine3d_sidecar_` tests on Linux (`ubuntu-22.04`) and `cargo test` on
`macos-latest`, but none of the three smoke scripts. This note did not check other hosts.

- `smoke:engine3d-real-structure`: a 43-atom charged structure;
- `smoke:engine3d-hold-steady`: 200 frames held at one target;
- `smoke:engine3d-anneal-energy`: n-octane.

**Cost per platform** (from `apps/desktop/src-tauri/binaries/` and `dependency-inventory.md`):

| Target | Binary | Built by | Extra work |
|---|---|---|---|
| macOS arm64 | 1,131,120 B, committed | CMake `protocol-scout` on a Mac | Minimum OS 11.0; signed and notarized inside the bundle |
| macOS x86_64 | 1,245,280 B, committed | `protocol-scout-x86_64`, cross-built on Apple silicon | Intel smoke workflow; Rosetta needed for local smokes |
| Windows x64 | 1,069,056 B, committed | `windows-msvc` preset, static CRT | Signed with the installer |
| Linux (beta) | 141-byte placeholder | none | 3D reports itself unavailable (`docs/releasing/linux.md:274`) |

Each avogadrolibs or Eigen bump means rebuilding on two hosts, committing three binaries, rerunning
the audit and smokes, and updating the `NOTICE` rows.

## 2. What Avogadro's WebAssembly build provides

The facts below come from public sources read on 2026-11-22: avogadrolibs HEAD `7c730c3`
(2026-11-21) and avogadro-web HEAD `82d1cb0d` (2026-11-20) (both unverified; no direct commit link was read).

- **Prototype: [web.avogadro.cc](https://web.avogadro.cc/).** Its [`build-manifest.json`](https://web.avogadro.cc/build-manifest.json) reads Qt 6.11.1,
  Emscripten 4.0.7, profile "Release, wasm_multithread", avogadrolibs `61ce6da0`.
  - Assets: `avogadro-web.wasm` is 17,553,200 B raw (6,523,457 B gzip, 6,294,046 B brotli), plus
    about 300 KB of JS (`avogadro-web.js` 251,671 B, `qtloader.js`, editor scripts). Sizes are
    unverified; they were not re-read for this revision.
  - Status: the project maintainer called it "not a release" in #164 (2026-11-17), and the downloads
    come from a `continuous` tag whose README calls them development builds (both unverified; no
    direct comment or README link was read).
- **Upstream build.** [avogadrolibs#2868](https://github.com/OpenChemistry/avogadrolibs/pull/2868)
  ("Initial WebAssembly build") was merged 2026-11-13, and
  [#3354](https://github.com/OpenChemistry/avogadrolibs/pull/3354) ("Enable editing and calculation
  plugins in WASM") on 2026-11-15. That `build_wasm.yml` builds with `-DAVOGADRO_WEB_EDITOR=ON` is
  unverified.
  - The Emscripten branch of the top-level CMake **requires `USE_QT` and `USE_OPENGL`**
    ([`CMakeLists.txt`](https://github.com/OpenChemistry/avogadrolibs/blob/master/CMakeLists.txt):
    `EMSCRIPTEN requires USE_QT=ON and USE_OPENGL=ON for its viewport`), so the build
    is the Qt GUI stack (qtgui, rendering, qtplugins), not a headless core + calc module.
  - Library-only "WASM kit" profiles are still open draft PRs
    ([#3377](https://github.com/OpenChemistry/avogadrolibs/pull/3377) headless editing,
    [#3378](https://github.com/OpenChemistry/avogadrolibs/pull/3378) both library profiles). No
    release includes them (unverified beyond the draft state).
- **[avogadro-web](https://github.com/OpenChemistry/avogadro-web)** (BSD-3-Clause, created
  2026-09-14 (unverified)) is the HTML/JS shell. It ships a multithreaded ZIP and a single-threaded ZIP. In the
  single-threaded one, worker-based calculations (optimization, AutoOptimize, surfaces) are
  unavailable. [PR #19](https://github.com/OpenChemistry/avogadro-web/pull/19), which would have run Open Babel in
  a worker, was closed unmerged on 2026-11-17. The license, creation date and the two ZIP packages
  are unverified.
- **Chemistry**
  - Force fields (unverified: no direct file links were read): UFF and Lennard-Jones only. `avogadro/calc` holds `uff`, `lennardjones`,
    `eeqmodel`, `energyoptimizer` (optimizers `Lbfgs`, `Fire2`, `AbcFire`, `Hybrid`) and vendored
    cppoptlib.
  - MMFF94 and GAFF exist only through Open Babel (`qtplugins/forcefield/forcefield.cpp`, under
    `BUILD_GPL_PLUGINS` or `AVOGADRO_USE_SUBPROCESS`); neither is available in WASM (unverified).
  - Interaction: the web editor has an AutoOptimize tool (live UFF while editing) and "Optimize
    Geometry" (unverified).
  - Not available: no conformer generator and no SMILES to 3D (unverified for the generator;
    [`smilesformat.cpp`](https://raw.githubusercontent.com/OpenChemistry/avogadrolibs/master/avogadro/io/smilesformat.cpp)
    reports "Reading SMILES is not supported by this format.").
- **Threads (unverified: no direct file or header link was read).** `core/avogadro-editor.js` throws unless the page is cross-origin isolated (COOP
  `same-origin`, COEP `require-corp`). It uses a pthread pool of 4, and the site sends those headers.
  - ChemDraft would have to serve every document webview with COOP and COEP on WKWebView, WebView2
    and WebKitGTK alike.
  - Tauri 2 has a config hook for custom response headers, but none of this was tested here. COEP
    would also constrain every other subresource the windows load: installed plugins under
    `/installed-plugins/` and the Vite dev middleware (AGENTS.md §4.3).
  - Today's RDKit WASM is single-threaded and needs none of this.
- **Lazy loading (§13).** A headless module could load in a worker on the first Interactive 3D
  session, the way the RDKit conformer worker already does, and never at startup. The current editor
  build cannot, because it owns its own canvas and Qt event loop. That conflicts with ChemDraft
  owning the 3D panel and rendering (`engine3d-api` README; AGENTS.md §9).
- **Python.** PyPI [`avogadro` 2.1.0](https://pypi.org/project/avogadro/) (BSD-3-Clause, 2026-10-23)
  has native wheels for macOS, Linux and Windows. That it exposes `calc.optimize_steps` is unverified. It has **no
  Pyodide or wasm wheel**; the Pyodide entry in
  [`build_wheels.yml`](https://raw.githubusercontent.com/OpenChemistry/avogadrolibs/master/.github/workflows/build_wheels.yml)
  is commented out. It does not help a
  web view.

## 3. License of what would ship

| Piece | License (text read) | Concern |
|---|---|---|
| avogadrolibs core, calc (`uff.cpp`, `uffdata.h`, `energyoptimizer.cpp`) | BSD-3-Clause, "Copyright (c) 2011-2020, Kitware, Inc." (LICENSE and file headers; unverified, no direct link read) | None. Already in `NOTICE`. No Open Babel attribution or derivation note in the UFF sources |
| avogadro-web shell | BSD-3-Clause, "Copyright (c) 2026, Open Chemistry" (unverified) | None |
| avogadrolibs `thirdparty/` | cppoptlib MIT; nlohmann MIT; pugixml MIT; struct MIT; tinycolormap MIT; toml++ MIT; fast_float Apache/Boost/MIT; gif-h public domain; libgwavi BSD; **gemmi MPL-2.0** (all unverified: no `thirdparty/` license file links were read) | MPL-2.0 is file-level copyleft, acceptable the way Eigen is. It is likely only pulled in by io/structure readers a headless calc build would not need (not confirmed) |
| Eigen | MPL-2.0 (already shipped MPL2-only) | Keep `EIGEN_MPL2_ONLY` in any WASM build |
| **Qt 6.11.1**, statically linked into the editor wasm | [`qtloader.js`](https://web.avogadro.cc/qtloader.js) header: `SPDX-License-Identifier: LicenseRef-Qt-Commercial OR GPL-3.0-only`. The rest of Qt's license text was not read | **Blocking for the sidecar-style distribution.** GPL-3.0-only code may not be linked into Apache-2.0 ChemDraft, and statically linked LGPL Qt modules bring relinking obligations. A headless build must have no Qt |
| Open Babel | GPL-2.0 | Not in the WASM build (#19 closed). Must stay out |

Conclusion: for the sidecar's own dependencies, a **Qt-free core + calc** WASM build would be as
permissive as today's sidecar (BSD-3 + MPL-2.0 Eigen). The **published editor build is not
shippable** in ChemDraft. This is a narrow conclusion, not a claim that GPL code never ships: `NOTICE`
(lines 193-198) records OpenJDK, shipped under GPL-2.0-only with the Classpath exception.

Risk: a Qt-free core + calc WASM build still needs its own dependency-closure license audit. That
audit covers cppoptlib, gemmi, the Emscripten runtime, `NOTICE` and inventory entries, and MPL-2.0
source availability.

## 4. Gap table

| Capability the sidecar has | Avogadro WASM today | Planned upstream | RDKit MinimalLib WASM (already in app) |
|---|---|---|---|
| UFF energy and gradient | Available, inside the Qt editor only | JS-callable library profile in open draft PR #3378 (unverified that it exposes JS-callable UFF) | UFF and MMFF94/94s via `optimize_3d_conformer`, whole-molecule only |
| ABC-FIRE / Hybrid optimizer, resumable chunks (`optimizeSteps` + `OptimizerState`) | In calc; not exposed to JS | Same | No (RDKit's BFGS minimizer, one shot) |
| Coordinate mask: pinned atom and mobile shell | `EnergyCalculator` mask in calc; not exposed | Same | No fixed-atom or mask option in the vendored patches |
| Live drag (begin/update/end), FIRE momentum across frames | AutoOptimize tool in the editor UI, driven by Qt mouse events | "Yes … start small" (maintainer, #164; unverified, no direct comment link) | Missing |
| Kabsch drift removal, step guards, annealed settle | Missing (ChemDraft's own policy code in `main.cpp`) | — | Missing |
| Session protocol / commit validation | Missing | WebMCP tools ([avogadro-web #30](https://github.com/OpenChemistry/avogadro-web/pull/30), open draft) are a different surface | n/a |
| Single-threaded operation | Optimization unavailable in the single-thread build | Not stated | Yes, single-threaded |
| Conformer embed / search | Missing | No plan stated; SMILES to 3D "is always the catch" (unverified quote) | **ETKDGv3, shipping** |
| MMFF94 / GAFF | Missing (Open Babel only) | Not without GPL | MMFF94, MMFF94s |
| Linux and Intel Mac coverage | Unverified: whether a web view on WKWebView, WebView2 or WebKitGTK runs the wasm | — | Already everywhere |

Net: the only piece Avogadro WASM would add over RDKit WASM is the **interactive** UFF/FIRE drag
loop, and that loop is exactly what is not yet callable from JavaScript.

## 5. Chemistry invariants (AGENTS.md §7)

Coordinates are the only thing any engine returns. Atom IDs, elements, bonds, charges and stereo stay
owned by ChemDraft, and `validateEngine3DCommit` rejects any change of signature, atom set or a
non-finite coordinate. The app-side stereo guard in `engine3dSidecar.ts` rejects frames that invert
specified stereocenters. Risks that a WASM swap could introduce silently:

- **Hydrogens.** The sidecar relaxes the drawn graph only, while RDKit embeds with `addHs`. Avogadro's
  editor adds hydrogens on its own when building. A headless port must not add or remove atoms; the
  hidden-H choice belongs to #414's open owner decision.
- **Unknown elements.** `main.cpp` pads missing elements with `"C"`
  (`elements.resize(..., "C")`), and Avogadro's UFF table has shifted rows from Sb (Z 51) upward
  (documented in #414). Any replacement, WASM or Rust, must refuse rather than retype. Neither the
  WASM editor nor upstream calc refuses today.
- **Charges and bond orders.** UFF in calc has no electrostatic term. The sidecar reads formal charge
  only for typing and treats aromatic and other bond codes as single. A WASM path must receive the
  same Kekulé orders (`nativeBondOrderResolution`) or typing changes.
- **Stereo.** A force field can still pass through a planar inversion during a large drag. The
  existing guard must stay engine-independent, in TypeScript, for any backend.

**How results would be checked against today's sidecar.** Run both backends through the same
`engine3d-api` transcript and compare:

- the three `smoke:engine3d-*` scripts, pointed at a WASM adapter;
- #413's 113 Avogadro UFF reference snapshots (energy, per-term values, gradients), at its tolerances;
- the §9 suites `spin3dModel`, `spinFlatten`, `spinFlattenStereo`, `flattenRoundTrip`,
  `spinOverlay` and `rotation3d`, plus `MainWindow.spinFlattenChemistry.dom.test.tsx`, on committed
  coordinates;
- a fixed corpus for canonical SMILES, formula, charge and stereo before and after commit.

## 6. Recommendation and phased plan

**Keep the sidecar now; replace later behind the same session contract.** Neither Avogadro WASM nor
a Rust port should change what Spin 3D does. Each is a backend behind one `Engine3D` session
interface (begin/update/end drag, commit, validated by `validateEngine3DCommit`).

What this means for #413 and #414:

- **#413 (reference fixtures) is backend-neutral and worth merging.** It becomes the parity oracle
  for any replacement, WASM included.
- **#414 (Rust UFF port) is the other candidate for removing per-platform C++ binaries.** It would be
  one Cargo build that runs wherever the app runs, with no `SharedArrayBuffer` and no Qt. Which route
  is faster or cheaper is an open question. This note has no evidence either way;
  `docs/plans/spin3d-forcefields.md` is an older Open Babel plan and does not settle it.
- A WASM backend would overlap with #414's outcome. Its gain is to follow upstream UFF changes
  instead of re-porting them. That is worth having only once upstream ships a headless profile.

Phases:

1. **Now (no app change):** finish the owner decisions in #414 (hydrogen model, the shifted-table
   policy, FIRE vs Hybrid). Track upstream PRs #3377 and #3378 and avogadro-web releases. Keep the
   sidecar shipping.
2. **Spike, when #3378 lands or by hand:** build a Qt-free, **single-threaded** core + calc
   Emscripten module from the sidecar's pin with `EIGEN_MPL2_ONLY`. Expose
   `setMolecule / setMask / optimizeSteps(state)` through Embind, and run it in a dedicated worker.
   Measure:
   - wasm size;
   - init time;
   - per-frame time on the 43-atom smoke structure, on all three webviews.

   Do not enable COOP/COEP.
3. **Feature flag:** add an `Engine3DBackend` choice (`sidecar` | `native-rust` | `wasm`) in
   Preferences ▸ 3D refinement, as experimental and off by default. Run side-by-side comparison
   under the existing smokes and #413 fixtures, and add a dev-only diff mode that runs two backends
   on the same transcript.
4. **Removal:** once one in-process backend passes every gate on macOS arm64 and Intel, Windows, and
   Linux, make it the default for one release. Then delete `externalBin`, the five
   `engine3d_sidecar_*` commands, the committed binaries and their `NOTICE` rows, and bump
   `Engine3DProtocolVersion` as #414's plan already proposes.

**Concrete next task:** merge #413, then add a TypeScript `Engine3dBackend` interface in the app with
the current sidecar as its only implementation. That is a no-behavior refactor with tests on the
fake session. Later, #414's Rust backend or a WASM worker can each drop in behind it without
touching Spin 3D.

## What could not be verified

- **Webviews:** whether the Avogadro wasm, threaded or single-threaded, runs in WKWebView, WebView2
  or WebKitGTK. Nothing was executed in any webview; upstream tests cover Chrome and Firefox.
- **Tauri headers:** that Tauri's header configuration delivers working cross-origin isolation on all
  three platforms, and how it interacts with the installed-plugin scheme.
- **Headless build:** the size and speed of a headless core + calc wasm. None was built.
- **Qt's terms:** the full Qt license terms. Only the `qtloader.js` SPDX header was read.
- **gemmi:** whether gemmi (MPL-2.0) would end up in a calc-only build.
- **#2868 details:** its full file list, and the merge dates, which come from the GitHub web pages
  rather than the clones.
- **Performance:** the sidecar's real per-frame timings. No benchmark is recorded in the repo.
