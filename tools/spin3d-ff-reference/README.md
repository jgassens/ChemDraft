# Spin 3D UFF reference fixtures

These fixtures capture the Universal Force Field (UFF) and FIRE implementations in
Avogadrolibs at ChemDraft's shipping sidecar pin
`416651ddaef33a4e20392392e7c0b505d446491b`. The Rust integration test consumes the
committed JSON and SHA-256 hashes. It needs only ChemDraft's ordinary Cargo dependencies
and build prerequisites. [Pinned Avogadrolibs source](https://github.com/OpenChemistry/avogadrolibs/tree/416651ddaef33a4e20392392e7c0b505d446491b)

## Regenerate offline

Use Node.js, Git, CMake 3.24 or newer, a C++17 toolchain, the pinned Avogadrolibs checkout,
and Eigen 3.4.0. On Windows, use an x64 MSVC toolchain. Run from the repository root.

```text
node tools/spin3d-ff-reference/regenerate.mjs --avogadrolibs "<pinned checkout>" --eigen "<Eigen 3.4.0 source>"
```

`AVOGADROLIBS_SOURCE` and `EIGEN_SOURCE` can supply the paths. `CMAKE` can
select a CMake executable. The default build uses a temporary directory. Pass
`--build-dir <scratch directory>` to keep or reuse a build. CMake builds only
the harnesses and their dependencies, using static Avogadro Core and Calc,
`EIGEN_MPL2_ONLY`, and the sidecar's disabled Qt, OpenGL, Python, tests, benchmarks,
and optional integrations. On macOS it uses the sidecar's deployment target of 11.0.
The generator records the compiler, flags, architecture, settings and the SHA-256
of the inventory, each input and each fixture in `manifest.json`.

CMake builds one executable with the untouched pinned library. For the other, it appends
`uff-diagnostics.inc` to a build-directory copy of `uff.cpp`. This exposes the selected
type rows and labels, angle coordination enum values, term tuples in upstream order,
and sorted 1–2 and 1–3 exclusions. The generator compares all numerical results from the
two executables before writing fixtures. The working source checkouts are read-only.
Repeated regeneration on the recorded toolchain must produce the same manifest and
fixture hashes. The Rust test checks numerical tolerances on any test host.

```text
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test uff_reference_fixtures
node --test tools/spin3d-ff-reference/eigen-config.test.mjs
```

## Input coverage

The coverage inventory lists the required case IDs, graph variants, ordered snapshot
IDs and optimizer runs. Regeneration checks the inputs against it before building and
the results before writing. The Rust test checks the same inventory. [Inventory](inventory.json)

The 27 fixture files cover 54 graphs and 113 fixed snapshots. Each molecule with hydrogen
has an `explicit-hydrogen` graph and a `drawn-heavy-atom-only` graph containing the same
ordered heavy-atom coordinates and bonds. A `no-hydrogens` graph is used when the source
graph contains no hydrogen. All atom and coordinate indices start at zero.

| Group | Fixed snapshots per file |
| --- | --- |
| Small organics and term isolation | Water 6, methane 4, acetylene 4, ethanol 4, n-butane 6, hydrogen peroxide 4, formaldehyde 4, acetamide 4 |
| Rings and aromatics | Cyclopropane 4, cyclohexane chair 6, benzene 8, furan 4, naphthalene 8 |
| Charges and scope | Methylammonium 4, acetate 4, separated sodium/chloride pair 2, octahedral Fe(II) with six fluoride ligands 2, sulfur hexafluoride 2 |
| Element support | Iodomethane 4, antimony trihydride 4, separated element scan probe 1 |
| Specified and unspecified stereo | (R)-2-butanol, (S)-2-butanol, tetrahedrally unspecified 2-butanol, (E)-2-butene, (Z)-2-butene, and alkene-unspecified 2-butene, each with 4 |

ChemDraft-authored SMILES supplied most starting graphs. Their coordinates came from
the repo's RDKit MinimalLib ETKDGv3 binding, seeded with 416651, or 416654 for the
cyclohexane chair. No force-field refinement was applied. Water, acetylene, antimony
trihydride, the charged pair, the two octahedral probes and the separated element probe
use hand-authored coordinates. The inputs store the exact coordinates. Most perturbed
snapshots add offsets of `0.017 × (((atom * 7 + axis * 5) % 11) - 5)` Å. Water and
antimony trihydride use hand-authored displacements.

The aromatic bonds retain `originalOrder: "aromatic"`. Avogadro receives the integral
`order` values. Benzene and naphthalene each have two valid recorded Kekulé assignments
on the same coordinates. Neutral furan has one integral assignment with two carbon-carbon
double bonds and single bonds to oxygen. The stereo intent is stored with the static
input. In the unspecified cases the embedded coordinates represent one geometry and the
intent stays unspecified.

## Numbers and checks

- Total `value`, `evaluate` energy, analytic gradient and the total central differences
  use kJ/mol and kJ/(mol·Å). The five terms have raw values in kcal/mol and kcal/(mol·Å)
  and normalized values using 4.184 kJ/kcal. The term keys `bond`, `angle`, `oop`,
  `torsion` and `vdw` map to stretch, bend, out-of-plane, torsion and van der Waals.
  UFF here includes no electrostatics. General restraints are off.
- Gradients, FIRE coordinates and FIRE velocities are in flattened atom x/y/z order.
  Central differences use upstream energies with steps of 1e-5 Å and 5e-6 Å. The two
  linear acetylene snapshots and the two exact octahedral snapshots are marked
  `linear-boundary` and retain both forms of the gradient. All 109 `smooth` snapshots passed the
  plan's derivative gate. The largest absolute difference was 1.9863e-6 kJ/(mol·Å) at
  the full step, on the total x derivative of atom 1 in perturbed explicit-H furan.
- Seven ABC-FIRE runs cover both hydrogen models for water, n-butane and cyclohexane,
  plus a water run freezing all three oxygen coordinates. An unmasked explicit-H
  water FIRE2 run exercises the branch without bias correction. The FIRE starts are
  fixed perturbations scaled by 1.16 and stored in the inputs. Each run stores iterations
  1, 10, 100, and the first endpoint at or below 0.01 kJ/(mol·Å) mobile-gradient RMS,
  with a cap of 10,000. If the endpoint precedes iteration 100, evaluation continues to
  capture the scheduled checkpoints. Separate single-call and 10-step replays matched
  the recorded states exactly. Each recorded checkpoint has energy at or below the
  start. FIRE can raise energy between checkpoints. For masked water, energy rises
  from 6.08556 kJ/mol at step 1 to 18.32603 kJ/mol at step 10, from a 180.09586 kJ/mol start.
- Pinned Avogadro assigns `Xe4+4` to iodine and `Te3+2` to antimony in explicit SbH₃.
  It skips topology setup for the one-atom drawn water, methane, and SbH₃ graphs.
  The separated scan probe records `Cs` for Xe, `Ba6+2` for Cs, `Hf3+4` for Lu,
  `Re3+7` for W, `Fr` for Rn, and `Md6+3` (row 125) for Fm. Md, No and Lr
  return the unassigned row `-1`. Their isolation beyond the cutoff avoids invoking
  bonded or nonbonded setup with an unassigned row.
- The Fe and S probes each yield 15 angle tuples. Fe selects `Fe6+2` with octahedral
  angle coordination (enum 6). S selects `S_3+2` with tetrahedral angle coordination
  (enum 3). Both probes are calculator comparisons.
- The sodium/chloride cutoff trace records energy and gradient from one persistent
  model and a fresh model at each of 11 ordered evaluations. The pair starts
  outside 10 Å, moves inside for evaluations 2–10 and returns outside on evaluation 11.
  The fresh model records -0.00427610 kJ/mol inside the cutoff. The persistent model
  returns zero until its pair list rebuilds on evaluation 10, then returns zero again
  as soon as the pair moves outside. The trace is marked `cutoff-boundary` and is
  excluded from the finite-difference gate.

## Comparison with the newer checkout

The comparison checkout was `b296e8024abd93771f6a51f5d9eed4f9ca419e6b`.

- `uff.cpp` adds guards for missing coordinates, unsupported type rows, zero bond
  order, zero-length angle and dihedral bonds, and vdW overlaps. It initializes masks
  from the molecule and adjusts the order of the unit conversion, restraints and
  gradient cleaning.
- `uffdata.h` makes the parameter array `const`. The rows and labels are identical.
- `energyoptimizer.cpp` and `energyoptimizer.h` add persistent L-BFGS history,
  stall/restart handling and iteration reporting. The newer FIRE loop bounds its
  max-move check to complete coordinate triples and clears the L-BFGS history on exit.
- `uff.h` is byte-identical.

## Benchmark ABC-FIRE and Hybrid offline

Use the same pinned dependencies and toolchain as fixture regeneration.

```text
node tools/spin3d-ff-reference/benchmark-optimizers.mjs --avogadrolibs "<pinned checkout>" --eigen "<Eigen 3.4.0 source>"
```

The benchmark writes the full run data and a summary under `benchmarks/`. It creates
and removes a temporary build by default. Pass `--build-dir <scratch directory>` to
reuse a build and remove it manually. See the [benchmark report](benchmarks/fire-vs-hybrid.md)
for the measured cases, schedules and timing boundaries.

## Follow-ups

Product drag and release transcripts, the 200-frame fixed-target run, and
native runtime, coverage and stereo-refusal checks belong to the later
decision-dependent work.

## Attribution

The ChemDraft harness is Apache-2.0. It links code from the Avogadro project under
BSD-3-Clause. Thanks to Geoff Hutchison for guidance on the planned port. The scratch
diagnostic appends read-only access to the pinned Avogadro translation unit.
[Avogadro BSD-3-Clause license](https://github.com/OpenChemistry/avogadrolibs/blob/416651ddaef33a4e20392392e7c0b505d446491b/LICENSE)

UFF was described by Rappé et al. in “UFF, a full periodic table force field for
molecular mechanics and molecular dynamics simulations” (1992).
[UFF paper](https://doi.org/10.1021/ja00051a040)

The optimizer variants follow Guénolé et al., “Assessment and optimization of the
fast inertial relaxation engine (FIRE) for energy minimization in atomistic simulations
and its implementation in LAMMPS” (2020), and Echeverri Restrepo and Andric, “ABC-FIRE:
Accelerated Bias-Corrected Fast Inertial Relaxation Engine” (2023).
[FIRE2 paper](https://doi.org/10.1016/j.commatsci.2020.109584) ·
[ABC-FIRE paper](https://doi.org/10.1016/j.commatsci.2022.111978)

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
