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
