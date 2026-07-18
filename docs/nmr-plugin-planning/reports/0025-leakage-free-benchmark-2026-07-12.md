# Report 0025 — M29: leakage-free accuracy benchmark (first real numbers)

**Date:** 2026-07-12
**Worktree:** `~/Documents/programming/chemdraw-nmr` @ `codex/nmr-plugin`, commit `9ff03757` (pushed)
**Build stamp:** `7.12.9.57-fable`
**Decision:** [ADR-0026](../decisions/0026-leakage-free-benchmark-protocol.md)
**Raw run output:** [0025-benchmark-seed1.json](0025-benchmark-seed1.json)

## Milestone completed

M29 delivers the benchmark the plugin has needed since M17: held-out structures, scored through the
production lookup, with nothing tuned against the held-out set. The strychnine spot check (report
0023) is now backed by 9,662 held-out assigned shifts.

## Protocol (ADR-0026, summarized)

- Corpus: NMRShiftDB2 full NMReDATA export, downloaded 2026-07-12 from the provenance URL —
  **SHA-256 `831a31e78b004a308c7c40989e27d30698a34c506e722a91c78b6ed448fc4720`, 284,380,903 bytes**
  (recorded via the M28 mechanism). 64,710 usable records.
- Split **by structure identity** (OCL idcode, seeded FNV-1a): every record of the same compound —
  duplicates included — lands on one side. Seed 1, 20‰ → 1,338 held-out records; 6 unparseable
  records stay in train.
- Train-only database at production config (`n ≥ 5` prune): 39,231 entries from 48,606 structures
  (bundled artifact: 40,024 / 49,628 — consistent with removing ~2%).
- Held-out assignments scored through the **exported production lookup** (`matchEnvironment` +
  `shiftFor`, deepest sphere first, median statistic); tiers mirror the production rule; unmatched
  environments count as uncovered, never substituted.

## Results (seed 1)

**¹H — 375 structures, 2,513 assigned shifts, coverage 99.1%**

| slice | n | MAE (ppm) | median \|Δ\| | P90 |
|---|---|---|---|---|
| all matched | 2,491 | **0.358** | **0.17** | 0.93 |
| high tier | 820 | 0.183 | 0.079 | 0.47 |
| medium tier | 1,162 | 0.337 | 0.17 | 0.77 |
| low tier | 509 | 0.685 | 0.48 | 1.51 |

**¹³C — 795 structures, 7,149 assigned shifts, coverage 99.4%**

| slice | n | MAE (ppm) | median \|Δ\| | P90 |
|---|---|---|---|---|
| all matched | 7,103 | **3.58** | **1.58** | 8.8 |
| high tier | 2,472 | 1.51 | 0.66 | 4.36 |
| medium tier | 3,216 | 3.15 | 1.77 | 7.45 |
| low tier | 1,415 | 8.15 | 5.55 | 18.22 |

**¹H increment estimator vs HOSE** (rows where both produced a value, n = 915):
HOSE MAE **0.224** vs increment **0.364** — HOSE clearly better overall.
Low-tier subset (n = 109): HOSE 0.596 vs increment **0.581** — statistically indistinguishable.

## What the numbers establish

1. **The confidence tiers are empirically real.** Error orders exactly high < medium < low for both
   nuclei, with ~4–5× MAE separation between high and low. ADR-0020's "confidence = applicability"
   is now a measured property, not a design intention.
2. **The HOSE-first policy (ADR-0023/0024) is correct.** The increment table loses to HOSE overall
   by ~60% higher MAE and only reaches parity on the low tier — precisely the second-opinion,
   never-silent-winner role it was given.
3. **Coverage is excellent on NMRShiftDB2-like chemistry** (99%+ even with the held-out structure's
   own data removed) — the tight-prune database still generalizes across structures.
4. Headline for the panel-facing claim: **¹H median error 0.17 ppm; ¹³C median error 1.6 ppm** on
   held-out structures, with per-peak tiers that honestly stratify the risk.

## Caveats

- One seed, one corpus family: results speak for NMRShiftDB2-like (mostly small-organic) chemistry;
  they say nothing about chemistry the corpus lacks. Reference-shift noise in the corpus sets a
  floor no lookup can beat.
- CH₂ diastereotopic pairs are scored against one host prediction (the centroid approximation the
  product actually makes), so part of the ¹H low-tier error is irreducible under this model.
- ~~The upstream export has grown (64,710 records vs 49,628)~~ **Corrected (report 0026):** those
  are two different counters (parser records vs contributing structures); the M30 rebuild proved the
  corpus is the same export the bundled artifact was built from — 40,024 byte-identical entries.

## Verification actually run

- 6 new harness unit tests (split determinism, same-structure bucketing, memorized-twin zero error,
  uncovered handling, tier mirror, aggregation math) — green.
- `pnpm lint`, `pnpm test` (**1,478 passed, 9 skipped**), desktop `vite build` — green.
- Full-corpus run completed in one pass (NODE_OPTIONS=--max-old-space-size=6144, ~3 min);
  JSON output archived beside this report.

## Next milestone

Two natural follow-ups, neither started: (a) **corpus refresh** using the M28 pipeline (records the
checksum for real, picks up the larger upstream export; rerun the benchmark after); (b) surfacing
the benchmark headline (median error per tier) in the provenance panel so users see measured error
bars instead of only tiers.
