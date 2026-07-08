# Third-party notices

## Runtime dependencies

- **openchemlib** (BSD-3-Clause) — molecule parsing, aromaticity perception, and
  atom/bond topology used by `application/normalizeStructure.ts` and the fixture
  environment generator. This is the same OpenChemLib version ChemDraft already
  ships (`^9.22.1`); the plugin deliberately reuses it rather than introducing a
  second OCL runtime.
- **zod** (MIT) — runtime validation of the serializable prediction request/result.
- **@chemdraft/plugin-api** (workspace) — the generic plugin contracts.

## Prediction data

Two providers ship, with separately-tracked data:

- **Fixture provider** (`providers/fixture/fixtureDatabase.ts`) — **ChemDraft-owned
  synthetic fixtures**, not derived from any experimental dataset. Used for
  deterministic tests / offline fallback.
- **OCL-native provider** (default) — its reference database
  `providers/ocl/nmrshiftdb2.database.json` is a **derivative database compiled
  from NMRShiftDB2** experimental assignments, under the **nmrshiftdb2 Database
  License** (ODbL-derived; commercial use permitted, share-alike, attribution).
  Provenance, license, and attribution: `providers/ocl/NMRSHIFTDB2_LICENSE.md`.
  It contains aggregated statistics only, no structures. Rebuild via
  `scripts/build-database.ts`.

The plugin **code** is MIT/open-source; the compiled database is a **separate
data asset** with its own license, surfaced at runtime in the panel's
"Reference database" section (see ADR-0014).
