# Report 0024 — M28: reproducible database rebuild (n ≥ 5 prune + raw-input checksum)

**Date:** 2026-07-12
**Worktree:** `~/Documents/programming/chemdraw-nmr` @ `codex/nmr-plugin`, commit `5b21a8a6` (pushed)
**Build stamp:** `7.12.9.38-fable`

## Milestone completed

M28 closes the standing maintenance slice from reports 0020–0023: the rebuild pipeline now enforces
the documented `n ≥ 5` prune itself and embeds the identity of the exact raw input in the artifact,
so `same input + same flags → same artifact` is verifiable.

## The gap that was closed

The bundled artifact's provenance note claimed "Environments pruned to n>=5 observations for bundle
size (from 529738 raw)", and an audit confirmed all 40,024 entries have `n ≥ 5` — but neither
`buildNmrDatabase` nor `scripts/build-database.ts` implemented any pruning. The M15 prune was applied
ad hoc and unrecorded; a rebuild from the raw dump was therefore not guaranteed to reproduce the
shipped size/content, and nothing recorded which raw input the artifact came from.

## What changed

- `buildNmrDatabase` gained `minObservations` (default 1 = no pruning, so library semantics and all
  existing tests are unchanged). When > 1, buckets below the threshold are dropped and provenance
  records `minObservations` plus `rawEntryCount` (the pre-prune environment count).
- `scripts/build-database.ts` (the production rebuild tool) defaults to the shipped `n ≥ 5` policy
  with a `--min-observations` override, computes SHA-256 + byte length of the raw input file, embeds
  them as `inputSha256`/`inputBytes`, and auto-composes the human-readable pruning note from the
  recorded values (no more hand-maintained numbers in prose).
- `NmrDatabaseProvenance` gained the four optional reproducibility fields; the existing bundled
  artifact (which lacks them) still loads unchanged.
- `docs/architecture/nmr-prediction-data.md` gained a "Rebuilding reproducibly" section; the plugin
  README's rebuild command now shows the flag.

## Verification actually run

- New unit tests: prune drops below-threshold environments and records rule + pre-prune count;
  default keeps everything and records nothing; input identity passes through provenance untouched.
- End-to-end on a synthetic 3-record corpus via `npx tsx scripts/build-database.ts`: 8 raw
  environments → 4 kept (all `n ≥ 5`), note composed from recorded values, and the embedded
  `inputSha256` byte-identical to `shasum -a 256` of the input file.
- Bundled-artifact audit: 40,024 entries, min `n` = 5, zero below threshold — consistent with the
  now-enforced rule.
- `pnpm lint` passed; `pnpm test` **1,472 passed, 9 skipped** (+3 new); desktop `vite build` passed.

## Deliberately not done

- The bundled artifact was **not** regenerated: the raw NMReDATA dump is not present in this checkout,
  and the upstream export may have moved since 2026-07-09, so a rebuild now would change data, not
  just metadata. Its raw-input checksum therefore remains unrecorded until the next corpus refresh,
  which records it automatically.

## Assumption-ledger update

The "database rebuild does not yet encode the shipped `n >= 5` pruning step" risk is resolved on the
code side; the residual (checksum of the *original* 2026-07-09 input is unrecoverable) is accepted —
the mechanism guarantees reproducibility from the next refresh forward.

## Next milestone

Slice 2: the leakage-free accuracy benchmark (protocol + harness), which depends on obtaining a raw
NMReDATA corpus — now with its checksum recorded at ingest.
