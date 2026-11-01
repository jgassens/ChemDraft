# PEG host–guest clash investigation (2026-10-26)

Reproduce with `CHEMDRAFT_PROFILE_CLASH_3D=1 pnpm vitest run --configLoader runner --no-cache apps/desktop/src/chemistry3d/clashPerformance.test.ts`.
Dependencies were reused locally; no installation or network access was used.

The fixtures use the supplied CBPQT4+ SMILES and four identical
`CH2O(CH2CH2O)nCH3` arms on the outer TTF carbons, seed 42, host first, guest second.
PEG2 has 86 heavy/170 explicit-H model atoms; PEG8 has 158 heavy/338 model atoms.
The centred start translates the **whole explicit-H guest centroid** onto the host centroid,
without rotation. The alternate start keeps the embedding's separated component placement.
The original Windows coordinates/centroid implementation were not supplied: this reproduces the
converged-clash failure, not the exact reported 1906.94 kcal/mol / 1.85 A coordinate trajectory.

## Cause

The centred PEG8 start has a closest contact of 0.458268 A. Guest bonds 144–145 and
145–146 pierce the small-ring surface of host atoms 22–27. After minimization, guest
bond 135–136 pierces host ring 9–14. These are global one-based model indices, determined
by segment/triangle-fan intersections in the diagnostic fixture, not a new product topology claim.

| Experiment (MMFF94s, interactions on) | Requested iterations | Status | Energy, kcal/mol | Closest heavy contact, A |
| --- | ---: | --- | ---: | ---: |
| Centred PEG8, normal 1,000-step passes | 10,000 total | converged | 1736.552486 | 1.831606 |
| Restart that minimum, rebuilding the field | 20,000 | converged | 1810.881582 | 1.832580 |
| Restart again | 20,000 | converged | 1783.886445 | 1.834643 |
| Restart again | 20,000 | converged | 1903.962329 | 1.828436 |
| Original centred start, one long pass | 20,000 | converged | 1856.097682 | 0.732635 |
| Separated PEG8, normal passes | 14,000 total | converged | 992.522348 | 2.971963 |
| Centred PEG2, normal passes | 1,000 total | converged | 548.207896 | 2.668323 |

The persistent closest pair is N9/C136. It starts at **1.156569 A**, already inside the
10 A cutoff; at every pass it stays around 1.83 A. Increasing the iteration budget and
rebuilding the field three more times does not unthread the guest. The principal persistent
clash is a trapped, ring-piercing local minimum, not exhaustion of the 20,000-step budget.
Atom-centred force fields have no bond/ring-surface exclusion that guarantees unthreading.
RDKit's optimizer convergence flag measures its numerical stopping criterion, not a contact screen.

The cutoff is an additional failure mechanism: the single long pass ends with atoms 36/120
at 0.732635 A although that pair started at **11.788128 A**, outside the field's initial
10 A nonbonded list. Rebuilding each pass can add newly close pairs; it cannot guarantee
escape from the threaded minimum above. The vendored binding fixes the cutoff at 10 A;
this investigation did not rebuild WASM or pretend that an unsupported cutoff option changed it.
Energies change as the cutoff-dependent field is rebuilt; none are binding energies.

## Mac worker timings

Apple M1 Pro, 10 cores, arm64 Node v26.9.0, real vendored WASM in a reusable Node worker.
The machine had substantial external contention: observed load averages reached 51–69.
These are wall times, not an unloaded-machine or browser parity benchmark. Two runs produced
identical geometry/energy results and substantially different times. A preceding run also
exceeded the unchanged 15-second component embed deadline.

The Node worker uses the production job protocol, engine, adapter and flatten helper, including
structured-clone messages. Its local asset reads replace Tauri fetch. It does not measure
WKWebView/WebView2, the asset protocol, or the full conformer worker's other startup imports.
For those measurements, use `VITE_CHEMDRAFT_PROFILE_3D=1` in the desktop build/dev environment.

| Stage | PEG2 | PEG8 |
| --- | ---: | ---: |
| Cold WASM asset read, once | 4.18 ms | already loaded |
| Cold glue evaluation + compile + init, once | 50.32 ms | already loaded |
| Cold worker startup/dispatch/import residual | 229.50 ms | warm |
| Host component embed, including candidate scores | 509.27 ms | 395.27 ms |
| Guest component embed, including rescue/ranking | 768.38 ms | 6684.89 ms |
| Embed host roundtrip | 1614.77 ms | 7091.22 ms |
| Embed parse time, summed (included above) | 59.43 ms | 16.02 ms |
| Centred minimize host roundtrip | 958.99 ms | 43633.29–76926.48 ms |
| Separated minimize host roundtrip | 2849.17 ms | 61424.97–109317.41 ms |
| Minimize parse time, centred (included above) | 12.89 ms | 18.28 ms |
| Flatten separated result | 69.35 ms, success | 514.79 ms, success (two objects, one per component) |
| Warm transport/dispatch residual, embed/minimize | 0.89–0.93 ms | 0.71–2.94 ms |

PEG2 host and guest each make four successful non-random attempts (seeds 42–45), with
one 50-step candidate score each. PEG8 host also makes four successful attempts. Its guest:

| PEG8 guest attempt | Time | Outcome |
| --- | ---: | --- |
| Seed 42, `useRandomCoords: false` | 1454.54 ms | no conformer |
| Seed 42, `useRandomCoords: true` | 3556.82 ms | success |
| 50-step MMFF94s score | 153.73 ms | scored |
| Seed 43, `useRandomCoords: false` | 1471.72 ms | no conformer |

Under earlier contention these same three guest attempts took 2678.80, 8196.36 and
3171.95 ms, plus a 355.01 ms score (14458.91 ms component total).
This is genuine adapter rescue/ranking work; there is no hidden duplicate embed after success.

Each pass requests 1,000 iterations, not necessarily 1,000 actual optimizer steps:

| Fixture/start | Per-pass times, ms |
| --- | --- |
| PEG2 centred | 921.98 |
| PEG2 separated | 924.13, 1014.89, 883.26 |
| PEG8 centred, first completed run | 9216.09, 3940.84, 3915.19, 3931.17, 4010.53, 3994.09, 3925.04, 3960.81, 3973.09, 2575.95 |
| PEG8 centred, later load spike | 4319.12, 6614.20, 15354.48, 11075.70, 5106.62, 7545.75, 7655.56, 7919.43, 6542.69, 4664.91 |
| PEG8 separated, first completed run | 4674.13, 5383.62, 4707.30, 4519.72, 4592.53, 4663.74, 4718.93, 4686.31, 4140.78, 3860.68, 3827.37, 3933.54, 3847.18, 3750.67 |
| PEG8 separated, later load spike | 3796.26, 3789.79, 3790.38, 3810.19, 3892.56, 4295.60, 6783.97, 11346.80, 12361.20, 14065.48, 9250.81, 10463.92, 10455.32, 11041.02 |

The profiling path asserts one WASM initialization across all calls. The production minimizer
parses its optimization molecule once and retains it across passes; the other parses implement
the required input/output stereo checks. WASM embedding/force-field computation dominates the
warm timings. No unjustified engine/cache/algorithm change was made on this evidence.

## Deadline assessment and remaining verification

The existing 15 seconds per embedded component and 60 seconds per minimization do **not**
provide 5x headroom for these fixtures. Even the faster 6.685-second guest embed scales to
33.4 seconds; the 14.459-second sample scales to 72.3 seconds. The 43.633-second centred
minimization scales to 218 seconds; the 76.926-second loaded sample scales to 385 seconds.
The separated case scales to 307–547 seconds and already exceeded 60 seconds on this Mac. The benchmark runs the protocol
directly so it can finish measuring; the real desktop pool would terminate jobs at its deadline.

For a future timeout decision, 90 seconds/component and 600 seconds/minimization would cover
these measured 5x cases with margin before queue time, alongside the existing cancellation path.
First repeat the instrumented case on an idle Mac webview and Windows WebView2 to choose the
budget from comparable samples. **No production timeout was changed here.**

PEG8 flattening succeeds on main `53616751`, which fixed V2000 counts-line parsing for 100 or more
atoms and bonds. The clean PEG8 result flattens to two objects, one per component. The clashing PEG8
model is refused with the new contact message before flattening.
Windows and macOS native/webview hands-on verification remain for the orchestrator.

## Validation and integration note

- Scoped API/host/3D suite: **404 passed, 3 opt-in tests skipped**, using
  `pnpm vitest run --configLoader runner --no-cache --maxWorkers 1 --testTimeout 30000 packages/plugin-api packages/plugin-host apps/desktop/src/chemistry3d`.
  The single worker avoids compounding this host's contention; the original concurrent run hit
  the authoring example's default 5-second test deadline. No test assertion was relaxed.
- Opt-in Node-worker benchmark: **passed**, including the clashing PEG8 flatten refusal and clean
  PEG8 flatten success (222.23 seconds under contention).
- `git diff --check`: **passed**.
- `pnpm lint`: **passed** after the mocked minimization result gained the required `clash` boolean.

## Slow-machine reference: Windows VM (2026-10-26)

Release build of branch `1abbd68d` on Windows in VMware (6 vCPU, Intel i7-10700K at 3.8 GHz),
using WASM in WebView2 and real Plugins-menu runs of a test plugin. The host was a CBPQT4+ complex
with a four-arm PEG-armed TTF guest.

| Complex | Operation | Result |
| --- | --- | --- |
| PEG2 | `embed3d` | 1.7 s |
| PEG2 | `minimize3d` | 1.36 s (MMFF94s, converged, budget 1,000) |
| PEG2 | `flatten3d` | 75 ms |
| PEG2 | Closest contact / clash | 2.668 A / false |
| PEG8 | `embed3d` | 10.5–11.1 s (two components) |
| PEG8 | `minimize3d`, crude centroid-on-centroid start | 31.0 s (converged, budget 5,000, clash true at 1.851 A) |
| PEG8 | `minimize3d`, side-by-side embed placement, maxIters 20,000 | Exceeded fixed 60 s deadline: `minimize3d timed out after 60 seconds including queue time.` |

**Implication.** The host deadlines stay fixed by decision: 15 s per component for embed and 60 s
for minimize. On slower machines, PEG8-size minimization does not fit unless the iteration budget is
small. Callers such as the figure tool must cap 3D minimization size and fall back to 2D layout
beyond that limit, saying so.

## macOS JavaScriptCore (2026-10-27)

The system JSC shell **does not reproduce the reported packaged WKWebView 987–2000 ms
regression**. Both the original and optimized paths are within 1.4x of Node in this harness.
The later WKWebView measurements below identify its cause; these shell measurements establish a
separate, avoidable cost in the real flatten path.

`scripts/profile-flatten-jsc.mjs` uses the existing esbuild dependency to bundle
`flatten3dInWorker`, `flattenPluginModel`, the shared `flattenNativeMolecule3d`, their real
layout/chem-core dependencies and the vendored MinimalLib loader into one minified script.
Both engines execute that same script and load the same WASM bytes from disk. No dependencies
are installed. Browser asset imports reachable through unused document workflows are stubbed;
no flatten implementation or chemistry engine is stubbed.

Reproduce the comparison from the repository root (each command is one line):

```sh
node scripts/profile-flatten-jsc.mjs --model apps/desktop/src/chemistry3d/fixtures/peg2-minimized.json --warm-embed-minimize --stereo-ref 949ac0b6dbb1558090865097db554cc04b678b3d --out tmp/flatten-before
node scripts/profile-flatten-jsc.mjs --model apps/desktop/src/chemistry3d/fixtures/peg2-minimized.json --warm-embed-minimize --compare tmp/flatten-before --out tmp/flatten-after
```

`--stereo-ref` replays the original `stereo.ts` from the named base commit while retaining
the same current stage instrumentation everywhere else. `--compare` fails if either engine's
complete result differs byte for byte. The directories contain the bundled script, raw
per-sample stage events (`node.jsonl`, `jsc.jsonl`), and complete result JSON for each engine.
The script also prints stage medians, call counts, total min/median/max and result SHA-256.
`--engine node` works without JSC (including on Windows); `--jsc` overrides the executable.
Use `--no-minify` to check unminified code. Omitting `--model` generates a new seed-42 PEG2
fixture with the production embed/minimize functions first.

The saved fixture has 170 explicit-H model atoms / 86 retained native atoms: CBPQT4+ and
four-arm PEG2-TTF, guest centred on host, seed 42, MMFF94s with interfragment interactions.
It converged in the first 1,000-step pass at 548.207896 kcal/mol with closest heavy contact
2.668323 A. `--warm-embed-minimize` runs production embed and minimize in **each** measured
process before loading that identical saved model, reproducing the warm worker history.
One flatten warms code/WASM paths; the following seven samples use `view: "auto"`, selecting
identity on the first attempt. No force field runs inside a measured flatten.

Apple M1 Pro, arm64 Node v26.9.0, Darwin 25.6.0, system
`/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc`.
The host was contended (starting load averages 18.80/35.99/35.64); these are wall times.
Stage entries sum both components within each sample, then take the median. Binding rows
are nested within other stages; the view row contains projection through round-trip checks.

| Stage, median ms | Node before | Node after | JSC before | JSC after |
| --- | ---: | ---: | ---: | ---: |
| Contacts | 0.083 | 0.073 | 0.081 | 0.084 |
| Open-double-bond perception | 2.429 | 2.501 | 3.261 | 3.342 |
| Input stereo guard | 11.488 | 0.904 | 13.230 | 1.170 |
| References (including canonical input and molfile graph read) | 3.955 | 4.022 | 5.240 | 5.448 |
| Projection, ring membership, graph backstop and crossings | 1.449 | 1.097 | 1.112 | 1.038 |
| Placement and depth | 0.112 | 0.116 | 0.115 | 0.087 |
| Double-bond side/ring detection | 1.142 | 1.177 | 1.024 | 0.982 |
| Native stereo reconciliation | 1.876 | 1.732 | 2.298 | 2.344 |
| Native molfile serialization | 0.220 | 0.211 | 0.287 | 0.349 |
| Canonical output SMILES round-trip | 1.199 | 1.171 | 1.408 | 1.436 |
| normalizeNativeMoleculeGeometry | 0.016 | 0.017 | 0.020 | 0.022 |
| First auto-view attempt (nested total) | 6.128 | 5.524 | 6.402 | 6.474 |
| All RDKit parses (nested total) | 7.270 | 4.181 | 9.559 | 5.624 |
| RDKit add_hs (nested total) | 5.972 | 0 | 6.410 | 0 |
| **Full profiled flatten** | **24.532** | **13.831** | **29.748** | **18.031** |
| Result structured clone, outside flatten | 0.211 | 0.197 | unavailable | unavailable |
| Host result-schema validation, outside flatten | 0.444 | 0.780 | 0.645 | 0.608 |

Full flatten min/median/max: Node before 22.912/24.532/28.205 ms, after
11.735/13.831/18.109 ms; JSC before 25.041/29.748/34.221 ms, after
15.274/18.031/21.958 ms. The measured JSC after median is 1.30x Node.
The 2D stereo-depiction stage is absent for this stereo-free fixture: its existing fast
path makes zero `set_new_coords` calls. Stereo fixtures retain the depiction and its timer.

### Measured avoidable work and fix

`assertComponentStereo` previously built and reparsed an explicit-H input, serialized/reparsed
the entire 3D component, and read both graphs before comparing the specified tetrahedra and
E/Z bonds. Neither component in this fixture specifies any, so both comparison loops were
empty. The guard now asks RDKit for the signed input's stereo intent and returns before parsing the
output molfile when there is nothing to compare. Specified stereo follows the full explicit-H and 3D
geometry path. The helper is shared with minimization's input/output checks.

The original optimization removed four full-model parses and two `add_hs` calls per PEG2 flatten. For
stereo-free components, the signed-input intent check is the only parse in `assertComponentStereo`;
`flatten3d` still reads every result back through its canonical-SMILES check. Total PEG2 flatten
parses are therefore 13 (down from 19), not 15. It originally reduced the input-stereo stage by about
11–13x on both engines. It does not remove
the contact, isotope, open-E/Z, projection, wedge, canonical output or chemistry identity
guards. No projection/geometry arithmetic or result construction changed.

With deterministic random molecule IDs, all four complete before/after engine results have
SHA-256 `bc812e136619b9e0f0fdc92df49a3db196b1abb4428524eb3972aa391661b640`.
`stereoPerformance.test.ts` pins that complete-result hash and full geometry parsing for tetrahedral/E/Z inputs (including
explicit input H). The required flatten/layout suite passes: 775 tests, four opt-in skips.
`pnpm lint` passes.

### Limits and next measurement

JSC completed embed, minimize and flatten. Its shell lacks `structuredClone` and `TextDecoder`:
the fixture-centering setup uses a JSON clone, outside measurement, while MinimalLib uses its
own UTF-8 fallback. Result-clone timings are explicitly unavailable for JSC. Neither a browser
decoder nor worker messaging is substituted into these compute measurements.

A separate WKWebView harness could not produce JavaScript samples in this execution sandbox:
WebKit service sandbox extensions (including `com.apple.coreservices.launchservicesd`) were
denied and XPC connections failed. No packaged macOS app or Windows WebView2 verification is
claimed. The later conductor WKWebView measurements below identify the worker-entry cause.

The next measurement is the exact slow packaged model with
`VITE_CHEMDRAFT_PROFILE_3D=1 ./run-app`. Capture the existing host queue, `postMessage` and
round-trip events alongside the new worker stages and `rdkit.binding.*` events. This separates
the measured chemistry work from browser decoding, transport, startup and host validation.
With profiling off, the new hooks perform no profiling clocks, binding replacement or logging.

## Conductor WKWebView measurements (2026-10-27)

On macOS 26.7.1 with WebKit 21624.5.1.11.3 and an Apple M1 Pro (10 cores), the conductor measured flatten3d wall times of 987–1989 ms before the fix, with roughly 1000 ms quantized delivery residuals, and minimize3d at 2134–2146 ms on samples 2–3. These earlier numbers came from WKWebView-only double evaluation of worker entry chunks. After the fix, flatten3d measured 21–34 ms, minimize3d 944–958 ms, embed3d 1139–1491 ms, and delivery residuals 0–2 ms. Conformer, analysis, depiction2d, and both mass-fragment worker entries each fetched and evaluated once. These measurements precede restored output-molfile validation. Windows WebView2 remains unverified.
