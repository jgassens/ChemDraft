# ADR-0002: Fixture-first predictor; Phase 1 success is architectural

- **Status:** accepted
- **Date:** 2026-07-07 (codified from PLANS.md)
- **Source:** PLANS.md "Recommendation" / "Phase 1 dependency options"

## Context

Three independent hard problems were tangled in early drafts: desktop
plugin-runtime bring-up, legacy JavaScript package compatibility
(`nmr-predictor` depends on the archived `openchemlib-extended` ecosystem and
may drag in a second OpenChemLib), and NMR prediction-data provenance
(shift databases have licensing separate from code). Any one of them can
stall for weeks; coupling Phase 1 completion to all three guarantees it.

## Decision

Phase 1's required predictor is a ChemDraft-owned, deterministic,
fixture-backed fragment provider (`fixture-fragment` method, ~10 documented
molecules, environment-based matching rather than whole-molecule canned
spectra). The plugin architecture is **complete and successful** when only
the fixture provider is enabled. Production-oriented predictors (OCL-native
HOSE, `nmr-predictor`, GNN, DFT, remote) are later providers behind the same
`NmrPredictor` interface.

## Consequences

The plugin path (selection → command → worker → analysis → report) is
provable offline, deterministically, with no licensing exposure. Fixture
values must be loudly labeled synthetic (`NMR_FIXTURE_DATA`) and never
presented as validated predictions. The scientific-usefulness milestone
moves to Phase 1.5+ and depends on a licensed database — tracked separately.
Supersede only if a production provider with clean provenance lands faster
than expected.
