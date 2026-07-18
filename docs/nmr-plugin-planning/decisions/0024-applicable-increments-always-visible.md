# ADR-0024: Every applicable increment is visible while HOSE remains primary

- **Status:** accepted (2026-07-11)
- **Source:** user-directed M25 follow-up after the strychnine comparison control was absent
- **Supersedes:** ADR-0022 Decision 2 (low-confidence-only eligibility) and ADR-0023 Decision 3 (weak/high-dispersion eligibility)
- **Preserves:** ADR-0023 Decision 4 (HOSE-first presentation and storage)

## Context

M17b/M24 exposed increment-table values only for weak HOSE matches or matches with reference
dispersion `sigma >= 0.50 ppm`. In the reported strychnine result, the UI and packaged source both
contained the comparison selector, but no paired value passed that eligibility gate. One vinylic
increment was chemically applicable (5.70 ppm versus 5.84 ppm HOSE), yet its 0.47 ppm HOSE spread
fell just below the gate. The selector therefore disappeared and looked like a stale-build defect.

Applicability and confidence answer different questions: applicability decides whether the table
calculation is meaningful enough to show, while HOSE sphere depth, population, and dispersion decide
how cautiously to interpret it. Hiding a chemically applicable value because the HOSE match is
specific prevents the user from making the comparison they requested.

## Decision

1. Every 1H HOSE resonance receives a versioned additive-increment comparison when the bounded
   estimator says the chemistry is applicable. Unsupported chemistry still produces no value.
2. The 0.50 ppm reference-spread heuristic and `max(0.4 ppm, 1.5 sigma)` disagreement threshold
   affect interpretation and notices only; neither gates visibility.
3. HOSE remains `deltaPpm`, the default figure, and the default JCAMP export. The only alternate
   display is **Show both**; there is no increment-only primary mode.
4. A 1H HOSE report always declares the HOSE/increment comparison capability. When no increment is
   applicable, the desktop shows a disabled **HOSE only — increment not applicable** selector rather
   than removing the control.
5. Notices report exact comparison coverage. Fewer than three compared resonances or less than half
   of the HOSE resonances is insufficient for a general-agreement conclusion.
6. In stereogenic structures, carbon-hosted CH2 sites receive an informational potentially-
   diastereotopic warning. The provider does not split the host or fabricate separate proton shifts.
7. The policy/provenance version advances to additive-increment estimator v1.3.0. The source-backed
   v1.2 numerical tables remain unchanged.

## Consequences

- Strychnine now retains HOSE as primary and exposes its applicable 5.70 ppm vinylic comparison.
- A missing comparison is visibly explained as scientific inapplicability, not mistaken for missing UI.
- Dense structures may offer many alternate peaks, but they appear only after the user chooses
  **Show both**, with dashed orange method styling separate from HOSE confidence colors.
- Agreement language is more conservative and cannot imply molecule-wide validation from one pair.
- True diastereotopic prediction remains future work requiring an explicit-hydrogen, stereochemistry-
  and conformation-aware method.
