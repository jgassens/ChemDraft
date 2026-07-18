# Assignment 03: NMR plugin package + fixture provider

- **Status:** done (executed 2026-07-08 → [reports/0003](../reports/0003-nmr-fixture-provider-2026-07-08.md))
- **Milestones:** M6 (canonical numbering in `PLANS.md` → "Implementation sequence")
- **Depends on:** reports/0001 (runtime), reports/0002 (selection + analysis APIs)
- **Next assignment:** `prompts/04-*` (M7: NMR worker + client)

Work in the ChemDraft worktree (`~/Documents/programming/chemdraw-nmr`, branch `codex/nmr-plugin`).

Implement **Milestone 6 only**: create the NMR plugin package with its domain
contracts, structure normalization, and the deterministic fixture provider.

Do **not** implement: the worker or worker client (M7), the command handler /
`register.ts` / desktop mounting / analysis-store writing (M8), the report
composition / stick spectrum / panel (M9), or the OCL-native and `nmr-predictor`
providers (M10/M11). Leave `providers/ocl` and `providers/cheminfo` absent —
the plan forbids large unused placeholder code.

## Objective

Prove in tests (no desktop wiring in this assignment):

```text
ChemicalStructureInput (smiles / molfile)
  -> normalizeStructure (OCL parse, reject unknown/empty)
  -> FixtureHosePredictor.predict({ nuclei, options })
  -> deterministic NmrPredictionResult: resonances (grouped equivalents,
     synthetic shifts, uncertainty, evidence method "fixture-fragment"),
     warnings for unmatched environments, serializable, fingerprinted
```

## Verified repository state (re-verified 2026-07-07 @ worktree)

- OCL is available via `import * as OCL from "openchemlib"` (`^9.22.1`); methods confirmed in typings: `Molecule.fromSmiles`, `Molecule.fromMolfile`, `ensureHelperArrays(cHelperRings)`, `getAllAtoms`, `getAtomicNo`, `getAtomCharge`, `isAromaticAtom`, `getConnAtoms`/`getConnAtom`/`getConnBondOrder`, `getAllHydrogens`, `getImplicitHydrogens`.
- Example plugins have no per-package tsconfig; the root `tsconfig.json` includes `examples/plugins/*/src`. `zod ^3.25.76`.
- `@chemdraft/plugin-api` exports `createStructureSourceFingerprint`, `PluginStructureFormat`, and the `PluginAnalysis*`/manifest types (M4–M5).
- Domain contracts are specified in `PLANS.md` → "Structure normalization…", "Hydrogen treatment", the `NmrPredictor` block (~1508–1617), the fixture spec (~335–396), and the package layout (~1422). Error/warning code catalog at ~2221.

## Required implementation

Package `examples/plugins/nmr-predictor` → `@chemdraft/plugin-nmr-predictor`
(`private`, `type: module`, exports `./src/index.ts`; deps: `@chemdraft/plugin-api` workspace, `openchemlib`, `zod`; dev: `@chemdraft/plugin-host` workspace).

1. **domain/** — `contracts.ts` (the `NmrPredictor` interface + all `Nmr*` and `ChemicalStructureInput` types, exactly the PLANS shapes, serializable), `errors.ts` (`NMR_*` codes + a typed error), `warnings.ts` (`NMR_*` warning codes + helpers), `schemas.ts` (zod for request/result to guarantee worker/store serializability), `fingerprint.ts` (thin re-export/use of `createStructureSourceFingerprint`).
2. **application/normalizeStructure.ts** — `ChemicalStructureInput` → `NormalizedMolecule` via OCL; reject `unknown`/empty (`NMR_UNSUPPORTED_STRUCTURE_FORMAT` / `NMR_EMPTY_STRUCTURE`), surface parse failure (`NMR_STRUCTURE_PARSE_FAILED`); the normalized OCL molecule is the internal object.
3. **providers/fixture/** — `fixtureEnvironment.ts` (deterministic atom-environment key: central element, aromaticity, formal charge, H count, sorted first-shell neighbor descriptors, optional second shell), `fixtureDatabase.ts` (synthetic ¹³C/¹H shifts keyed by environment, covering the fixture molecules + one deliberately partially-unsupported), `FixtureHosePredictor.ts` (implements `NmrPredictor`: iterate the requested nuclei's atoms, look up, group equivalent environments into one resonance with `equivalentNuclei`, emit `NMR_NO_FRAGMENT_MATCH` for misses → partial status).
4. **manifest.ts** + **index.ts** — manifest declaring the command/menu/panel contributions with `plugin.nmrPredictor.*` / `menu.nmrPredictor.*` / `panel.nmrPredictor.*` ids (declaration only; handlers are M8). Barrel exports.

Fixtures: benzene, toluene, acetone, ethanol, ethyl acetate, acetonitrile,
cyclohexane, anisole, a para-disubstituted benzene, + one partially-unsupported
molecule. Synthetic values labeled as fixtures (method `fixture-fragment`),
never described as experimental reference data.

## Architectural constraints

- No React. No desktop/worker code. Result must be JSON-serializable (no OCL instances, functions, maps, or cyclic objects in `NmrPredictionResult`).
- Deterministic: same input → identical result (including ordering).
- Update the build stamp in `AGENTS.md` + `MainWindow.tsx` per convention.
- Do not commit/push unless instructed (this session: user asked to push after each slice).

## Acceptance criteria

`PLANS.md` acceptance tests for the fixture provider, plus: normalize rejects unknown/empty; fixture predictor returns complete result for benzene (one aromatic CH resonance, `equivalentNuclei` 6 for ¹³C) and other supported molecules; the partially-unsupported molecule yields a partial result with `NMR_NO_FRAGMENT_MATCH`; results are deterministic and schema-valid; manifest validates against the plugin-api schema.

## Validation

`pnpm lint`, `pnpm test`, `pnpm --filter @chemdraft/desktop build:web` (native `tauri build` gated — do not run). Package-specific tests must run.

## Final report

`reports/0003-*`: milestones completed, assumption-discrepancy table, files
changed, tests/builds run, deviations, risks, next milestone (M7 worker) —
without implementing it.
