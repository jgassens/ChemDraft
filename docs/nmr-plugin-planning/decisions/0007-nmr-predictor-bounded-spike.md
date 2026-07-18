# ADR-0007: `nmr-predictor` is an optional bounded spike with kill criteria

- **Status:** accepted
- **Date:** 2026-07-07 (codified from PLANS.md)
- **Source:** PLANS.md "Predictor C" / "Milestone 11" / AGENTS.md dependency rules

## Context

Cheminfo's `nmr-predictor` is the only off-the-shelf JavaScript HOSE
predictor, which makes it tempting as the fast path to real numbers. But it
sits on the archived `openchemlib-extended` ecosystem and risks a second
incompatible OpenChemLib in the bundle (ChemDraft ships `openchemlib
^9.22.1`), Node polyfills, global mutation, remote-data helpers, and a
database whose redistribution terms are separate from the package's MIT
code license.

## Decision

`nmr-predictor` is Milestone 11: an optional, time-boxed compatibility
investigation in an isolated, exact-pinned package, imported only inside
`providers/cheminfo/`. Pre-install audit commands and inspection checklist
are in PLANS.md. Hard kill criteria — any one terminates the investigation:
broad Node polyfills; browser-global mutation; weakened bundler checks;
replacing ChemDraft's OpenChemLib; remote data access; undocumented database
redistribution; main-thread-only prediction. **A failed investigation is a
valid, reportable outcome**; the fixture provider and architecture stand
regardless (ADR-0002).

## Consequences

No milestone waits on legacy-package archaeology, and the temptation to
"just make it work" with polyfills has a pre-committed answer: no. If the
spike fails, the OCL-native provider (Milestone 10) is the production path.
Record the spike's verdict and exact reasons in its report and update this
ADR's status note.
