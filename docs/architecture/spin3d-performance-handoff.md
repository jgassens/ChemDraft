# Spin 3D Performance Handoff

**Status:** Point-in-time investigation notes, not current-state documentation. No behavior changes
were made by the pass that produced this. The recommendations below were never implemented — treat
them as an open backlog, and re-check the code before acting on any of them.

**Provenance:** Recovered verbatim from an uncommitted `handoff.md` in the `chemdraw-3d-advanced2`
worktree while pruning it on 2026-07-15. The worktree and its `codex/3d-advanced2` branch were
deleted after PR #8 merged; this document existed nowhere else, so it is committed here to keep the
findings. Body text is the original author's, unedited. Related: `3d-spin-flatten.md`.

The headline result is the non-obvious one: **first-3D-generation cost tracks graph *shape*, not
size** — a branched 63-atom chain takes ~8.1 s to embed while a straight 63-atom chain takes ~0.5 s.

---

## Summary

This pass investigated why Spin 3D can appear to hang on larger or more complex structures. No behavior changes were made during the investigation.

The main finding is that the slow path is real background engine work, not canvas drawing. Some structures spend several seconds in the first 3D generation step before the later refinement step starts. Repeated button clicks can also stack duplicate work in the worker queue.

## What Was Checked

I checked the current code paths around:

- the Spin 3D command entry
- selected-structure validation
- input conversion
- worker dispatch and queueing
- speculative preload
- first 3D generation
- later refinement
- trace event grouping
- debugger stale-row display
- click-outside commit handling
- Agent Bridge command and pointer coverage
- editor adapter capability boundaries
- native window/menu command routing

I also used Computer Use only to inspect whether a current app instance was already running. No GUI app was launched from that check.

## Test And Verification Results

These checks passed:

- `pnpm vitest run packages/ocl-adapter/src/index.test.ts packages/editor-adapter/src/index.test.ts packages/ketcher-adapter/src/index.test.ts`
- focused app tests for worker/client tracing, debugger rows, Agent Bridge, and drawing tools
- `pnpm vitest run apps/desktop/src/App.test.ts apps/desktop/src/documentWorkflow.test.ts apps/desktop/src/spinFlatten.test.ts`
- `pnpm lint`
- `cargo test` in `apps/desktop/src-tauri`
- `git diff --check`

## Timing Findings

Synthetic timing showed that size alone is not the full story. Shape and branching matter a lot.

Observed examples:

- 63-node straight SP3-hybridized chain: first 3D step about 0.5s, refinement about 6.0s
- 63-node branched SP3-hybridized chain: first 3D step about 8.1s, refinement about 8.8s
- 63-node mixed-link chain: first 3D step about 1.0s, refinement about 3.8s
- 28-node compact multi-ring structure: first 3D step about 5.3s, refinement about 0.5s
- compact fused-ring structures: first 3D step and refinement were both very fast
- input parsing stayed tiny, roughly 2-5ms

This matches the debugger screenshots: rows stuck in the first 3D generation stage are credible real engine stalls for some graph shapes.

## Queue Findings

The worker is sequential. Once the engine starts a heavy synchronous step, that step cannot be interrupted.

Current behavior already coalesces some speculative preload work, but repeated explicit Spin 3D requests can still grow the queue for the same selected structure. Debugger rows such as `worker.submit queue 3` or `worker.submit queue 4` likely mean repeated clicks or preload/generate backlog are stacked behind an active engine call.

## Debugger Findings

A row that says `Likely hung` while showing `0 ms` is probably a display/bookkeeping issue. Active rows should show elapsed wall time, not a stale duration value.

The debugger should distinguish:

- work that is still actively running
- work that completed
- work whose completion event may be missing
- work skipped because it was duplicate
- work skipped because preload was too expensive

Payloads should stay summarized. Do not dump full input text.

## Click-Outside Commit Findings

Click-outside commit currently depends on the original selected structure box plus padding. The user may perceive the current 3D visual bounds differently after rotation, so some clicks that look outside the visual structure can still be inside the original padded box.

Commit can also be refused by existing safety checks. When that happens, the overlay remains active and only the status text explains why. That can feel like the click did nothing.

The next pass should improve diagnostics first. Do not change projection math, flatten math, object geometry, drawing output, or safety checks unless a focused pointer/hit-test bug is proven.

## Adapter Findings

The Agent Bridge looks useful for command and pointer QA. It can provide snapshots, invoke commands, resolve points, and dispatch pointer events through the app handlers.

The editor adapter lane is narrower. It is useful as a boundary for one selected structure, but it is not a full oracle for Spin 3D performance or false-positive diagnosis.

## Recommended Next Work

- Coalesce duplicate explicit Spin 3D requests for the same input.
- Prevent repeated button clicks from growing the queue.
- Add trace rows for skipped or coalesced work.
- Make speculative preload conservative for large or high-risk inputs.
- Show elapsed wall time for active debugger rows.
- Surface whether the active wait is first 3D generation, refinement, queued, skipped, or coalesced.
- Improve visible status when a click-outside commit is refused by existing safety checks.
- Avoid changing 3D rendering, projection math, flatten math, object drawing, or visual output.

## Remaining Limitation

Some engine calls are synchronous and can still take several seconds for difficult structures. Refactoring cannot make that engine call intrinsically fast, but it can prevent duplicate work, reduce surprise preloading, and make the app explain what it is waiting on.
