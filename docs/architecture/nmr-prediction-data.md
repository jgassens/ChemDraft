# NMR prediction data & provenance

Code licensing and *data* licensing are tracked separately. The plugin **code** is
MIT/open-source; each prediction database is a distinct data asset with its own
provenance and license. This documents what ships, under what terms, the
third-party evaluation result, and the future data paths.

## What ships

| Provider | Data | Nature | License |
|---|---|---|---|
| **OCL-native** (default) | `providers/ocl/nmrshiftdb2.database.json` | Aggregated experimental shift statistics (median/mean/stdev/min/max/n per HOSE-code) compiled from NMRShiftDB2. **Statistics only — no structures.** | nmrshiftdb2 Database License (ODbL-derived) — see `providers/ocl/NMRSHIFTDB2_LICENSE.md` |
| **Fixture** | `providers/fixture/fixtureDatabase.ts` | Hand-authored **synthetic** values for a small environment table. | ChemDraft-owned; not experimental data |

The compiled NMRShiftDB2 database holds **40,024 entries** (HOSE-code → shift
statistics) from **49,628 atom-assigned structures**, pruned to environments with
≥ 5 observations for bundle size (~6.1 MB, from ~530k raw environments; ADR-0017).
Rebuild with `scripts/build-database.ts` from the full `nmrshiftdb2.nmredata.sd`.

## NMRShiftDB2 license handling (ADR-0014)

The nmrshiftdb2 Database License is ODbL-derived and **permits commercial use**,
with three obligations honored here:

1. **Share-alike** — the compiled artifact is a *derivative database*, so it and
   the upstream license text travel together (`NMRSHIFTDB2_LICENSE.md`).
2. **Attribution** — credited at runtime in the panel's "Reference database"
   section (the predictor stamps `backend.license`/`attribution`/`source`).
3. **Open-source prediction software** — the plugin code is MIT, an OSI-approved
   license; the database is a separate data asset.

Only compiled statistics are redistributed; the raw structures are not committed.

## Prediction behavior (disclosed, by design)

- **Coverage + fallback.** The full corpus covers common groups (aldehydes,
  carbonyls, etc.). Environments still absent get a **rule-estimated** shift from
  functional-group rules (`NMR_RULE_ESTIMATED`, `evidence.method: "rule-estimated"`)
  instead of being dropped — marked (dashed peak, "≈" shift, "rule-estimated" in the
  table) so a guess never reads as a measured match (ADR-0018).
- **Multiplicity + J.** First-order multiplicity and class-typical coupling constants
  are estimated from the bond topology (`supportsCouplings: true`) and drawn as split
  peaks — estimates for readability, not a spin simulation (ADR-0017/0018).
- Shallow-sphere matches (`NMR_LOW_HOSE_SPHERE_MATCH`), small reference populations
  (`NMR_SMALL_REFERENCE_POPULATION`), and omitted labile protons are still surfaced.

The predictor **never presents an estimate as a measured match**: DB matches are
`hose-fragment`; estimates are `rule-estimated`. The fixture provider's values are
labeled synthetic everywhere they appear.

## Third-party evaluation result (M11, ADR-0013)

The cheminfo `nmr-predictor` npm package was evaluated as an alternative provider
and **rejected** on read-only pre-flight (no install): it pins
`openchemlib ^5.6.1` via `openchemlib-extended` (a duplicate of ChemDraft's
`^9.22.1`) and depends on `superagent` (loads its database from a remote
endpoint). Both are disqualifying kill criteria; the package was last published in
2022.

## Future data paths

Broadening coverage is a **data swap**, not a code change — the environment-code
key and the compiled-statistics shape are stable:

- **Fuller NMRShiftDB2 dump** — same license, far more structures.
- **NMRexp** (Zenodo, **CC BY 4.0**, 3.37M experimental records across ¹H/¹³C/¹⁹F/
  ³¹P/²⁹Si/¹¹B) — cleaner attribution-only redistribution; needs assignment
  curation before it becomes HOSE-ready. The intended v2 corpus.
- **User-supplied local database** or a **build-step download** from an authorized
  upstream.

Not suitable for bundling: NP-MRD (CC BY-**NC** — noncommercial mode only),
SDBS/AIST (explicit copyright), commercial libraries (SpectraBase/Wiley/ACD).

## Provenance checklist

Every bundled prediction database documents: asset name, upstream source + URL,
original authors, license + redistribution terms, modifications, entry count,
nuclei covered, and generation date (`NmrDatabaseProvenance` +
`NMRSHIFTDB2_LICENSE.md`).
