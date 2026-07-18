# Report 0015 — M18: NP-MRD measured-J feasibility (go/no-go)

**Date:** 2026-07-10
**Decision:** [ADR-0021](../decisions/0021-np-mrd-no-go-estimated-j-is-the-ceiling.md) — **NO-GO**
**Sources:** NP-MRD 2022 NAR paper ([PMC8728158](https://pmc.ncbi.nlm.nih.gov/articles/PMC8728158/)),
2025 update ([NAR 53:D700](https://academic.oup.com/nar/article/53/D1/D700/7906838)),
[np-mrd.org/about](https://np-mrd.org/about) licensing.

## Question

Can NP-MRD (CC BY-NC) supply broad, measured, atom-assigned ¹H J-couplings we could bundle to replace
the topology-*estimated* J of M15/M16?

## Findings

| Dimension | Result |
|---|---|
| License | CC BY-NC 4.0 — OK for a free plugin (attribution + non-commercial) |
| Formats | XML/JSON (data), SDF/SMILES (structures), TXT peak lists, JCAMP-DX/nmrML, raw FIDs |
| Scale (2025) | 281,859 compounds / 5.5M spectra |
| **Experimental** | **only ~3,700 compounds** (19,000 spectra sets) |
| Simulated | 416,000 (22,000 compounds, from literature-derived assignments) |
| **Predicted** | **5.1M spectra (282,000 compounds)** — coupling constants themselves *rule-predicted* (Karplus + additive) |
| Bias | Natural products (terpenes/alkaloids/flavonoids), not typical synthetic/drug-like drawings |

## Conclusion: NO-GO

1. **The bulk is predicted, not measured** — bundling it redistributes someone else's rule-based J
   (the same class of estimate we already compute).
2. **Measured, atom-assigned J is small + natural-products-biased** (~3,700 NPs); literature-backfilled
   assignments (~22k) capture J inconsistently and are costly to extract cleanly.
3. **Couplings don't transfer** through single-atom HOSE codes (pairwise, molecule-specific), so even a
   measured-J corpus can't produce per-atom multiplets for arbitrary drawn structures via lookup.

Across two sources now (NMRShiftDB2 has zero J; NP-MRD's is small/biased/mostly-predicted), **broad free
atom-assigned transferable measured J does not exist in a bundleable form.** Topology-estimated J,
clearly labelled as estimated (M15/M16), is the honest ceiling for this free lookup plugin.

## Recommendation / next

- Close the measured-J ambition (done, ADR-0021). Keep estimated-J labelled.
- The predictor's real strength is shifts (~96% high/med confidence, report 0014). Optional next work is
  UX-honesty polish, not a new data source: surface the observed shift **range** for low-confidence
  peaks (data already stored) and the queued figure confidence treatment (M17a2).
- NP-MRD natural-product *shift* coverage remains a possible future opt-in complement — not planned.
