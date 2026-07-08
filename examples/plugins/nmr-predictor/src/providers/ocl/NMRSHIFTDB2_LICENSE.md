# Reference database provenance & license

`nmrshiftdb2.database.json` is a **compiled data artifact**: aggregated HOSE-code →
chemical-shift statistics (median/mean/stdev/min/max/n per ¹H and ¹³C atom
environment). It is a *derivative database* built by ChemDraft from experimental,
atom-assigned NMR data — it contains **no structures**, only statistics.

| Field | Value |
|---|---|
| Asset | NMRShiftDB2 compiled HOSE-shift statistics (ChemDraft-derived) |
| Upstream source | NMRShiftDB2 — `nmrshiftdb2rawdata.nmredata.sd` (NMReDATA export) |
| Upstream URL | https://sourceforge.net/projects/nmrshiftdb2/files/data/ |
| Original authors | nmrshiftdb2 contributors |
| Upstream license | nmrshiftdb2 Database License (derived from ODbL) — https://nmrshiftdb.nmr.uni-koeln.de/nmrshiftdbhtml/nmrshiftdb2datalicense.txt |
| Nuclei | ¹H, ¹³C |
| Modifications | Parsed atom assignments → OpenChemLib environment codes (spheres 1–4) → per-environment shift statistics. Raw structures discarded. |

## License terms (summary — the upstream text governs)

The nmrshiftdb2 Database License is ODbL-derived. It **permits use, including
commercial use**, with these obligations relevant here:

- **Share-alike:** a *derivative database* (this compiled artifact is one) must be
  offered under the same license. This file + the upstream license text travel
  with `nmrshiftdb2.database.json`.
- **Attribution:** credit nmrshiftdb2 (surfaced at runtime in the prediction
  panel's "Reference database" section).
- **Open-source prediction software:** software relying on the database for
  prediction must be under an OSI-approved license — satisfied (this plugin's
  **code** is MIT/open-source; the database is tracked as a separate data asset).

Rebuild with `scripts/build-database.ts` from the upstream NMReDATA export.

To ship a purely permissive/attribution-only alternative, swap in a CC BY 4.0
corpus such as NMRexp (see ADR-0014); the engine is unchanged.
