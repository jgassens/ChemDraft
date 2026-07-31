# Building the IsoSpec WASM artifact (isotope envelopes)

IsoSpec is the isotope-envelope engine. It is here because **neither the vendored RDKit MinimalLib
nor OpenChemLib 9.22.1 exposes per-isotope abundances** — checked directly, not assumed (see
`docs/architecture/dependency-inventory.md`). Without an abundance table there is no envelope, only
the first-order M/M+1/M+2 approximation that `examples/plugins/mass-fragment-demo` still ships.

**IsoSpec itself is unpatched.** Unlike the RDKit vendoring, there are no patches: the library is
compiled as-is and reached through a thin Embind wrapper of ours (`src/chemdraft_isospec.cpp`). Keep
it that way — the patch budget PLANS.md §7 tracks is a real cost, and nothing here needed one.

## Pin
- Release tag: **`v2.3.5`**
- Commit: **`e6b1ef7cc146632cdaaf887dcff8c73949167835`**
- License: **BSD-2-Clause**, © 2015–2025 Michał Startek and Mateusz Łącki. Notice file
  `IsoSpec-LICENCE.txt`, vendored beside the artifact. Binary redistribution must reproduce the
  copyright notice, conditions, and disclaimer in the accompanying materials.

> ⚠️ **Pin by commit, not by version string.** At the `v2.3.5` tag the in-tree
> `CMakeLists.txt` still reads `project(IsoSpec VERSION 2.3.4)`. The two disagree, so neither string
> alone identifies the source. `-DCHEMDRAFT_ISOSPEC_VERSION` is set from the *tag* at build time, and
> `PINNED_ISOSPEC_COMMIT` in `src/index.ts` records the SHA.

## Our wrapper (`src/chemdraft_isospec.cpp`)
Exposes four functions, each returning JSON — the same idiom as MinimalLib's `generate_3d_embed`:

| Function | Purpose |
|---|---|
| `envelope_from_threshold(formula, threshold, absolute)` | `FixedEnvelope::FromThreshold` → `DistributionResult.truncation.policy` `"relative-intensity-threshold"` (or `"absolute-probability-threshold"`) |
| `envelope_from_total_prob(formula, targetProb, optimize)` | `FixedEnvelope::FromTotalProb` → policy `"cumulative-probability"` |
| `isotope_table()` | The abundance set **compiled into this binary**, so provenance can be read from the artifact rather than trusted from source |
| `version()` | The pinned tag, injected at compile time |

A malformed formula returns `{"ok":false,"error":…}`. It must not throw across the Embind boundary:
an uncaught C++ exception aborts the whole WASM instance and would take the worker with it.

## Build
Requires Docker (Colima). Reuses `rdkit-minimallib-deps:latest` **purely as an Emscripten toolchain**
(emsdk 6.0.0) — the same compiler that produced `RDKit_minimal.wasm`. IsoSpec has no third-party
dependencies, so nothing else from that image is used; it avoids a second multi-GB emsdk download and
keeps both WASM artifacts on one toolchain. Build it first if it is missing (see
`packages/rdkit-adapter/vendor/BUILD.md`). The compile itself takes well under a minute.

```bash
# 1. Fetch the pinned tag.
git init isospec-src && cd isospec-src
git remote add origin https://github.com/MatteoLacki/IsoSpec.git
git fetch --depth 1 origin refs/tags/v2.3.5
git checkout FETCH_HEAD
cd ..

# 2. Lay out the build context: isospec-src/ beside a wrapper/ holding chemdraft_isospec.cpp,
#    with src/Dockerfile.isospec at the root. Then:
docker build -t chemdraft-isospec:latest -f Dockerfile.isospec .

# 3. Export. The final stage is FROM scratch, so `docker create` needs a placeholder command even
#    though the container never runs. (`docker build -o` would need buildx, which is not installed.)
docker create --name=isospec-export chemdraft-isospec:latest /placeholder
docker cp isospec-export:/IsoSpec.js          ./out/
docker cp isospec-export:/IsoSpec.wasm        ./out/
docker cp isospec-export:/IsoSpec-LICENCE.txt ./out/
docker rm isospec-export
```
`unity-build.cpp` `#include`s every other `.cpp` — IsoSpec's own "poor man's LTO" — so the library
plus our wrapper is a single translation unit. `-fwasm-exceptions` matches the RDKit artifact and is
**required**, not stylistic: the wrapper catches `std::invalid_argument` from formula parsing.

## Vendor + pin the output
```bash
cp out/IsoSpec.js          packages/isospec-adapter/vendor/IsoSpec.js
cp out/IsoSpec.wasm        packages/isospec-adapter/vendor/IsoSpec.wasm
cp out/IsoSpec-LICENCE.txt packages/isospec-adapter/vendor/IsoSpec-LICENCE.txt
shasum -a 256 packages/isospec-adapter/vendor/IsoSpec.{js,wasm}
```
Record the `.wasm` hash **both** here and in `PINNED_ISOSPEC_WASM_SHA256` (`src/index.ts`).
`isospec.real.test.ts` checks this file, the constant, and the bytes on disk against each other.

- `IsoSpec.js`   (30 KB)  SHA-256: `52d17eb836f8e75abcede03439f404f666bcdd825b2e7faddaa029bc408840f8`
- `IsoSpec.wasm` (234 KB) SHA-256: `6cff998904cd567eba2e010d6d0fd384e346e21689c66dbef583997a13c37b66`
- Built 2026-07-30 from `v2.3.5` (unpatched) via Colima/Docker with emsdk 6.0.0.
- Loading the vendored `.js` with `require()` fails (`initIsoSpecModule is not a function`): the
  package is `"type": "module"`, so a `.js` under it is treated as ESM and `module.exports` never
  runs. `src/testing.ts` evaluates the glue in a fresh function scope instead.

## Formula syntax — the one real trap
IsoSpec requires an explicit count on **every** element: `H2O1`, never `H2O`. A trailing implicit 1 is
**rejected**, not mis-parsed — verified against the binary, and the safe failure mode. But RDKit's
Hill formula writes `C10H11N3O3S`, so it cannot be passed through unchanged. `explicitFormulaCounts()`
does the expansion and is tested against the engine, not just against a regex.

## The abundance set is a convention, and has to be disclosed
IsoSpec's element tables carry **no provenance in its own repository** — no citation, no generator
script (`tools/gen.py` builds amino-acid tables, not element ones). What can be stated is measured
from the artifact:

- 292 isotopic entries, plus explicit `electron` / `missing electron` entries for charge.
- Every element's abundances are normalised to sum to exactly 1 (within 1e-12).
- Masses agree with published AME values to ~1e-9.
- **Abundances differ from the commonly quoted CIAAW representative values**, most visibly for carbon:
  ¹³C is `0.010788058149533084` here against CIAAW's representative `0.0107` — **0.82% relatively
  higher**. For C₂₀ that moves the M+1 intensity from 0.21400 to 0.21576.

This is not an error. CIAAW publishes carbon as an *interval* (0.9884–0.9904) precisely because
isotopic composition varies by source, and IsoSpec's value sits inside it. But the intensity a user
sees depends on which set is in use, so it belongs in the method contract as a named convention —
the same treatment TPSA's `includeSandP` gets. `isotope_table()` exists so the claim can be checked
against the shipped binary rather than against source that may not be what was built.
