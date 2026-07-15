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

The plugin's **code license is not yet finalized**. The repository is not licensed for public
redistribution until the project owner chooses and applies explicit terms. The compiled database is
a **separate data asset** with its own license, surfaced at runtime in the panel's "Reference
database" section (see ADR-0014). The included `LICENSE` records the current internal-only code
status. Do not infer public code-redistribution permission from the data license or from a
dependency's license.

## Rule-parameter sources

The aliphatic additive estimator's compact sp3 C-H base values and alpha/beta/gamma
increments are transcribed numerical facts from P. S. Beauchamp and R. Marquez,
"A General Approach for Calculating Proton Chemical Shifts for Methyl, Methylene,
and Methine Protons When There Are One or More Substituents within Three Carbons,"
*J. Chem. Educ.* **1997**, 74, 1483-1485, DOI
[10.1021/ed074p1483](https://doi.org/10.1021/ed074p1483). ChemDraft's topology
classification and implementation are original; no article text or figures ship.

The aromatic benzene ortho/meta/para correction table consolidates numerical
values commonly reproduced in spectroscopy teaching tables, including:

- Royal Society of Chemistry, *Modern Chemical Techniques: Nuclear magnetic
  resonance spectroscopy*, Table 2
  ([PDF](https://edu.rsc.org/download?ac=13847)); and
- MIT OpenCourseWare, *UACA Appendix #2: Proton NMR Chemical Shift
  Substituent Effects*,
  ([PDF](https://mitocw.ups.edu.ec/courses/chemistry/5-311-introductory-chemical-experimentation-fall-2005/labs/uaca_appendix2.pdf)).

ChemDraft normalizes those standard numerical teaching values into its own
compact topology keys; it does not reproduce one source's prose, layout, or
table verbatim.

The aldehyde (9.7 ppm), terminal-alkyne (2.4 ppm), and vinylic (5.7 ppm)
fallbacks are ChemDraft-owned **coarse representative in-range heuristics**,
selected from the functional-class ranges in Beauchamp's teaching handout,
*1H NMR Chemical Shift Ranges* (pages 17-18,
[PDF](https://chemistryconnected.com/psb/pdf/NMR_Info_Tables_12-31-09.pdf)).
They are not outputs of the alpha/beta/gamma calculation and are surfaced as
functional-class estimates.
