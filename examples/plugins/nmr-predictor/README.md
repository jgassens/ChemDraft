# @chemdraft/plugin-nmr-predictor

ChemDraft's first-party NMR shift predictor plugin. Phase 1 ships a small,
**deterministic fixture-backed provider** whose purpose is to prove the complete
plugin path — selection → normalization → prediction → analysis storage → menu →
panel — without depending on an external chemistry database.

## Status (M6)

This milestone contains the **provider core only**: domain contracts, structure
normalization (via the OpenChemLib that ChemDraft already ships), and the
`FixtureHosePredictor`. The worker (M7), command + analysis integration (M8),
and declarative panel report (M9) are not wired here.

## ⚠️ The shift values are synthetic fixtures

The numbers in `providers/fixture/fixtureDatabase.ts` are **hand-authored
synthetic fixtures** chosen to exercise the architecture (complete, partial, and
no-match cases, equivalent-nuclei grouping, deterministic uncertainty). They are
**not experimental reference data** and must never be presented as measured
shifts. The prediction `method` is labeled `fixture-fragment` precisely so this
is unambiguous downstream.

The provider does not map whole SMILES strings to canned spectra: it computes a
per-atom environment key and looks each one up, so it exercises real atom-level
normalization rather than UI plumbing.

## Layout

```
src/
├── index.ts            barrel exports
├── manifest.ts         plugin manifest (contribution declarations)
├── domain/             framework-neutral contracts, errors, warnings, schemas
├── application/        structure normalization (OCL boundary)
└── providers/fixture/  the deterministic fixture provider
```

See `THIRD_PARTY_NOTICES.md` for dependency provenance.
