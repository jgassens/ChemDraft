# ADR-0023: Source-backed increment refinement with HOSE-first comparison

- **Status:** accepted (2026-07-11) — Decision 3 eligibility superseded by ADR-0024; HOSE-first presentation remains authoritative
- **Builds on:** [[0020-measured-j-needs-np-mrd-confidence-from-applicability]], [[0022-increment-cross-check]]
- **Supersedes:** ADR-0022 section 3 only (increment-first figure presentation)

## Context

M24 established an additive-increment second opinion for weak ¹H HOSE matches, but its first
aliphatic implementation collapsed several distinct methyl/methylene/methine environments into a
single alpha-only rule. The bundled corpus also contains no `n < 3` entries: all 40,024 retained
environments have at least five observations. Reference dispersion is therefore the useful remaining
signal for offering a second opinion beyond shallow one-sphere matches.

The user also clarified the intended presentation: the measured-reference HOSE result should remain
the default spectrum, with an explicit option to show both methods.

## Decision

1. **Estimator v1.2 is source-bounded.** Aliphatic sp3 C-H estimates use separate
   methane/methyl/methylene/methine bases and alpha/beta/gamma corrections transcribed from
   Beauchamp and Marquez (*J. Chem. Educ.* 1997, DOI 10.1021/ed074p1483). Aromatic corrections
   consolidate standard RSC/MIT teaching-table values. Aldehyde, terminal-alkyne, and vinylic values
   remain explicitly labelled ChemDraft representative in-range heuristics, not calculated
   alpha/beta/gamma results.
2. **Applicability is conservative.** A table value is emitted only for an explicitly mapped
   environment. Saturated rings, heteroarenes, imines, unsupported O/N substitution, S/Si contexts,
   peroxides, carbamates/carbonates, anhydrides, unsupported charged species, isotopes, and radicals
   are rejected rather than coerced into a plausible generic value. Canonical nitro N+/O- is the
   narrow charge exception because NO2 is an explicit table class.
3. **A specific but high-dispersion ¹H match may be compared.** In addition to weak applicability,
   a HOSE match with reference `sigma >= 0.50 ppm` may carry a v1.2 increment comparison. This is a
   heuristic second-opinion trigger, not a calibrated accuracy threshold. Disagreement remains
   `abs(HOSE - increment) > max(0.4 ppm, 1.5 sigma)`.
4. **HOSE remains primary everywhere.** The figure defaults to **Prefer HOSE** and offers **Show both
   (ᵢ = increment)**. The stored `deltaPpm` and default JCAMP export remain HOSE. The table always
   includes the paired increment value, and Notices state whether the applicable table calculations
   are in general agreement, mixed agreement, or not in general agreement with HOSE.
5. **Comparison terminology is plugin-owned.** The generic panel contract carries primary and
   alternative labels; the NMR plugin supplies `HOSE`, `increment`, and the `ᵢ` marker. Desktop
   rendering, copied SVG, and JCAMP export do not hard-code those provider names.

## Consequences

- This closes M17b and the broader M17 accuracy/applicability milestone without claiming scientific
  validation.
- Fused carbocyclic PAH comparisons remain intentionally available but approximate; heteroaromatic
  systems remain inapplicable.
- The 0.50 ppm dispersion threshold is auditable and tunable, but it is not a probability or an error
  bar for the increment calculation.
- ADR-0022 remains authoritative for cross-check storage, absolute/sigma disagreement, and transparent
  table display. Its increment-first UI default is superseded by this decision.
