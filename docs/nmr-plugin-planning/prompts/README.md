# Assignment prompts

One bounded assignment per milestone group. This directory is the library;
`STATUS.md` says which assignment is active and what each one produced.

## Lifecycle

```text
draft  ->  ready to issue  ->  issued (agent running)  ->  done (report archived)
```

- Draft the next assignment from `TEMPLATE.md` while the current one runs,
  but mark it `Status: draft — finalize after NN's report` and revisit it
  against the previous report before issuing. Reports regularly invalidate
  prompt assumptions.
- One active assignment at a time. Never issue two prompts that touch the
  same packages concurrently.
- When issuing: give the agent this prompt plus the current `AGENTS.md` and
  `PLANS.md` (in the implementation worktree those live at the repo root).
  The prompt must stand alone — an agent should be able to execute it without
  reading this workspace's other process files.

## Numbering

Two digits, ordered by issue sequence, with a short slug:
`01-runtime-bringup.md`, `02-selection-analysis-apis.md`, …
Numbers never get reused or reordered, even if scope shifts. (The ChemDraft
repo itself uses `CODEX_PROMPT_NN_<topic>.md` at its root for the same idea;
if you drop a prompt file into the worktree, rename it to that convention.)

## Index

| # | Assignment | Milestones | Status |
|---|-----------|------------|--------|
| 01 | [Runtime bring-up](01-runtime-bringup.md) | M1–M3 | **done** → reports/0001 |
| 02 | [Selection extension + analysis API](02-selection-analysis-apis.md) | M4–M5 | **done** → reports/0002 |
| 03 | [NMR plugin package + fixture provider](03-nmr-plugin-fixture-provider.md) | M6 | **done** → reports/0003 |
| 04 | NMR worker + client (M7) | M7 | **done** (executed inline) → reports/0004 |
| 05 | NMR command + analysis integration (M8) | M8 | **done** (executed inline) → reports/0005 |
| 06 | NMR panel: stick spectrum + staleness + onPanelClosed (M9) | M9 | **done** (executed inline) → reports/0006 |
| — | M10 (OCL-native predictor) + M11 (nmr-predictor eval) | M10–M11 | **done** (executed inline) → reports/0007 |
| 07 | Documentation + provenance (M12) | M12 | **done** (executed inline) → reports/0008 |
