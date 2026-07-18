# ADR-0025: The spectrum trace is confidence-blind; confidence lives in structure labels, table, and notices

- **Status:** accepted (2026-07-12)
- **Source:** user-directed M27 ("i dont want 'low confidence' indications in the calculated spectra") after the strychnine SDBS comparison
- **Supersedes:** M26 (report 0022: low-confidence spectrum-label suppression) and the spectrum-muting half of M17a2
- **Preserves:** M17a2 structure-label confidence coloring; M17a table tiers; ADR-0020 confidence semantics; ADR-0023/0024 comparison presentation

## Context

M17a2 muted low-confidence peaks in the plotted spectrum (grey, dashed, half-opacity) and M26
additionally suppressed their numeric labels there. On strychnine this produced grey unlabeled peaks
at 4.60/4.70 ppm. Comparing against the experimental SDBS spectrum, the user rejected this
presentation: a calculated spectrum should read as one uniform spectrum, the way ChemDraw's does.

The confidence signal itself is not wrong — on strychnine it marked exactly the predictions that
missed worst (the bridged N-CH methines, off by 0.4–0.85 ppm). The objection is to *where* it is
displayed, not to its existence.

## Decision

1. **The plotted spectrum renders every predicted peak identically** — same color, same solid
   pseudo-Voigt curve, numeric label always drawn — regardless of confidence tier. The
   `is-low-confidence` curve/peak styling and the M26 label suppression are removed, in-app and in
   the copied standalone SVG.
2. **Confidence remains fully visible everywhere else:** colored molecular shift labels
   (good/medium/rough + legend), the table's Confidence column, and the notices. Nothing about
   confidence *semantics* (ADR-0020) changes; only the spectrum trace stops encoding it.
3. **Method provenance still restyles the trace.** Rule-estimated peaks stay grey-dashed with italic
   labels, and increment alternatives stay dashed orange — those distinguish *how a number was
   produced*, which the spectrum must not misrepresent. The spectrum note names these styles only
   when they are present and no longer claims "muted = lower confidence".

## Consequences

- A prediction reads as one clean spectrum; per-peak trust is looked up on the structure or in the
  table, matching how chemists actually compare against a measured spectrum.
- The distinction the trace still draws (estimated / alternative) is provenance, not confidence —
  an estimate rendered as a solid trusted-looking curve would be dishonest; a low-confidence
  database match rendered normally is not.
- M26 is fully reverted after one day; its report (0022) remains as history.
