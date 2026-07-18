# ADR-0006: ¹³C default, ¹H experimental, no fabricated shifts

- **Status:** accepted
- **Date:** 2026-07-07 (codified from PLANS.md)
- **Source:** PLANS.md "¹³C versus ¹H defaults" / "Warning codes" / AGENTS.md scientific-claim rules

## Context

This tool will be used by chemists who trust plausible-looking numbers.
Proton prediction is materially harder than carbon (stereotopic protons,
exchangeable protons, solvent and conformational sensitivity), and a clean
synthetic stick spectrum looks more authoritative than a fixture provider
warrants. The worst failure mode is not a missing number — it is a wrong
number presented confidently.

## Decision

- Default prediction is ¹³C only; ¹H is opt-in and visibly labeled
  experimental (`NMR_EXPERIMENTAL_PROTON_MODEL`), surfaced in Phase 1 as a
  second, explicitly experimental command/menu item.
- An unmatched atom environment yields an **omitted** resonance plus a
  warning — never zero, never a molecule average, never an undisclosed
  fallback.
- Never display multiplicity, J couplings, line shapes, integrations,
  solvent correction, or confidence percentages unless a provider genuinely
  supplies defensible values; stick height is "predicted equivalent nuclei",
  labeled as such.
- Fixture output always carries `NMR_FIXTURE_DATA` and a synthetic-data
  notice.
- Labile protons are omitted by default (`NMR_LABILE_PROTON_OMITTED`).

## Consequences

The panel under-promises by design; partial results with warnings are the
normal case, and tests assert the *absence* of fabricated values. Revisit
the ¹H default only after a benchmarked provider and database exist.
