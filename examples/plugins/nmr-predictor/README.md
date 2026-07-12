# @chemdraft/plugin-nmr-predictor

ChemDraft's first-party NMR shift predictor plugin. Select a structure, run
**Analyze → Predict ¹³C NMR Shifts** (or the experimental ¹H command), and see a
stick-spectrum + shift table in a declarative panel. Predictions are written to
the generic analysis store and flagged stale when the structure changes.

## Providers

- **OCL-native (default)** — reuses ChemDraft's OpenChemLib to derive atom
  environment codes and looks them up in a database compiled from **NMRShiftDB2**
  experimental assignments (deepest-sphere-first, with honest coverage warnings).
  Requests honor either the database median or mean. Every ¹H HOSE match whose
  chemistry is supported by the bounded tables may carry a second opinion from the
  versioned additive-increment estimator, but only
  when its tabulated scheme explicitly applies; heteroarenes, imines, unsupported
  S/Si substituents, charge, isotopes, and radicals are never silently treated as
  generic carbon/alkyl chemistry. Estimator v1.3 uses published sp3 C-H class bases
  plus alpha/beta/gamma corrections through three carbons; aromatic corrections
  consolidate standard teaching tables, while aldehyde/vinylic/alkynyl values are
  explicitly coarse representative class values. The HOSE value remains the stored primary value;
  the 0.5 ppm reference-spread heuristic affects interpretation, not availability. The panel always
  shows the HOSE/increment comparison state and reports exact coverage. In stereogenic structures,
  potentially nonequivalent CH₂ hydrogens receive a disclosure rather than fabricated separate shifts.
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
- Coverage is intentionally narrow. Applicable coarse estimates are marked partial
  and include per-resonance estimator ID, version, and method. An unmatched
  unsupported environment is omitted with a stable warning instead of receiving a
  fabricated generic value. The panel discloses low-confidence and no-match cases
  and never presents thin predictions as authoritative.

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

Rebuild the database (the `n >= 5` bundle-size prune is the default; the raw
input's SHA-256 is embedded in the artifact's provenance for reproducibility):

```bash
npx tsx examples/plugins/nmr-predictor/scripts/build-database.ts \
  <nmrshiftdb2rawdata.nmredata.sd> \
  examples/plugins/nmr-predictor/src/providers/ocl/nmrshiftdb2.database.json \
  --min-observations 5
```
