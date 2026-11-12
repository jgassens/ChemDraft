# A1–A6 MainWindow regression review

Reviewed `432934a5..ac9c105ea` in the isolated regression worktree. Build stamp:
`11.11.04.00-codex`. Changes are left uncommitted for the coordinating agent.

## Bisect results

Each boundary below was exercised in detached scratch checkouts, with dependencies relinked using
the owner-supplied script. Because the sandbox cannot write the original repository's worktree
registry, the detached worktrees belonged to a scratch shared clone. The release baseline's full
App/tabs run passed all 473 tests. No install or Cargo command was run.

Historical and final test commands used explicit paths, `--maxWorkers=1 --testTimeout=30000`,
`--configLoader runner --no-cache`, and an outer `gtimeout` of 60–600 seconds. The config-loader
flags avoid writing Vite's temporary config through the shared, read-only root node_modules link.
The good/bad columns refer to the original assertions, before the fixes below.

| Test / cases | Last good → first bad | Cause | Fix and reason |
| --- | --- | --- | --- |
| App: associates analysis windows with the main document | `8cb79cab7` → `8a6121213` | A5b selects the registered document owner rather than hard-coding `main`. | **Test:** check the panel builder's `parent(&owner)` and AppKit owner lookup; retain the normal-level/never-floating checks. This is the intended owner-aware design, including the original main window. |
| App: opens analysis windows without focus and lends focus only to editable controls | `8cb79cab7` → `8a6121213` | A5b adds an optional owning-document suffix to the panel title. Native focus flags did not regress. | **Test:** assert the optional suffix and `focus: false`, retaining every original native focus check. A single window keeps the original title. |
| Tabs: stable UUID tab ids and composite plugin keys | `8525b5758` → `67718be03` | A5a removes the owner's active-document callback. Captured document ports use a stable drawing incarnation, separately from activation-sensitive UI revisions. | **Test:** read the real port; check window/tab UUIDs, distinct drawing keys, stability across activation, removal on close and invalidation on replacement. The old callback no longer exists in the host. |
| Tabs: refuses a plugin write captured before a switch, switch-back false / true | `8525b5758` → `67718be03` | A5a deliberately addresses writes to the captured drawing, including its inactive history. A switch alone no longer retires that drawing. | **Test:** require the write to reach its source, preserve the active neighbour and undo exactly. Add two separate refusal cases for closed/replaced drawings. This follows the explicit stable-incarnation/inactive-write contract in `runtime-broker.md`, rather than restoring active-tab routing. |
| Tabs: tab x leaves a closed document's proposal pending and refuses Accept, multiple false | `3f78650c2` → `57ee07c13` | Direct local core dispatch exposes an asynchronous close/title publication race. The host retains the final title after the document view already published “Unavailable document”; retaining it emits no queue-change callback. | **Code:** after retaining the closed tab title, publish the view and notify that document's proposal queue. Original assertions remain unchanged, including pending status and refused Accept. The multiple-true case is also retained and passes. |
| Tabs: uses Save As title for proposal labels and Accept refusal, multiple false / true | `3f78650c2` → `57ee07c13` | Same close/title race, including the last renamed title. | **Code:** the same owner-scoped view/queue notification. Original title, refusal and pending-proposal assertions remain unchanged. |
| Tabs: New tab is keyboard-focusable and invokes File New exactly once | `8cb79cab7` → `8a6121213` | A5b changes core dispatch through the document adapter; the assertion observes the host's invocation method. | **Test:** observe the actual document command registry and its invocation context. Retain focus, exactly-once invocation, active tab and clean blank-drawing checks. |
| Tabs: dirty tab x uses the close command, Cancel retains it and Discard selects its neighbour | `8cb79cab7` → `8a6121213` | The same obsolete host invocation spy. | **Test:** observe the document's value-encoded close command exactly once; retain the real prompt, Cancel, Discard and neighbour assertions. |
| Tabs: creates one runtime across switches, with active callbacks and agent snapshot | `8525b5758` → `67718be03` | The sole owner no longer reads an active drawing through callbacks inside MainWindow. | **Test:** check the real document port and agent snapshot while retaining the one-runtime construction assertion in the explicit local embedding. Production hidden-host startup is also tested separately. |
| Page enlargement: retains a reviewed proposal if the drawing changes during the page question, macOS / Windows | `8525b5758` → `67718be03` | The fixture calls `runtime.host.proposePatch` without an invocation target. A hidden host has no active drawing from which to infer one. | **Test fixture:** propose through a registered command and its captured document context. Keep the stale-answer refusal and pending-proposal assertions; explicitly require the page question to have opened. |
| Overlays: real typing after Finish setup / New conversation / Stop, then Escape | `8cb79cab7` → `8a6121213` | The positive control observes drawing shortcuts in the host registry, although they now belong to the document registry. | **Test:** spy on the real document registry. All real typing, focus restoration, no-shortcut-while-typing and positive drawing-shortcut assertions remain. |
| Wavy lines: routes an app command and restores exact Undo/Redo states, macOS / Windows | `8525b5758` → `67718be03` | The broker enters the document registry with an invocation context; the old spy expects a one-argument call. | **Test:** assert command plus context; retain exact object-state Undo/Redo comparisons. |
| Wavy lines: real slider drag ending in release, macOS / Windows | `8525b5758` → `67718be03` | Same additional invocation context. | **Test:** compare invoked command IDs and still require exactly one release commit. Keep preview, cancellation and Undo/Redo checks. |
| Preview transport: DOM preview, commit and cancel callbacks | `a3b0e2238` → `01148f96a` | The A3 follow-up delivers the captured target as the callback's second argument. | **Test:** require exactly one delivery of both command and current captured target for each callback. This strengthens the intended addressed-transport contract. |
| Tabs traversal / apparent quit hang | No core snapshot publisher at `8525b5758`; introduced by `67718be03` | Every core register/unregister synchronously serializes and sends the entire growing command set, on repeated MainWindow registrar passes. A 500-command reproducer sends **501** snapshots. | **Code:** coalesce synchronous changes into one microtask publication and cancel it on disposal. The same reproducer sends two snapshots (initial plus final). Add a two-second startup deadline and five-second captured-command/quit-flush deadlines. |

These rows account for all 21 failing cases found at HEAD across the requested files. The release
and A4 historical full runs also distinguish an intermediate source-count assertion: A3's
`01148f96a` adds a normalizer call (15 rather than the asserted 14), and A5a's moved commit seam
removes it again. That historical-only failure is absent at HEAD and required no current change.

The A5a write contract intentionally differs from activation-sensitive UI snapshot identity.
`runtime-broker.md` explicitly requires drawing keys to survive activation and inactive writes to
update their own history, selection and dirty state. The new closed/replaced-drawing tests preserve
the important stale-result refusal coverage; no assertion allows an old result into a new drawing.

## Hang diagnosis and verification

The isolated four “already-running paste” quit cases settle at A5a, including list identity. The
unmodified full runs instead make slow progress: individual mounts take roughly 4–10 seconds,
and hard-timeout runs stop at different earlier tests. The reproducible cause is the command
snapshot publication amplification, rather than an unfulfilled paste/session promise. Its regression
test fails at the introducing commit with 501 snapshots and passes after batching with two.

The final App/tabs run completes and exits normally in **51.16 seconds**: 483 passed. The quit
session-flush and captured-command assertions now fail within five seconds if their awaited work
does not settle. The command-publication test independently bounds startup and checks that disposal
prevents a queued update from escaping. Fake-timer launch/recovery and both shortcut platforms
remain covered by the full tab file.

## Final verification

All 40 requested files pass: **1,845 passed, zero failed, one pre-existing skip**. Three adjacent
runtime files add **21 passed** tests. Counts below use the final successful run of each file, without
double-counting retries or historical runs. Paths are relative to `apps/desktop/src/`.

| File | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| App.test.ts | 230 | 0 | 0 |
| MainWindow.arrowNudge.dom.test.tsx | 64 | 0 | 0 |
| MainWindow.assistantTransaction.dom.test.ts | 5 | 0 | 0 |
| MainWindow.canvasFocus.dom.test.tsx | 82 | 0 | 0 |
| MainWindow.copyAsSmiles.dom.test.ts | 12 | 0 | 0 |
| MainWindow.dragPerf.dom.test.ts | 12 | 0 | 0 |
| MainWindow.dragTransform.dom.test.ts | 32 | 0 | 1 |
| MainWindow.editorSaveKeys.dom.test.tsx | 24 | 0 | 0 |
| MainWindow.hoverLabelChemistry.dom.test.tsx | 44 | 0 | 0 |
| MainWindow.hoverLabelEscape.dom.test.tsx | 10 | 0 | 0 |
| MainWindow.hoverRehit.dom.test.tsx | 256 | 0 | 0 |
| MainWindow.nativeFlyout.dom.test.tsx | 10 | 0 | 0 |
| MainWindow.nativeStylePresets.dom.test.tsx | 14 | 0 | 0 |
| MainWindow.openStereo.dom.test.tsx | 10 | 0 | 0 |
| MainWindow.pageEnlargement.dom.test.tsx | 88 | 0 | 0 |
| MainWindow.paletteColorDelivery.dom.test.tsx | 8 | 0 | 0 |
| MainWindow.palettePreview.dom.test.tsx | 36 | 0 | 0 |
| MainWindow.panelShortcuts.dom.test.tsx | 6 | 0 | 0 |
| MainWindow.plugins.dom.test.ts | 9 | 0 | 0 |
| MainWindow.plugins.dom.test.tsx | 113 | 0 | 0 |
| MainWindow.popoverEscape.dom.test.tsx | 20 | 0 | 0 |
| MainWindow.saveMidEdit.dom.test.tsx | 126 | 0 | 0 |
| MainWindow.smilesPaste.dom.test.ts | 38 | 0 | 0 |
| MainWindow.tabs.dom.test.tsx | 253 | 0 | 0 |
| MainWindow.templateInsert.dom.test.tsx | 6 | 0 | 0 |
| MainWindow.templatePaste.dom.test.tsx | 18 | 0 | 0 |
| MainWindow.textCommit.dom.test.tsx | 28 | 0 | 0 |
| MainWindow.textPasteFormatting.dom.test.tsx | 106 | 0 | 0 |
| MainWindow.textToolEscape.dom.test.tsx | 20 | 0 | 0 |
| MainWindow.validateSelection.dom.test.ts | 1 | 0 | 0 |
| MainWindow.wavyBond.dom.test.tsx | 3 | 0 | 0 |
| MainWindow.wavyLines.dom.test.tsx | 36 | 0 | 0 |
| window-manager/palette-sizing.dom.test.ts | 7 | 0 | 0 |
| window-manager/palette-target.dom.test.ts | 8 | 0 | 0 |
| window-manager/popover-dismiss.dom.test.ts | 15 | 0 | 0 |
| window-manager/popoverEscape.visibility.dom.test.ts | 32 | 0 | 0 |
| window-manager/preview-transport.dom.test.ts | 19 | 0 | 0 |
| window-manager/quit-flush.dom.test.ts | 9 | 0 | 0 |
| window-manager/tauriEvents.test.ts | 17 | 0 | 0 |
| window-manager/window-drag.dom.test.ts | 18 | 0 | 0 |
| plugins/runtimeAsyncView.test.ts | 2 | 0 | 0 |
| plugins/runtimeHostStartup.dom.test.tsx | 4 | 0 | 0 |
| plugins/runtimeProposalForwarding.dom.test.ts | 15 | 0 | 0 |

Final desktop TypeScript and whitespace checks are recorded in the worker's JSON handoff. Existing
React act/localStorage warnings remain non-failing. No Rust or public plugin API changed.

macOS Apple silicon, macOS Intel and Windows packaged behavior remains **unverified natively**.
No Cargo, native build, application launch or installer was run, per the task's coordinator-owned
native verification boundary. Recommended next task: run the native gauntlet and packaged
single-window checks on both OSes (proposal close/Save As labels, focus, shortcuts, delayed writes,
session/quit), then continue the separately planned multi-window slices. All detached scratch
worktrees are removed before handoff.
