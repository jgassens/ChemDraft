# @chemdraft/plugin-nmr-predictor

ChemDraft's first-party NMR shift predictor plugin. Select a structure, run
**Analyze → Predict ¹³C NMR Shifts** (or the experimental ¹H command), and see a
stick-spectrum + shift table in a declarative panel. Predictions are written to
the generic analysis store and flagged stale when the structure changes.

## Providers

- **OCL-native (default)** — reuses ChemDraft's OpenChemLib to derive atom
  environment codes and looks them up in a database compiled from **NMRShiftDB2**
  experimental assignments (deepest-sphere-first, with honest coverage warnings).
- **Fixture** — deterministic synthetic data; used for tests and as an offline /
  no-`Worker` fallback.

Both implement the same `NmrPredictor` interface, so the command / worker / panel
are provider-agnostic. Prediction runs off the main thread in a Web Worker
(request-id protocol), with an in-thread fallback where `Worker` is unavailable.

## ⚠️ Data provenance

- The OCL provider's `providers/ocl/nmrshiftdb2.database.json` is a **derivative
  database** of aggregated shift statistics (no structures) under the **nmrshiftdb2
  Database License** (ODbL-derived; commercial use OK, share-alike, attribution) —
  see `providers/ocl/NMRSHIFTDB2_LICENSE.md`. Rebuild with `scripts/build-database.ts`.
- The fixture provider's values are **synthetic**, labeled as such everywhere.
- Coverage is intentionally narrow; the panel discloses low-confidence and no-match
  cases rather than fabricating. It never presents thin predictions as authoritative.

See `THIRD_PARTY_NOTICES.md` and, for the full picture,
`docs/architecture/nmr-predictor-plugin.md` and
`docs/architecture/nmr-prediction-data.md`.

## Layout

```
src/
├── manifest.ts        contributions (¹³C default + ¹H experimental commands, menu, panel, analyzer)
├── register.ts        command handlers + onPanelClosed lifecycle
├── domain/            serializable contracts, errors, warnings, schemas
├── application/       normalization, selection mapping, status, the command
├── providers/         fixture/ (synthetic) and ocl/ (NMRShiftDB2, default)
├── worker/            protocol, core handler, entry, client
└── report/            declarative panel composition + stick-spectrum SVG
scripts/build-database.ts   compile a NMReDATA/SDF export → the bundled database
```

Rebuild the database:

```bash
npx tsx examples/plugins/nmr-predictor/scripts/build-database.ts \
  <nmrshiftdb2rawdata.nmredata.sd> \
  examples/plugins/nmr-predictor/src/providers/ocl/nmrshiftdb2.database.json
```
