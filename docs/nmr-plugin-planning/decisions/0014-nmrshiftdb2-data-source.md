# ADR-0014: NMRShiftDB2 as the M10 reference-shift database

- **Status:** accepted (2026-07-08) — user is the arbiter of the licensing call
- **Supersedes:** the conservative "MIT-only / use synthetic fixtures" default in PLANS.md's data-provenance section, per explicit user direction

## Context

M10 builds a real OCL-native HOSE/fragment predictor. Its engineering reuses the
repo's OpenChemLib 9.22; the open question was the reference database. The user
directed: **any reasonably permissive license (commercial or non-commercial) is
acceptable — not MIT-only** — and named NMRShiftDB2 as the first source.

## Decision

Build M10 v1 around **NMRShiftDB2**, specifically the downloadable NMReDATA/SDF
export `nmrshiftdb2rawdata.nmredata.sd` (196 organic structures with
atom-assigned ¹H/¹³C spectra; 1.16 MB; verified downloadable and parseable, and
its explicit-H molfile environment codes match implicit-H SMILES codes byte-for-byte).

Licensing handling (user-approved):
- Code stays MIT/open-source (satisfies the nmrshiftdb2 Database License requirement that prediction software be under an OSI-approved license).
- The **compiled** predictor database (aggregated HOSE-code → shift statistics) is a **separate, attributed data artifact** — nmrshiftdb2 Database License (ODbL-derived): commercial use permitted, share-alike on derivative databases. Ship the license text + attribution alongside it.
- The raw NMReDATA download is **not** committed; only the compiled statistics are.
- The plugin surfaces a **database provenance** panel (source, version, license, entry count, nuclei) — the PLANS provenance checklist, at runtime.

**Next-stage corpus (not this milestone):** NMRexp (Zenodo, CC BY 4.0, 3.37M
records) for a larger predictor / validation set; needs assignment curation first.
Non-choices for bundling: NP-MRD (CC BY-NC — fine only for a noncommercial mode),
SDBS/AIST (explicit copyright), commercial libraries (SpectraBase/Wiley/ACD).

## Consequences

M10 ships a real, experimentally-grounded predictor with honest, attributed
provenance and no remote-data dependency (contrast ADR-0013). Coverage is narrow
(196 structures) — the predictor must degrade gracefully (sphere fallback + wide
uncertainty + explicit no-match), and the panel must never present synthetic or
sparse predictions as authoritative. Broadening coverage is a data swap
(NMRexp / fuller NMRShiftDB2 dump), not a code change.
