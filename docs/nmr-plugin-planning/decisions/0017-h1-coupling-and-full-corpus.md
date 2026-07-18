# ADR-0017: Usable ¹H — full NMRShiftDB2 corpus + first-order coupling estimation

- **Status:** accepted (2026-07-09) — user feedback: ¹H showed no multiplets/J and missed aldehydes
- **Builds on:** [[0014-nmrshiftdb2-data-source]] (the v1 small-export decision this supersedes for coverage)

## Context

The v1 ¹H predictor was a HOSE-code lookup over the **small** NMReDATA export (129
structures / 5,020 environments). Two failures in real use:
1. **Coverage** — any environment not in 129 structures was dropped as "no match"
   (aldehyde C**H**O, ethanol's CH₂, …), and many matches were single-observation.
2. **No coupling** — resonances carried a chemical shift only (`supportsCouplings: false`);
   every peak was a bare singlet with no multiplicity or J.

User chose "bigger DB + coupling layer" (over an increment engine).

## Decision

**1. Full corpus, pruned.** Recompile the bundled database from the **full**
`nmrshiftdb2.nmredata.sd` (284 MB, 49,628 atom-assigned structures → 529,738 HOSE-code
environments), then **prune to environments with n ≥ 5 observations** → 40,024 entries,
**6.1 MB**. The prune drops the 66% of entries that were single-observation deep-sphere
noise (the predictor already fell back past them); it keeps every well-supported
environment. Coverage now includes aldehydes (benzaldehyde CHO ≈ 9.97, n=44), etc. Same
license/provenance as ADR-0014 (nmrshiftdb2 Database License; raw dump not committed, only
the compiled+pruned statistics).

**2. First-order coupling layer.** A topology estimator (`providers/ocl/coupling.ts`)
walks the bond graph for each proton and assigns **class-typical J**: vicinal ³J ≈ 7 Hz,
aromatic ortho ≈ 7.8 / meta ≈ 1.6 Hz, aldehyde ≈ 2.4 Hz. It merges equivalent couplings and
applies the first-order (n+1) rule to produce a multiplicity label (s, d, t, q, quint,
sext, sept, dd, dt, qd, m, …). `NmrResonance` gains an optional `multiplet` (label +
couplings); `supportsCouplings: true`. J values are **estimates for readability** (like
ChemDraw's ChemNMR), surfaced with the shift table's new Mult. / J (Hz) columns — not a
spin simulation, and labeled as estimated.

## Consequences

¹H is now usable: aldehydes and common groups resolve, and every resonance carries a
multiplicity + J. Cost: the bundled DB grows to 6.1 MB, so the worker chunk (~7.5 MB) and
the lazy in-thread fallback chunk each carry it — it stays **out of the main bundle**
(M10 invariant verified). The prune means the *smallest, solvent-like* molecules
underrepresented in NMRShiftDB2 (ethanol's CH₂, acetaldehyde's CHO) can still miss a
specific environment — a source-data sparsity limit, not a bug. Couplings are first-order
only (no second-order / diastereotopic / Karplus-angle modeling).

Rejected: keeping n≥3 (13.7 MB — too large to bundle); the increment engine (ADR-0017
option 2 — larger build, deferred).
