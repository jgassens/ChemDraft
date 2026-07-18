# ADR-0013: Reject the cheminfo `nmr-predictor` package as a provider (M11)

- **Status:** accepted (M11 outcome, 2026-07-08)
- **Source:** read-only pre-flight, no install performed

## Context

M11 was a bounded compatibility evaluation of the npm package `nmr-predictor` as
an alternative `NmrPredictor` backend, with the explicit kill criteria in
PLANS.md ("a failed compatibility evaluation is a valid result").

The registry pre-flight settled it without installing:

- `nmr-predictor@1.2.0` → depends on `openchemlib-extended@^4.0.1` → depends on **`openchemlib ^5.6.1`**. ChemDraft is on **`openchemlib ^9.22.1`**. That is a **duplicate OpenChemLib across four major versions** — a named kill criterion ("multiple OpenChemLib versions"), ~2 MB duplicated plus real runtime-conflict risk.
- It depends on **`superagent`** (an HTTP client) plus `xml2js`/`papaparse`, i.e. it **loads its database from a remote endpoint** — the "loading remote data" kill criterion.
- Last published **2022-06-21**; `openchemlib-extended@4` carries `setimmediate` and other legacy Node-polyfill-era assumptions.

## Decision

Do **not** adopt `nmr-predictor` as a provider. Any one of the above (duplicate
OCL, remote data) is disqualifying under the agreed criteria; two hold.

## Consequences

The OCL-native route (ADR-0014 / M10) is confirmed as the path to a real
predictor: it reuses ChemDraft's single OpenChemLib 9.22 rather than fighting it,
and owns its data path instead of depending on a remote endpoint. No dependency
was added; the working fixture and (now) OCL-native providers stand on their own.
Revisit only if the package is modernized onto a compatible OCL and a bundled,
licensed database — unlikely given its 2022 archival state.
