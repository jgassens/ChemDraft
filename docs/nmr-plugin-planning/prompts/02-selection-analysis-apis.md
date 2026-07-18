# Assignment 02: Selection API Extension + Generic Analysis API

- **Status:** done (executed 2026-07-07 → [reports/0002](../reports/0002-selection-analysis-2026-07-07.md))
- **Milestones:** M4–M5 (canonical numbering in `PLANS.md` → "Implementation sequence")
- **Depends on:** assignment 01 (persistent runtime, canary, report renderer)
- **Next assignment:** `prompts/03-*` (M6: NMR plugin package with fixture provider)

Work in the ChemDraft repository worktree for this feature.

Read `AGENTS.md` and `PLANS.md` in full before editing, plus assignment 01's
archived report for the actual (not planned) shape of the runtime.

Implement **Milestones 4–5 only**:

1. extend the existing selection API with a format enum, source fingerprint, immutability, and document/page identity;
2. add the generic analysis API (`analysis?` on the command context) and an in-memory `AnalysisStore` in `plugin-host`.

Do **not** create the NMR plugin package, any predictor, worker, spectrum,
or NMR-named type in this assignment. Do not rename `getSelection()` or
change the optional-context-property convention (ADR-0008).

## Objective

Prove in tests (no new UI is required in this assignment):

```text
plugin with selection.read
  -> getSelection() returns an immutable, fingerprinted snapshot
plugin with analysis.write
  -> analysis.write() -> host-stamped record -> list/getLatest -> subscription fires
desktop (trusted)
  -> can read all analysis records for rendering
```

## Verified repository state (re-verify; finalize this list after 01's report)

- `PluginSelectionAPI.getSelection()` exists; `selectionStorage.test.ts` pins the optional-property behavior. _(verified 2026-07-07 @ 64cf513e)_
- The host returns the selection provider's object **as-is** — no deep copy. _(verified 2026-07-07 @ 64cf513e — `createCommandContext` in `packages/plugin-host/src/index.ts`)_
- `analysis.write` is in `pluginPermissions` but grants nothing anywhere. _(verified 2026-07-07 @ 64cf513e)_
- The host has an injectable `now` clock; there is no injectable ID factory yet. _(verified 2026-07-07 @ 64cf513e)_
- `PluginStructureFormat` values in the document model: `smiles`, `molfile-v2000`, `molfile-v3000`, `unknown` (`packages/chem-core/src/schemas.ts:347`). _(verified 2026-07-07 @ 64cf513e)_
- A selection-architecture refactor is pending (`PLANS-selection-policy.md`); the desktop selection provider from assignment 01 is the seam to extend. _(verify against 01's report)_
- <add: actual desktop selection-provider location and shape, from 01's report>

## Required implementation

### 1. Selection extension (M4)

Per `PLANS.md` → "Reconciliation with the existing selection API" and
"Milestone 4":

- narrow `PluginSelectedMolecule.structureFormat` to the `PluginStructureFormat` enum;
- add `sourceFingerprint` (FNV-1a 64-bit, synchronous, hex; see the `stableHash` spec in `PLANS.md`), computed by the host/provider boundary, documented as a change detector — not chemical identity;
- add `documentId`/`pageId` where the document model provides them; report if it does not;
- deep-copy or deep-freeze snapshots before returning them to plugins; add a test proving a caller cannot mutate what a later caller sees;
- keep the desktop provider a thin adapter over current selection state.

### 2. Generic analysis API and store (M5)

Per `PLANS.md` → "Generic host API additions", "Generic analysis storage",
and "Milestone 5":

- `PluginAnalysisSource`, `PluginAnalysisProvenance`, `PluginAnalysisWarning`, `PluginAnalysisRecordInput<T>`, `PluginAnalysisRecord<T>`, `PluginAnalysisQuery`, `PluginAnalysisAPI` in `plugin-api`;
- `analysis?` on `PluginCommandContext`, present only with `analysis.write` (matching the existing optional convention);
- `AnalysisStore` in `plugin-host`: host-generated record ID (injectable ID factory, default `crypto.randomUUID`), plugin-ID and timestamp stamping (injectable clock), deep-copy in and out, conjunctive query filtering (plugin, analysisType, document, page, object), deterministic ordering and `getLatest` tie-breaking, subscriptions;
- read policy exactly as `PLANS.md` defines: a plugin reads its own records; trusted desktop code reads all; no cross-plugin reads;
- analysis records never enter the native document and never create document patches.

## Architectural constraints

- No React, NMR types, nuclei, shifts, or provider names in `plugin-api`/`plugin-host`.
- No new dependencies.
- Extend, don't break: every existing `plugin-api`/`plugin-host` test keeps passing (adjust only tests whose pinned behavior this assignment deliberately extends, and say so).
- Update the build stamp in `AGENTS.md` and `MainWindow.tsx` per repository convention.
- Do not commit or push unless explicitly instructed.

## Acceptance criteria

`PLANS.md` acceptance tests **11–30** (plugin API and host tests), plus:

1. Snapshot immutability: mutating a returned snapshot does not affect the store or later callers.
2. Fingerprint determinism: same payload → same fingerprint; changed payload → changed fingerprint (acceptance tests 14–15).
3. A plugin without `analysis.write` sees `context.analysis === undefined`; with it, writes succeed and are host-stamped (tests 12, 16–18).
4. Deep-copy proof in both directions (tests 19–20).
5. Query filtering and deterministic `getLatest` (tests 21–25).
6. Subscriptions fire on analysis writes and plugin registration (tests 26–27).
7. The canary from assignment 01 still passes end-to-end untouched.

## Validation

```bash
pnpm lint
pnpm test
pnpm build
```

Plus package-specific tests for `plugin-api`, `plugin-host`, and the desktop
integration. Do not claim a command passed unless it ran.

## Final report

Standard structure (see `prompts/TEMPLATE.md`): milestones completed,
assumption-discrepancy table, files changed, tests/builds run, deviations,
risks, and the next milestone (M6: NMR plugin package, fixture provider) —
without implementing it.
