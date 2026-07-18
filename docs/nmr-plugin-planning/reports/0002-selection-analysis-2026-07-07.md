# Report 0002: Selection extension + analysis API (M4–M5) — 2026-07-07

Assignment: [prompts/02-selection-analysis-apis.md](../prompts/02-selection-analysis-apis.md).
Executed by Claude (Opus 4.8) in worktree `~/Documents/programming/chemdraw-nmr`,
branch `codex/nmr-plugin`, continuing from M1–M3 (reports/0001).

## Outcome

**Milestones 4–5 complete.** The generic selection and analysis surfaces the
NMR plugin will consume now exist, both as extensions that preserve the
repo's tested conventions.

Validation (all run):
- `pnpm lint` (tsc): clean.
- `pnpm test`: **1238 passed, 9 skipped, 86 files** (was 1223/9/83 after M3 → +15 tests, zero regressions).
- `pnpm --filter @chemdraft/desktop build:web`: success (~16s).
- Native `tauri build`: not run (packaging/signing gated, as in reports/0001).

## Assumption discrepancies

| Assumption | Verdict | Note |
|---|---|---|
| A11 — command context lacks a selection API | CONFIRMED FALSE (as recorded) | Extended `getSelection()` in place; did not add a parallel API (ADR-0008). |
| A17 — host returns the provider's selection object un-copied | CONFIRMED, now FIXED | `createCommandContext` deep-clones (`structuredClone`) + deep-freezes each snapshot. |
| A12 — `analysis.write` grants nothing; no analysis API/store | CONFIRMED, now BUILT | `PluginAnalysisAPI` + `AnalysisStore`. |
| A18 — host lacks analysis store / subscriptions | CONFIRMED, now BUILT | Store added; `subscribe` (from M2) now also fires on analysis writes. |
| `crypto.randomUUID` available for the default id factory | CONFIRMED | Present in the Node test runtime and browsers; injectable for deterministic tests. |

No surprises. One implementation note: the fingerprint separator was authored
as a literal U+001F byte and corrected to the readable \u001f escape (an
invisible control char in source is fragile).

## Files changed

New:
- `packages/plugin-host/src/analysisStore.ts` — `AnalysisStore` (+ `analysisStore.test.ts`, 8 tests).
- `apps/desktop/src/plugins/selectionSnapshot.ts` — `buildPluginSelectionSnapshot` (+ `selectionSnapshot.test.ts`, 3 tests).

Modified:
- `packages/plugin-api/src/index.ts` (+111) — `PluginStructureFormat` enum; extended `PluginSelectedMolecule` (`structureFormat` narrowed to the enum, `sourceFingerprint`, `documentId?`/`pageId?`); `createStructureSourceFingerprint` (FNV-1a 64-bit, synchronous, non-cryptographic); the `PluginAnalysis*` type family; `analysis?` on `PluginCommandContext`.
- `packages/plugin-api/src/index.test.ts` (+3 tests) — fingerprint determinism / change / boundary safety.
- `packages/plugin-host/src/index.ts` (+~90 net) — deep-clone+freeze of selection snapshots; `AnalysisStore` construction with injectable id factory (`createId`, default `crypto.randomUUID`) + clock; `analysis` context API (plugin-scoped reads); `listAnalysis`/`getLatestAnalysis` (unscoped desktop read); `AnalysisStore` re-export.
- `packages/plugin-host/src/selectionStorage.test.ts` (+1 test, fixtures) — snapshot immutability + independence; fixtures gain `sourceFingerprint`.
- `apps/desktop/src/MainWindow.tsx` (net −10) — selection provider is now `buildPluginSelectionSnapshot(documentRef.current)`; dropped the inline mapping and the `getSelectedMolecules` import.

## Key design decisions in the build

**Fingerprint (M4).** `createStructureSourceFingerprint` joins
document/page/object id + format + trimmed structure with a unit separator and
hashes with FNV-1a (64-bit, BigInt). Synchronous and dependency-free on
purpose — `crypto.subtle` is async and absent in some worker/webview contexts.
Documented as a change detector, not a molecular identity. The desktop provider
computes it (it owns document identity); the host stays domain-agnostic.

**Immutability (M4).** The host `structuredClone`s then deeply freezes each
snapshot before handing it to a plugin, so a plugin can mutate neither the
host's state nor a later caller's result. Proven by a frozen + independent-copy
test.

**Analysis store (M5).** In-memory, session-scoped, unbounded (ADR-0005).
Host stamps id (injectable factory) / plugin id / time (injectable clock);
deep-copies on write and on read; conjunctive query filtering by
plugin/type/document/page/object; `getLatest` is newest-by-`createdAt` with
write-order tie-break (deterministic even under a fixed test clock).

**Read policy (ADR-0005).** A plugin reads only its own records — the host
forces `pluginId` onto every `list`/`getLatest` query from `context.analysis`.
Trusted desktop code uses the unscoped `host.listAnalysis` /
`getLatestAnalysis`. Verified by a two-plugin test.

**Convention preserved (ADR-0008).** `analysis?` is a permission-gated optional
context property like `selection?`/`panels?`/`storage?`; a plugin without
`analysis.write` sees `undefined`.

## Deviations from PLANS.md

- None material. The analysis store lives in its own file
  (`analysisStore.ts`) as PLANS suggested; the desktop selection logic was
  extracted to `selectionSnapshot.ts` (pure, testable) rather than inlined in
  MainWindow — consistent with the M1–M3 "keep logic out of MainWindow" rule.

## Unresolved risks / carried forward

1. Report source-ref schema field (D-09) is still M9 — not added (no consumer yet; correctly deferred).
2. Command error channel (D-06/ADR-0010) and panel-close lifecycle (D-08/ADR-0012) remain scheduled for M8/M7.
3. Worker bundling across workspace packages still unproven — spike early in M7.

## Next milestone

M6: create the NMR plugin package (`examples/plugins/nmr-predictor`,
`@chemdraft/plugin-nmr-predictor`) with domain contracts, structure
normalization, and the deterministic fixture-fragment provider. Not started.
