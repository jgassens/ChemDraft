# Reaction-arrow stress results

The audit below predates the later October 24 preference and conditions-position fixes.
For the current uncommitted follow-up, see the first section of the
[handoff](reaction-arrows-handoff.md). Its validation supersedes these counts for current source.

2026-10-24 continuation of the 2026-10-23 run. Branch: `codex/reaction-arrows`.
This records automated coverage of the [manual checklist](manual-stress-checklist.md);
it does not mark native hands-on items complete.

## Results

**216 distinct tests passed across 14 suites**, including nine new tests from one independent
agent. No reproducible product bug was found. Root TypeScript and `git diff --check` passed.
No production code changed. The existing uncommitted `AGENTS.md`, `PLANS.md` and handoff were
preserved; nothing was staged, committed, pushed or merged.

| Checklist area | Automated evidence | Remaining hands-on check |
| --- | --- | --- |
| Overlapping arrows and context targeting | Grouped targets, overlapping parent frames, submenu keyboard navigation and distinct shafts 2 px apart passed | Real pointer/menu input on both platforms |
| Nested arrows and extreme transforms | Seven-level mixed half/full trees at scales 0.02×20, 15×0.03, 0.1×0.1 and 3×2; rotations 89.9°, 179.9°, 1080° and −719.5°; reversed ten-level stacking passed | Inspect live previews and page-edge behavior |
| Full-curve editing | Tether, independent/paired endpoint drags, third Shift-frame handle, typed rotation and arrow resizing passed in DOM tests | Native pointer input, typed percentages and unequal group resize |
| Repeated formatted text | All 45 replacement ranges in eight repeated characters; ten successive formatted label edits/reopens retaining manual placement; existing beforeinput deletion/insertion cases passed | Real keyboard editing, field Undo/Redo and IME in native webviews |
| Undo/Redo and copy/delete | One-step document Undo/Redo, arrangement Save/removal, 12-level duplicate/paste/delete and remapped attachment IDs passed | Native menus/shortcuts and OS clipboard |
| Save/reopen | Native document serialization round trips retain geometry, formatting and label placement; second normalization is stable | Actual file dialogs, disk writes and reopening in the packaged app |
| Export | SVG byte stability after reopen; existing SVG/PDF geometry, formatted baselines and Unicode regressions passed | Visual canvas/SVG/PDF/raster comparison on both platforms |
| Arrangement workflow | Length-only edits, retained attachments/styles, removal of owned trees, stale Save refusal and drawing after Save passed | Native dialog focus recovery and monitor/DPI checks |

The independent agent's first run had **23 passes and one failed audit assertion**. That assertion
expected the root arrow at the exact tether shared with a branch; the topmost branch correctly won.
The corrected fixture isolates two distinct shafts, and the final nine-case audit passed. This was
a test-fixture error, not a confirmed application bug. Both agent commands ran inside the sandbox;
no command was blocked, no escalation was needed, and no rejection was bypassed.

The parent's later diagnostic command was sandbox-blocked while checking the pending TypeScript
process. Approval was requested for the exact command below; the approved rerun succeeded.
TypeScript then completed with exit 0. No rejected action was bypassed.

```sh
ps -axo pid,ppid,etime,%cpu,command | rg 'pnpm lint|typescript/bin/tsc|tsc -p tsconfig'
```

## Commands and counts

Run these serially from the repository root:

```sh
pnpm vitest run apps/desktop/src/reactionArrowAttachments.dom.test.tsx apps/desktop/src/dialogs/ReactionConditionsForm.dom.test.tsx apps/desktop/src/dialogs/ReactionConditions.native.dom.test.tsx apps/desktop/src/arrangement.dom.test.ts --maxWorkers=1 --fileParallelism=false
# 30 passed, four suites

pnpm vitest run apps/desktop/src/reactionArrowAttachments.test.ts apps/desktop/src/fullCurveTether.test.ts apps/desktop/src/arrowRefinements.test.ts apps/desktop/src/independentArrowAudit.test.ts apps/desktop/src/arrangementConnections.test.ts apps/desktop/src/arrangementSpacing.test.ts packages/export-engine/src/svg.test.ts packages/export-engine/src/pdf.test.ts --maxWorkers=1 --fileParallelism=false
# 162 passed, eight suites

pnpm vitest run tools/reaction-arrows/adversarialReactionArrows.test.ts --maxWorkers=1 --fileParallelism=false
# 9 passed, one independent suite

pnpm vitest run apps/desktop/src/graphicPathEdit.dom.test.ts -t 'arrow|full-curve|Shift-frame' --maxWorkers=1 --fileParallelism=false
# 15 passed; 60 intentionally excluded by the name filter

pnpm lint
git diff --check
```

The agent also reran the existing attachment/form DOM suites (15 passes); those are included in
the 216 distinct-test total, not counted twice. The full JavaScript gauntlet, Rust checks and
production builds were not rerun in this validation-only pass.

## Platforms and build

- **macOS:** automated tests ran on this host. Native hands-on checks remain unverified:
  `cua.getState()` returned `Sky Computer Use service startup request failed`, including after
  resuming on October 24. No app launch or rebuild was attempted with UI access unavailable.
- **Windows:** no Windows host was available. Native execution, WebView2 editing/IME, menus,
  focus, save/reopen, mixed DPI and visual exports remain unverified. The conditions form tests
  exercise simulated macOS/Windows shortcut branches; that is not native Windows verification.
- Source stamp remains `10.23.14.28-codex`. `pnpm running-build` reported a registry entry with
  stamp `10.23.09.35-codex`, label `ChemDraft [codex/reaction-arrows]`; its last-seen entry was
  stale. It does not verify that current source is loaded. The handoff's prior packaged build
  remains historical evidence only.
- The owner-deferred 66-level nesting limit remains unchanged and outside this bounded audit.

Next task: restore computer-use access and run one packaged macOS milestone pass, followed by
the corresponding native Windows checklist. Keep the slice in flight until those gates and
the clean full CI run pass. A fresh thread can use the [handoff](reaction-arrows-handoff.md)
and this report without repeating the automated pass unless source changes.
