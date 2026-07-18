# Report 0003: NMR plugin package + fixture provider (M6) — 2026-07-08

Assignment: [prompts/03-nmr-plugin-fixture-provider.md](../prompts/03-nmr-plugin-fixture-provider.md).
Executed by Claude (Opus 4.8) in worktree `~/Documents/programming/chemdraw-nmr`,
branch `codex/nmr-plugin`, continuing from M1–M5. Build stamp `7.8.8.42-opus`.

## Outcome

**Milestone 6 complete.** The first-party NMR plugin package exists with its
domain contracts, OCL-based structure normalization, and a deterministic
fixture provider that proves atom-level prediction — not whole-molecule
canned-spectrum lookup.

```text
ChemicalStructureInput → normalizeStructure (OCL) → FixtureHosePredictor.predict
  → NmrPredictionResult { resonances (grouped equivalents, synthetic shifts,
    uncertainty, evidence "fixture-fragment"), no-match/partial/labile warnings,
    fingerprinted, schema-valid }
```

Validation (all run):
- `pnpm lint` (tsc): clean.
- `pnpm test`: **1262 passed, 9 skipped, 90 files** (was 1238/9/86 after M5 → +24 tests, zero regressions).
- `pnpm --filter @chemdraft/desktop build:web`: success (~18s) — the new package + `openchemlib`/`zod` deps do not break bundling (the package is not yet mounted; that is M8).
- Native `tauri build`: not run (packaging/signing gated).

## Assumption discrepancies

| Assumption | Verdict | Note |
|---|---|---|
| OCL exposes the atom/bond inspection needed | CONFIRMED | `fromSmiles`/`fromMolfile`, `ensureHelperArrays(cHelperRings)`, `isAromaticAtom`, `getConnAtom/Bond/BondOrder`, `getAllHydrogens`, `getAtomCharge` all present in `openchemlib@9.22.1` typings and behave as expected. |
| Example plugins have no per-package tsconfig | CONFIRMED | Root tsconfig `include`s `examples/plugins/*/src`; new package needed only a `package.json`. |
| `@chemdraft/plugin-nmr-predictor` resolves via package `exports` | CONFIRMED | Not in tsconfig `paths`; resolves through the workspace symlink after `pnpm install`. |
| Analyzer contribution shape | CONFIRMED (adjusted) | `PluginAnalyzerContributionSchema` is `{id,title,commandId,requiredPermissions?}` — **no** `input` field (that is recognizers); manifest written accordingly. |
| `PluginManifest` output type requires all 12 contribution arrays | CONFIRMED | Empty arrays listed explicitly, matching the molscribe example. |
| `validatePluginManifest` result shape | CONFIRMED (adjusted) | Returns `{ ok, manifest?, errors }` — not `.valid`. |

New fact: OCL's `getConnBondOrder` returns Kekulé orders, so the environment
generator uses `isAromaticBond` to mark aromatic bonds (`~`) rather than relying
on the numeric order — otherwise aromatic vs. single/double would be ambiguous.

## Files changed

New package `examples/plugins/nmr-predictor` (`@chemdraft/plugin-nmr-predictor`):
- `package.json`, `README.md` (⚠️ synthetic-data disclosure), `THIRD_PARTY_NOTICES.md`.
- `src/domain/` — `contracts.ts` (all `Nmr*` types + `NmrPredictor` + `NormalizedMolecule`, serializable), `errors.ts` (`NmrError` + hard-failure codes), `warnings.ts` (warning codes + `nmrWarning`), `schemas.ts` (zod request/result validators), `fingerprint.ts` (reuses `createStructureSourceFingerprint`).
- `src/application/normalizeStructure.ts` — OCL parse boundary + `toChemicalStructureInput` mapper (rejects unknown/empty).
- `src/providers/fixture/` — `fixtureEnvironment.ts` (BFS environment code), `fixtureDatabase.ts` (20 synthetic entries), `FixtureHosePredictor.ts` (the provider).
- `src/manifest.ts`, `src/index.ts`.
- `src/tests/` — `manifest.test.ts` (2), `normalizeStructure.test.ts` (7), `fixtureEnvironment.test.ts` (4), `fixturePredictor.test.ts` (11).

Modified: `AGENTS.md` + `MainWindow.tsx` (build stamp), `pnpm-lock.yaml` (new package deps).

## Key design decisions in the build

**Atom-level, not molecule-level (the point of the fixture).** Each atom gets a
deterministic environment code from a 2-sphere BFS
(`<element><aromatic><charge><Hcount>(sphere1)(sphere2)`), and the database is
keyed by that code. So symmetric atoms collapse (benzene → one 6-carbon
resonance), toluene resolves into its five unique carbons, and coverage is
per-fragment. The codes were captured from the generator's actual output for the
fixture molecules, so lookups are exact rather than hand-guessed.

**Honest partiality.** The database fully covers 9 molecules. Ethylbenzene is
covered only where it shares aromatic codes (meta/para carbons match benzene /
toluene-meta); its ipso, ortho, and ethyl carbons miss → `NMR_NO_FRAGMENT_MATCH`
+ `NMR_PARTIAL_PREDICTION`. This is a genuine partial result, not a staged one.

**Synthetic data, loudly labeled.** Values are hand-authored, flagged in the
README, `THIRD_PARTY_NOTICES.md`, the database header, and the `fixture-fragment`
method label — never described as experimental.

**Serializable by construction.** The result carries no OCL instances; a
`structuredClone` + `NmrPredictionResultSchema.parse` test guards the worker/store
boundary ahead of M7/M8.

**Determinism.** Injectable clock for `generatedAt`; stable id/order; a
predict-twice test asserts deep equality.

## Deviations from PLANS.md

- Added an optional `sourceFingerprint` to `NmrPredictionRequest` (echoed into the
  result when provided). The plan's request shape omits it, but the M4 fingerprint
  includes document/page/object identity the provider cannot see; carrying it
  through lets M8 produce records whose `source.sourceFingerprint` matches the live
  selection for staleness. When absent, the provider derives a structure-only
  fingerprint. Documented in `contracts.ts`/`fingerprint.ts`.
- `providers/ocl` and `providers/cheminfo` folders intentionally omitted (plan
  forbids unused placeholder code; they arrive with M10/M11).

## Unresolved risks / carried forward

1. **Worker bundling across workspace packages** is still unproven — the M7 spike is the gate. The provider is deliberately worker-ready (serializable I/O, `AbortSignal`).
2. Fixture chemical coverage is narrow by design; broadening waits for a real database (M10) with its own provenance.
3. Command error channel (ADR-0010), panel-close lifecycle (ADR-0012), and the report `source` schema field (D-09) remain scheduled for M7–M9.

## Next milestone

M7: the NMR worker + client (`worker/protocol.ts`, `nmrWorker.ts`,
`nmrWorkerClient.ts`) running the fixture provider off the main thread with
request-id correlation and cancellation, plus the worker-bundling spike. Not started.
