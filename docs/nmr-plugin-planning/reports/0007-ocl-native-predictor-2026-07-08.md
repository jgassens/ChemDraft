# Report 0007: OCL-native predictor + NMRShiftDB2; nmr-predictor rejected (M10 + M11) — 2026-07-08

Executed inline. Worktree `~/Documents/programming/chemdraw-nmr`, branch `codex/nmr-plugin`. Build stamp `7.8.8.42-opus`.

## Outcome

**M10 done and M11 resolved.** The default NMR provider is now a real,
experimentally-grounded **OCL-native HOSE/fragment predictor** backed by a
database compiled from **NMRShiftDB2** — not synthetic fixtures. M11 (the
cheminfo `nmr-predictor` package) was **rejected** on evidence, without
installing it.

Validation (all run):
- `pnpm lint`: clean.
- `pnpm test`: **1315 passed, 9 skipped, 101 files** (was 1307/9/98 → +8 net; the NMR package went 57→72 tests).
- `pnpm --filter @chemdraft/desktop build:web`: success; `nmrWorker-*.js` chunk is 1.99 MB (was 1.16 MB) — it now bundles the OCL predictor + the 817 KB database, lazy-loaded on first prediction.
- Native `tauri build`: not run (gated).

## M11 — reject `nmr-predictor` (ADR-0013)

Read-only pre-flight settled it: `nmr-predictor@1.2.0` → `openchemlib-extended@4`
→ **`openchemlib ^5.6.1`** (vs ChemDraft's `^9.22.1` — duplicate OCL across four
majors) and depends on **`superagent`** (remote data). Two kill criteria; last
published 2022. No dependency added.

## M10 — OCL-native predictor (ADR-0014)

**Database (data asset).** Downloaded NMRShiftDB2's `nmrshiftdb2rawdata.nmredata.sd`
(1.16 MB, 196 atom-assigned structures). A `scripts/build-database.ts` pipeline
parses each record (molfile via OCL with `setAtomMapNo` to survive helper-array
reordering; the NMReDATA `ASSIGNMENT` + `1D_13C`/`1D_1H` blocks), derives each
assigned atom's environment code at spheres 1–4, and aggregates shifts to
median/mean/stdev/min/max/n. Result: **129 structures → 5020 entries** (3034 ¹³C
+ 1986 ¹H), a **817 KB** `nmrshiftdb2.database.json` (statistics only — no
structures). A pivotal invariant was verified first: explicit-H molfile codes are
**byte-identical** to implicit-H SMILES codes, so a molfile-built database matches
live SMILES queries.

**Engine.** `OclHosePredictor` normalizes the structure, computes each atom's
codes, and looks them up **deepest-sphere-first with fallback**; it reports the
aggregated median + dispersion + sample count + matched sphere, groups equivalent
environments, and **warns rather than fabricates** (`NMR_NO_FRAGMENT_MATCH`,
`NMR_LOW_HOSE_SPHERE_MATCH`, `NMR_SMALL_REFERENCE_POPULATION`) — behaving exactly
as ADR-0014 requires for a narrow database. Method label `hose-fragment`.

**Provenance.** `NmrPredictionBackend` gained `license`/`attribution`/`source`;
the OCL predictor stamps them from the database, and the panel renders a
"Reference database" section + attribution. `NMRSHIFTDB2_LICENSE.md` +
`THIRD_PARTY_NOTICES` document the nmrshiftdb2 Database License (ODbL-derived;
commercial OK, share-alike, attribution) and keep code (MIT) and data (separate
asset) distinct.

**Default wiring.** The worker core selects the OCL predictor unless the fixture
is explicitly requested; `createWorkerBackedPredictor` and the desktop in-thread
fallback both default to OCL. The fixture provider stays for deterministic tests
and offline fallback.

Tests (+15): `oclEnvironment` (3), `buildDatabase` (2, incl. an ingestion
round-trip via a constructed NMReDATA record), `oclHosePredictor` (3: build→predict
round-trip returns the training shifts; no-match warns not fabricates; the real
bundled DB carries provenance + dispersion).

## Honest limitations (by design)

- **Coverage is narrow** (129 structures): many atoms match only sphere 1 (coarse) and quaternary/carbonyl carbons often have no match → copious low-confidence warnings. This is correct, disclosed behavior — the panel never presents thin predictions as authoritative. Broadening is a **data swap** (fuller NMRShiftDB2 dump, or NMRexp CC BY 4.0), not a code change (ADR-0014).
- Worker bundle ~1.99 MB (OCL + DB), lazy.

## Files changed

New: `providers/ocl/` (`environmentCode.ts`, `localDatabase.ts`, `buildDatabase.ts`, `OclHosePredictor.ts`, `nmrshiftdb2.database.json`, `NMRSHIFTDB2_LICENSE.md`), `scripts/build-database.ts`, 3 test files.
Modified: `domain/contracts.ts` + `schemas.ts` (backend provenance fields), `domain/warnings.ts` (`NMR_LOW_HOSE_SPHERE_MATCH`), `report/composePredictionReport.ts` (database section + experimental vs synthetic note), `worker/nmrWorkerCore.ts` + `application/workerPredictor.ts` (OCL default), `apps/desktop/.../registerBundledPlugins.ts` (OCL fallback), `index.ts`, `THIRD_PARTY_NOTICES.md`.

## Next

Phase-1 milestones M1–M10 are complete; M11 resolved (reject). Remaining: **M12**
(documentation + provenance write-up — much of the provenance now ships in-app).
NMRexp (CC BY 4.0) remains the future larger-corpus path.
