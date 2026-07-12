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

- **Coverage + bounded fallback.** The full corpus covers common groups (aldehydes,
  carbonyls, etc.). An absent environment receives a **rule-estimated** shift only
  when a versioned local rule declares itself applicable. The resonance carries that
  rule's exact id, version, and method and is recorded as partial. Unsupported
  environments are omitted with `NMR_NO_FRAGMENT_MATCH` / partial-result warnings;
  they are never coerced into a generic alkyl or benzene value.
- **Additive-increment comparison.** Every ¹H HOSE match whose chemistry is
  supported by the bounded tables may carry a second, versioned additive-increment
  estimate. The v1.3 sp3 scheme uses separate methane/methyl/methylene/methine
  baselines plus alpha/beta/gamma substituent corrections through three carbons.
  Heteroarenes, imines, charged/isotopic/
  radical structures, sulfur/silicon substituents, and other out-of-table cases are
  explicitly inapplicable and therefore cannot replace the HOSE value. When a valid
  comparison exists, the figure offers **Prefer HOSE** / **Show both**. With no
  applicable values, the same control remains visible but disabled as HOSE-only.
  The absolute/σ threshold flags disagreement and broad reference distributions;
  neither condition controls visibility. Notices report comparison coverage and
  withhold an overall agreement conclusion when fewer than three resonances or
  less than half of the HOSE resonances can be compared. Both methods retain
  per-resonance provenance.
- **Potentially nonequivalent methylene hydrogens.** For a stereogenic structure,
  CH₂ sites receive `NMR_POTENTIALLY_DIASTEREOTOPIC_HYDROGENS`. The warning explains
  that this provider reports one carbon-hosted shift and does not fabricate separate
  diastereotopic values.
- **Rule parameter provenance.** The aliphatic alpha/beta/gamma constants cite the
  Beauchamp–Marquez primary paper; aromatic values consolidate standard RSC/MIT
  teaching tables. The aldehyde/vinylic/alkynyl fallbacks are separately labeled
  ChemDraft coarse representative in-range heuristics rather than outputs of either increment
  table. Exact sources and links are in `THIRD_PARTY_NOTICES.md`.
- **Multiplicity + J.** First-order multiplicity and class-typical coupling constants
  are estimated from the bond topology (`supportsCouplings: true`) and drawn as split
  peaks — estimates for readability, not a spin simulation (ADR-0017/0018).
- Shallow-sphere matches (`NMR_LOW_HOSE_SPHERE_MATCH`), small reference populations
  (`NMR_SMALL_REFERENCE_POPULATION`), and omitted labile protons are still surfaced.

The predictor **never presents an estimate as a measured match**: DB matches are
`hose-fragment`; estimates are `rule-estimated` with estimator provenance. The
fixture provider's values are labeled synthetic everywhere they appear.

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
