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

The shift values in `providers/fixture/fixtureDatabase.ts` are **ChemDraft-owned
synthetic fixtures** authored for this repository. They are not derived from, and
must not be represented as, any experimental or third-party NMR dataset. No
external fragment database is bundled in this milestone.

When a real fragment database is later introduced (M10+), the provider
implementation and the prediction data must be tracked as separate assets with
separate provenance and licenses, and this file updated accordingly.
