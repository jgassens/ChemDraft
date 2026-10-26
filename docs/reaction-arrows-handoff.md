# Reaction arrows: thread handoff

## Reconciliation checkpoint (2026-10-25)

PR #202 now includes upstream main `5b0837d` and the actual standalone #201 head
`831233e` as merge ancestors. No feature commits were rewritten. The old #201 commit
remains in history, but its implementation is reconciled with the standalone branch:
rotation and flip expand the attachment tree, while conditions, arrangement metadata,
independent preferences and the combined spacing workflow are retained. Duplicate barrel
imports/exports from the overlapping branch extraction were removed. Upstream plugin command
input forwarding is retained alongside the independent arrow-preference guards.

This is still an integration PR against upstream `main`, not a standalone conditions-only PR.
#200 and #201 remain unmerged dependencies; merge those before #202 and review the remaining
diff afterward (squash merges may require another branch update). The standalone offshoot
handoff describes #201's own scope, not a prohibition on conditions in this integration branch.
Source stamp: `10.25.19.00-codex`. The original development checkout's uncommitted work is untouched.

Validation of code head `7086b53`:

- Local root TypeScript, whitespace checks, Rust formatting and macOS Clippy with
  `-D warnings` passed. The original TypeScript pass preceded the precision fix; CI's
  Linux and Windows TypeScript checks passed on `7086b53`, including that fix and its test.
- 62 geometry/attachment cases and 63 art-engine cases passed after the precision fix.
  The unchanged adversarial tests retain their original exact-junction assertions.
- All 16 arrangement DOM cases passed with a local diagnostic `--testTimeout=60000`.
  All 135 graphic-path DOM and PDF cases also passed with that diagnostic timeout.
  SVG (21), drawing tools (20) and agent bridge (6) passed with normal settings.
  Repository and CI timeouts were not modified. Initial default-timeout attempts hit
  timeouts and cascading DOM failures; those attempts are not claimed green.
- The full Vitest attempt was stopped after hover-label stress timeouts and cascading
  failures; no clean local full-suite pass is claimed.
- CI run `40261554875` passed the build-stamp gate, Linux and Windows TypeScript,
  and the complete macOS job (production web build, Rust fmt, Clippy and Rust tests).
  Its Linux/Windows full-suite jobs were still running at handoff. These results are
  for `7086b53`; the following commit changes this handoff document only.
- Local Rust tests were stopped during dependency compilation. The development-launch
  attempt, `CHEMDRAFT_DEV_PORT=5183 ./run-app --dev`, was stopped while waiting for the
  Cargo lock, before the app launched; no native build-label or hands-on result is claimed.
  The redundant local production web build and final TypeScript rerun were stopped after
  CI passed those checks. `pnpm build` / a packaged native build was not completed.
- Native macOS and Windows focus, pointer, monitor and attachment-transform checks remain
  unverified. The slice stays in flight; the extreme attachment-depth limit is unchanged.

Next task: let required CI finish, land #200 and #201, then review #202's remaining diff
and run the shared native manual checklist on both platforms before merging it.

## Integration checkpoint (2026-10-24)

The owner authorized publishing and merging all three feature commits into `jgassens/ChemDraft`
main. Integration is prepared in `codex/reaction-arrows-merge`, based on main `f9f1a3d`. The original
`codex/reaction-arrows` checkout and its uncommitted work are preserved. All follow-up fixes are
included in the three-commit series, attributed to Emily Osborn at her GitHub email.
Source stamp: `10.24.12.19-codex`. Full integration validation and cross-platform CI are pending;
native macOS/Windows hands-on checks remain unverified. Earlier sections are historical records
and their branch, commit and validation statements apply to the checkpoints they describe.

## Preferences copy/layout polish (2026-10-24)

- Keep the Optional arrow tools legend on one line using its intrinsic width and no wrapping.
  Remove “Off by default” from the parent and all three child descriptions; defaults are unchanged.
- Latest source stamp: `10.24.12.00-codex`, including the quick-layout rerouting fix below.
  Existing uncommitted work is preserved. No new build or launch for this small copy/CSS edit;
  23 Preferences/settings tests and whitespace checks passed. Native macOS/Windows visual
  confirmation remains outstanding.

## Quick layout rerouting fix (2026-10-24; supersedes source stamp below)

- Owner reproduced a saved Circle → Grid change leaving the old circular arrows behind.
  The quick layout commands called the compound-only planner, unlike Arrange with options.
  Explicit quick layout changes now use the generated-connection workflow when selected compounds
  have saved connections, forcing a fresh layout and routes. Matching endpoint pairs retain arrow
  IDs/styles and attachment trees; ordinary molecule drags and unrelated hand-drawn arrows remain
  independent. Fit/routing refusal preserves the whole source drawing.
- Source stamp: `10.24.11.55-codex`; branch remains `codex/reaction-arrows`. All earlier edits and
  the three existing commits are preserved. Nothing staged, committed, pushed or merged.
- Reproduced the failure before editing implementation with three failing Grid left/center/right
  regressions. Those now pass, including SDK conditions, full-curve offshoots, save/reopen and SVG.
  The actual Grid menu now has a DOM regression after saving a connected circle, with Undo/Redo.
  144 distinct focused tests pass across seven suites. A first DOM test attempt used a nonexistent
  command ID; corrected to click the actual Grid flyout item. Root TypeScript and whitespace
  checks also passed.
- No new web/native build or native launch for this narrow fix. The last production web build
  predates it (`10.24.11.35-codex`); use one fresh `./run-app` owner preview to verify the new source.
  Native macOS/Windows UI and full CI remain unverified/open. Native computer use is still unavailable.

## Preferences and conditions follow-up (2026-10-24; uncommitted)

- Owner requested three independent child options under Compound layout tools: Arrangement Arrows,
  Offshoot Arrows and Formatted Reaction Conditions. All start off, require the parent, persist
  independently and update the main window/native palettes live. Parent-off retains child choices.
  Arrangement Arrows combines layout, arrows and spacing in Arrange with options, hiding the
  duplicate Adjust spacing menu entry. Both command IDs open the same retained draft. Preview and
  Save share an atomic layout-then-spacing operation with one Undo. Base layouts and standalone
  Adjust spacing need only the parent. Combined spacing is 25–150% of the chosen layout; invalid
  overlap/page values disable Save and discard the whole intermediate arrangement.
  Disabled authoring commands are hidden and refuse direct calls; stale dialog Saves are guarded.
  Saved arrows/labels keep rendering, attachments and exports regardless of preference state.
- Owner confirmed curve-relative positioning: Top / inside stays inside a curve as it rotates;
  Bottom / outside stays outside. Straight shafts use page top/bottom independent of LTR/RTL
  (left/right for exactly vertical shafts). Old above/outside wording is superseded. Manual
  positions remain until the user switches sides. Existing serialization side values are retained.
- Source stamp is now `10.24.11.35-codex`. No new packaged native launch; computer-use startup
  still fails. Run `./run-app` once from VS Code for the next owner preview; do not repeat per edit.
- The three existing commits remain unchanged. This follow-up is uncommitted on
  `codex/reaction-arrows`, alongside all preserved earlier edits. Nothing staged, pushed or merged.
- Focused validation currently passes 466 distinct tests across 28 suites: preference persistence,
  all eight feature combinations, live command/menu gating, DOM pointer editing, drawing tools,
  agent bridge/hit tests, native-dialog cancellation, arrangement workflows, nested arrows,
  conditions and SVG/PDF export. The unified-window addition reran 160 relevant tests; two initial
  test expectations needed updating for the merged menu and an open cycle's three connections,
  and the corrected checks pass. Final `pnpm lint`, `git diff --check` and
  `pnpm --filter @chemdraft/desktop build:web` passed. Web output is `apps/desktop/dist/`;
  the build reports dependency annotation and large-chunk warnings. No Rust/protocol changes.
  Full CI, native macOS visual/focus checks and native Windows remain open.

## Latest stress continuation (2026-10-24)

- [Stress results and exact commands](reaction-arrows-stress-results.md): 216 distinct automated
  tests passed across 14 suites, including nine new cases from one independent agent; TypeScript
  and whitespace checks passed. No new reproducible product bug or production edit.
- Retained audit: `tools/reaction-arrows/adversarialReactionArrows.test.ts`. Focused test commands
  ran inside the sandbox. A blocked process-status diagnostic was rerun only after approval for
  the exact command; no rejection was bypassed.
- Native computer-use startup still fails, including after resuming. No launch/rebuild attempted.
  Running-build registry reported old `10.23.09.35-codex`, not current source `10.23.14.28-codex`;
  do not treat it as current native verification. macOS hands-on and native Windows remain open.
- Branch remains `codex/reaction-arrows`. Existing uncommitted work is preserved, with added audit
  and results plus documentation links. Nothing staged, committed, pushed or merged. Use the report
  for remaining checklist items; a new thread is useful when native UI/Windows access is available.

## Current continuation (2026-10-23; supersedes the historical checkpoint below)

- Worktree: `/Users/emily/ChemDraft Repository/ChemDraft`, branch `codex/reaction-arrows`.
  Current remote `main` was checked and is an ancestor of this branch (zero commits behind).
- The feature is now split into three commits: `0d9cc73` arrangement arrows,
  `599b3fc` offshoot arrows, and `b238564` reaction conditions. Do not repeat the split.
  Nothing was pushed or merged.
- Preserve the remaining uncommitted work: modified `AGENTS.md` and `PLANS.md`, plus this
  untracked handoff. Check branch and status before any staging or commit.
- The final macOS packaged build succeeded from this branch. Its source stamp is
  `10.23.14.28-codex`; the user previews it from VS Code with `./run-app`. Do not relaunch for
  every edit. The stable app is separate. A dev app was observed running, but its loaded stamp
  was not read in this follow-up.
- First and second commit candidates passed focused tests and full macOS builds. The final branch
  passed TypeScript, Rust formatting/Clippy, 364 native tests (two ignored), a packaged macOS build,
  and focused layout, CLI, arrow, dialog, and export tests. A broad parallel JavaScript run in a
  disposable checkout had CLI setup failures and timeout noise; it was stopped. The normal checkout's
  CLI and affected focused suites passed afterward. Do not claim a clean full JS gauntlet.
- On the final branch, a further automated checklist pass passed 580 tests: 260 reaction-arrow,
  arrangement, conditions, dialog and editing tests; 284 geometry/export tests; and 36 desktop
  interaction stress tests. Simulated macOS/Windows branches passed in DOM tests. Native Windows
  execution and the full hands-on checklist remain unverified.
- One independent read-only agent found a repeated formatted-text edit bug; it was fixed in the
  third commit with DOM regressions. Its later wild-case code review found no new confirmed bug.
  Its own `pnpm` stress suite was blocked twice by the sandbox and then automatic approval review,
  which returned `Rejected("rejected by user")` without a reason. The current chat still reports
  `auto_review` even after the user selected Ask for approval; a fresh chat with that setting may
  be needed to surface a manual prompt. Do not bypass the rejection or claim independent test pass.
- Packaged-app GUI stress was also blocked: macOS denied `osascript` assistive access, and the
  computer-control runtime failed before initialization while opening the system OpenSSL config.
  The user permits one independent packaged-app milestone pass, but not launches after every edit.
- Next task: in a fresh Ask-for-approval chat, ask an independent agent to run bounded adversarial
  tests, then complete the native macOS/Windows hands-on items in the manual stress checklist when
  UI access and a Windows host are available. Do not push or merge without further instruction.

## Historical checkpoint (superseded by the current continuation above)

Current checkpoint: 2026-10-23. Read AGENTS.md §2.1 for the user's usage-conscious workflow.

- Checkout: `/Users/emily/ChemDraft Repository/ChemDraft`, branch `codex/reaction-arrows`.
- Base: `2dec5d8`. Feature work is still uncommitted, including untracked source/tests. Preserve it;
  inspect git status before edits. Nothing has been pushed or merged by this task.
- Latest owner-run preview: packaged worktree app via `./run-app`. The owner confirmed the third
  Shift-frame control works and that the centered controls and softer mixed-resize weight look good.
  This thread did not read its build stamp. The older `10.23.09.35-codex` dev stamp is historical,
  not the current packaged preview. Stable app remains separate and untouched.
- Implemented: optional arrangement connections, spacing/rerouting, reopening/removal, arrow-length
  slider; editable half/full offshoots; formatted reaction conditions with native editor.
- Latest fix: full curved offshoots have a third green handle beside the Shift-held rotation controls.
  Drag it to adjust both ends equally around the fixed tether, even when the existing endpoint
  handles are hidden by the Shift transform frame. The owner confirmed the drag works in the
  packaged native preview and liked the subsequent centering of all three controls.
  Existing menu choices are unchanged.
- Latest validation for this fix: root TypeScript and 86 tests across the pointer-editing and tether
  suites passed. No new packaged build or native preview launch. Earlier broader runs are recorded
  in PLANS.md; do not represent them as rerun against this edit.
- New mixed-resize follow-up: arrow shafts and heads grow more gently when molecules and arrows are
  scaled together (square root of the usual visual-weight factor); arrow-only resize remains unchanged.
  The focused mixed/arrow-only resize tests and root TypeScript check passed; the owner confirmed
  the packaged preview looks good. The agent did not launch it.
- Git status/branch cannot currently be checked from this agent host: `/usr/bin/git` reports a
  missing macOS Command Line Tools developer path. Preserve every existing edit and untracked file;
  have the next thread inspect status/branch before staging. No commit, push, or merge was made here.
- Windows execution and native hands-on confirmation remain outstanding. Computer-use service
  previously failed to start. Do not claim a platform verified without running it.
- User explicitly deferred the unlikely 66-level nested-offshoot resolver limit; leave documented.
- Owner plans a fresh thread to split this uncommitted feature into three commits: arrangement
  arrows, offshoot arrows, reaction conditions. The split has NOT been performed. Preserve the final
  behavior and make each commit independently buildable/tested; shared code may require careful
  staging. A clean full CI run, native macOS/Windows hands-on checks and Windows execution remain
  merge gates, not prerequisites for starting the split. The 66-level nested-offshoot limit remains
  explicitly deferred. Use one implementation agent and run heavy checks serially.

Suggested fresh-thread prompt: “Continue ChemDraft from docs/reaction-arrows-handoff.md. Follow
AGENTS.md §2.1. Preserve all uncommitted work. Split the reaction-arrow feature into three
independently buildable/tested commits: arrangement arrows, offshoot arrows, reaction conditions.
Check branch/status before staging; do not merge or push.”

## Preview preference: VS Code integrated terminal

The user wants to launch previews themselves from **VS Code → Terminal → New Terminal**.
Provide these commands rather than automatically launching a development server:

```sh
cd "/Users/emily/ChemDraft Repository/ChemDraft"
./run-app
```

This builds and opens the packaged worktree app, `ChemDraft (dev)`, separate from the stable app.
It uses Tauri and a Vite production build internally, but does not run the Vite development server.
It can take several minutes. Save open work before launching: the helper stops older instances
from this checkout. Check the worktree label and build stamp after launch.

To report the loaded build:

```sh
pnpm running-build
```

Do not run `./run-app --dev` or `pnpm dev` unless the user explicitly requests live-reload mode.
The previous dev launch noted above is historical, not the preferred preview workflow now.
The owner ran a packaged preview and confirmed the latest visual changes. The agent did not launch
it or inspect its build stamp. Do not represent that confirmation as Windows verification.
