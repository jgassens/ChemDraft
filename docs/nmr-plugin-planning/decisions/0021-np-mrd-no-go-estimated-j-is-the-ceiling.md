# ADR-0021: NP-MRD is a no-go for measured J; labelled topology-estimated J is the honest ceiling

- **Status:** accepted (2026-07-10) — concludes the M18 feasibility research (report 0015)
- **Supersedes the forward-looking half of** [[0020-measured-j-needs-np-mrd-confidence-from-applicability]] (which named NP-MRD as *the* measured-J path pending research). The confidence-from-applicability half of ADR-0020 still stands.

## Context

ADR-0020 established that NMRShiftDB2's export carries **no J magnitudes** and named NP-MRD as the
candidate measured-J source. M18 researched NP-MRD (np-mrd.org, the 2022 NAR paper + the 2025 update).
It does not deliver broad measured J. Findings:

- **License:** CC BY-NC 4.0 — fine for a free plugin (matches the user's earlier clearance).
- **The bulk is predicted, not measured.** 2025: of **281,859 compounds / 5.5M spectra**, only
  **~3,700 compounds have experimental spectra** (19,000 sets); **416k are simulated** (from literature
  assignments) and **5.1M are predicted** for 282k compounds. The predicted spectra's coupling
  constants are themselves **rule-predicted** (Karplus-like + additive) — i.e. someone else's estimate,
  the same class of thing we already compute.
- **Measured, atom-assigned J is small and natural-products-biased.** The experimental set is ~3,700
  natural products (terpenes, alkaloids, flavonoids…) — not the synthetic / drug-like structures a
  ChemDraft user typically draws. ~22,000 have literature-backfilled *shift* assignments of uncertain,
  inconsistent J/multiplicity capture (free-text "7.26 (d, J = 8.0)" style, hard to extract cleanly).
- **Couplings still don't transfer.** Even with measured J in hand, couplings are pairwise and
  molecule-specific; they don't key to a new molecule's atoms through single-atom HOSE codes the way
  shifts do. A lookup predictor cannot turn a measured-J corpus into per-atom multiplet predictions for
  arbitrary drawn structures. NP-MRD itself uses quantum spin simulation + ML + DFT for this — out of
  scope for a bundled free plugin.

The pattern across two sources (NMRShiftDB2: no J; NP-MRD: small, biased, mostly-predicted) is that
**broad, free, atom-assigned, transferable measured J does not exist in a bundleable form.**

## Decision

1. **No-go on NP-MRD ingestion for measured J.** Do not build the ingestion for coupling data — it
   would add a large, natural-products-biased, mostly-*predicted* CC BY-NC corpus that still can't
   produce transferable per-atom J.
2. **Topology-estimated J, clearly labelled as estimated, is the accepted honest ceiling** for coupling
   in this free lookup-based plugin (the M15/M16 engine). We do not present estimated J as measured, and
   we do not chase a measured-J source that isn't there.
3. **Shifts remain the strength.** The predictor is already ~96% high/med confidence on common
   molecules (report 0014); NMRShiftDB2 is the right shift corpus. NP-MRD's *natural-product shift*
   coverage is a possible **future, opt-in** complement (a niche coverage add, not a J source) — recorded
   as a maybe, not planned.

## Consequences

- The "measured couplings" ambition (option 1) is closed honestly: it is not achievable for a free
  lookup plugin from available data. This is a data-reality conclusion, not a code gap.
- Effort returns to what moves real usage: shift accuracy/coverage and honest confidence — where the
  predictor already does well — plus optional UX honesty (dispersion/range display).
- Rejected: bundling NP-MRD predicted J (redistributing others' rule-based estimates as if data);
  scraping literature J from 22k assignments (large, noisy curation for a non-transferable quantity).
