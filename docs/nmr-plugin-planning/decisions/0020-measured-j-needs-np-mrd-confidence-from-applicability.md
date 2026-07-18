# ADR-0020: Measured J requires NP-MRD; confidence is applicability, not a fabricated score

- **Status:** accepted (2026-07-10) — grounded in a direct inspection of the bundled NMReDATA corpus
- **Relates to:** [[0017-h1-coupling-and-full-corpus]] (topology-estimated J), [[0014-nmrshiftdb2-data-source]] (the corpus)

## Context

The plan was to upgrade the topology-**estimated** J-couplings (ADR-0017) to **measured** ones by
mining the NMReDATA we already bundle. Direct inspection of the corpus killed that premise:

- The `NMREDATA_1D_1H` blocks are **shift + signal-label only** — no multiplicity, no J.
- The 2D blocks (`NMREDATA_2D_1H_NJ_1H` etc.) are **correlation networks** — `CorType` ∈
  {COSY, HSQC, HMBC, HMQC, NOESY, TOCSY}. COSY tells you *which* protons couple, not *by how much*.
- **`grep` for a coupling constant in Hz across the whole file returns zero matches.** There are no
  J magnitudes anywhere in NMRShiftDB2's NMReDATA export.

Even the COSY coupling *network* doesn't transfer: couplings are pairwise and molecule-specific,
unlike shifts (per-atom-environment, transferable via HOSE codes). Keying observed couplings by
environment-*pairs* would be sparse and still J-less. So "measured J from data in hand" is not
achievable from this source.

## Decision

1. **Measured J is a dedicated data-ingestion milestone, not a mine of the current corpus.** The
   realistic source is **NP-MRD** (CC BY-**NC**), where literature-style reporting carries per-signal
   multiplicity + J. That is a separate milestone (M18): research format/assignment/size + a CC BY-NC
   redistribution decision for a free plugin, gated on a user-approved download. Until then, J stays
   **topology-estimated and labelled as such** (ADR-0017/0018). Do **not** re-attempt to extract
   measured J from NMRShiftDB2 — it isn't there.

2. **Prediction confidence is surfaced as *applicability*, never a fabricated score.** The predictor
   already computes, per environment: matched HOSE **sphere depth** and reference **count n** (plus
   σ, min, max). We expose these as a self-explaining per-peak tier — `high · s4, n=42`,
   `low · s1, n=509` (a shallow match is generic no matter how many share it), `est.` for
   rule-estimated — with thresholds that mirror the existing notices (`LowHoseSphereMatch` sphere ≤ 1,
   `SmallReferencePopulation` n < 3). No new data, no model, no invented number.

## Consequences

- The "accuracy" milestone (option 2) is the one the data supports today; it runs first. Slice A (the
  confidence tier) shipped in commit `7e190a55` (report 0014).
- Measured J (option 1) is correctly reframed as the NP-MRD milestone, deliberately scoped and
  license-gated rather than attempted on data that lacks it.
- Rejected: keying COSY networks by environment-pairs to fake "measured" couplings — sparse,
  non-transferable, and still J-less. Rejected: any confidence score not derived from real
  applicability statistics.
