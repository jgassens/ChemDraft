# Native dialog host (stage 1)

`page.setSizeCustom` opens a modeless, movable, document-owned native window on macOS and Windows.
The title and form identify the originating drawing. Drawing and floating toolbars remain usable.
Apply targets that tab, including when inactive, and records **Set Custom Page Size** once in its
own history. Closing the originating tab or replacing its document dismisses its dialog, including
when a pristine tab is reused for an opened file. Choosing Custom Page Size again shows and focuses
the retained native window without replacing the draft or moving it. Browser builds retain the in-page
surface as a browser limitation, with the same `PageSizeForm` and validation. Native creation
failure reports an error in the document status; it never creates an in-page desktop fallback.

## Authority and files

- `apps/desktop/src/dialogs/DialogCoordinator.ts`: one coordinator owned by MainWindow; subscriptions,
  startup deadlines, receipts, originating-tab callbacks, and exactly-once settlement.
- `dialogProtocol.ts`: internal version 1 request/snapshot/ready/action/result/closed contract and
  runtime validators; no callbacks or unrestricted command strings. Transport policy is shared;
  only the form's keyboard behavior takes a platform parameter.
- `dialogTransport.ts`: narrow IPC channel adapter; both owner and host install their channel
  callbacks before invoking creation/bootstrap. No dialog protocol event-bus subscriptions exist.
- `DialogWindow.tsx` and `PageSizeForm.tsx`: snapshot rendering and local form drafts only.
- `App.tsx`: dialog routing precedes other routes. All window components are lazy imports, so the
  dialog entry does not initialize MainWindow, chemistry engines, or the plugin runtime.
- `src-tauri/src/dialog_windows.rs`: registration, validation, native construction/reveal/ownership,
  close/destroy hooks, bounded sessions, and position persistence.
- `src-tauri/capabilities/dialog-host.json` / `dialog-owner.json`: host receive/send only versus
  main-only create/publish/close. Existing filesystem/dialog/capture/engine grants are unchanged.

## Transport and lifecycle

Every message has `protocolVersion`, `ownerWindowId`, `documentTabId`, `dialogKind`, `sessionId`,
`requestId`, and `snapshotRevision`. Incoming payloads are limited to 16 KiB. Every owner and dialog
channel delivery is limited to 4096 bytes of final serialized JSON, including the delivery envelope
and escape expansion. This keeps deliveries below Tauri 2.11.2's 8192-byte direct-delivery threshold:
larger JSON enters an app-wide fetch queue that does not authenticate the requesting webview.
Oversized error text is replaced with a fixed bounded failure message; any other oversized delivery
is rejected, and the complete delivery is measured again after replacement. Dimensions must be finite,
positive, at most 100000, in `inch`, `mm`, or `css-px`. Unknown kinds, fields, owners, stale sessions,
and wrong callers fail closed. Bootstrap uses only the opaque `hostId`, protocol version, and a
request ID; Rust derives its envelope from the actual registered calling window. Nothing about a
drawing or its file path appears in `/?window=dialog&hostId=…`.

Rust assigns `dialog-main-pageSize-<slot>`. Main supplies a Tauri `Channel` to `dialog_open`, and
the dialog supplies its own channel to `dialog_request`. Rust stores these channels in the session
only after checking the actual invoking native window. Actions, ready, bootstrap requests and
native closed notifications reach main only through its channel; snapshots and results reach the
dialog only through its channel. Generic events, even with an observed session and forged matching
sender labels, reach neither receiver. Sender fields are envelope consistency checks, not
authentication. No non-dialog capability receives additional rights; the dialog's former event
listen/unlisten grants are removed. The child cannot emit arbitrary events or create windows.
Rust retains the snapshot for replay;
after React commits the form it sends ready without waiting for animation frames. The owner
retains request receipts; both Rust and the coordinator reserve a session-wide terminal action
before forwarding/invoking it. Distinct Apply IDs cannot cause another mutation while the operation
or success receipt is pending. An operation error releases the reservation for an explicit retry;
successful receipts keep Apply disabled until native destruction. Duplicate IDs replay completed
receipts without another mutation. Pending openings are registered before the first await, so
tab close, document replacement and dispose cancel even a subscription still in flight.
A startup missing ready fails after 10 seconds with no automatic retry.
An action missing its matching receipt reports an error after 10 seconds and leaves Apply disabled
until a failure receipt arrives or the user closes the native title bar; the operation is never
retried automatically. While a terminal action is pending, another form action is ignored.

Construction is async on a worker, serialized through `lock_window_creation()`, and refused after
quit begins. Builds are hidden, `focused(false)`, focusable, decorated, shadowed, and skip the
taskbar. Dialogs are non-minimizable on both platforms; reopening also unminimizes before showing
and focusing as a fallback, preserving the draft and position. Windows uses a top-level document
owner. macOS attaches a normal-level, focusable child
only at reveal and after utility restoration, never a sheet or nonactivating panel. No menu is
attached. Native close/destroy is authoritative; the document's macOS hide-on-Close hook also
dismisses dialogs. Quit dismisses registered sessions before asking for the final document flush.
Late construction after owner close is discarded.

Dialogs participate in `UTILITY_SUSPENSION` alongside panels and toolbars, using the existing #140
relative stacking restore. A native message/file box hides them and restores only still-live
sessions. Opening Page Size acquires no suspension. Dialog moves never update toolbar frames or
logical toolbar visibility. First placement centres on the owner's usable frame and clamps to the
monitor work area, using the destination monitor's scale. Placement first moves to that monitor,
then sets client size at its DPI, measures the resulting outer frame and clamps that actual frame.
This avoids Windows WM_DPICHANGED scaling an already destination-sized client twice.
`dialog-positions.json` remembers logical
position, monitor identity and normalized work-area offsets per kind. Removed monitors recover
onto the owner's monitor. Genuine moves are debounced; hidden/minimized/initial/restoration/quit
moves are excluded. One bounded-notification worker debounces movement bursts, takes pending
positions under the registry lock, then reads/writes outside that lock. Final close flushes share
an IO mutex with the worker so an older worker snapshot cannot overwrite the final position.
Warm snapshot replay does not replace a draft or recentre a moved window.

Escape, title-bar close and Cmd/Ctrl+W cancel. Valid Enter in a field applies; composition Enter does
not. The first field focuses on mount, and dialog Undo/Redo stays local to text fields. macOS
Cmd+A and the native Edit > Select All route to the focused dialog field; with no field focused
they do not change document selection.

## Adding a later kind

Add a discriminated payload/action adapter and validators in TypeScript and Rust, a lazy trusted
body, and an owner callback in the coordinator. Extend Rust's kind/label allowlist and narrow
capability window matcher; URLs remain host IDs. Keep files, history, settings and plugin operations
in MainWindow. Add contract, lifecycle, originating-context and both-platform manual tests.

Export, plugin prompts, report readers, plugin manager, toolbar customization and colour editors
are deliberately unimplemented. Modal plugin prompts need an explicit document input lease at the
coordinator seam, including all command/pointer/menu/clipboard paths and dependent prompt stacking;
Page Size has no such lease. Other kinds will need their own busy/progress contracts,
snapshot revisions and cancellation semantics before they can use the host.

## Handoff verification

Run `pnpm lint`, `pnpm vitest run apps/desktop`, Rust fmt/clippy/tests, the web build and the Windows
menu churn smoke. In a sandbox with read-only dependency symlinks, Vitest/Vite may require
`--configLoader native`; a Sparkle framework symlink may require a command-local `TAURI_CONFIG`
override pointing `bundle.macOS.frameworks` at the read-only source directory. These affect only
test/build invocation. Hands-on verification remains the standing checklist's native Page Size
section on **both** platforms; unit tests do not verify real ownership, taskbar, focus or display DPI.

Stage 1 worker handoff: the desktop suite collected MainWindow's DOM tests and passed 194 files
(3622 tests, two existing skips), with native config loading, two workers, and a temporary config
mapping RDKit's exact imports to this worktree to avoid duplicate modules through read-only
dependency symlinks. Root lint and the Vite web build passed. macOS Rust fmt/clippy passed; the full
Rust test run's only failure was the existing OCSR download test's sandbox-denied loopback bind
(`ocsr_engine::install::tests::system_download_verifies_pinned_bytes_and_rejects_tampering`).
`./run-app --dev` printed `dialog-host-stage1 [agentctl/dialog-stage1-20261014/dialog-host-stage1]`
but failed before launch because Vite could not write its config cache through the read-only
node_modules symlink. Real macOS interaction and Windows build/interaction remain unverified.
Windows menu churn smoke skipped on this macOS host. The next task is to run the standing native
Page Size checklist on both platforms before integration. `CURRENT_BUILD_STAMP` is unchanged for
the orchestrator to handle during integration.

## Review hardening handoff

| Finding | Closure | Regression coverage |
| --- | --- | --- |
| Forged owner actions/closed and dialog snapshots/results | Per-session Rust-written owner and host IPC channels; no protocol event listeners; no new capability grants | `dialogTransport.test.ts` injects forged event payloads with the observed session and exact sender fields, then verifies only channel deliveries reach the callbacks |
| Double Apply | Session-wide terminal reservations in Rust and the coordinator; synchronous renderer guard; success keeps Apply disabled through destruction; operation failure permits an explicit retry | `DialogCoordinator.test.ts`, `DialogWindow.dom.test.tsx`, Rust `terminal_action_is_reserved_across_distinct_request_ids` |
| Opening versus tab close | Register pending sessions before subscription awaits; cancellation prevents creation or closes a late build | Coordinator deferred-subscription and late-creation tests |
| Reused tab ID | Settle the originating session before installing a replacement document history | `MainWindow.tabs.dom.test.tsx` replaces pristine Untitled, injects late Apply/closed deliveries, and verifies a fresh session works on the replacement |
| Mixed-DPI sizing | Move, destination client resize, measure actual outer frame, clamp | Rust `placement_moves_before_destination_resize_and_clamps_the_measured_outer_frame` simulates WM_DPICHANGED and title-bar/border dimensions |
| Reopen | Reinvoke open with the retained snapshot; Rust shows/configures/focuses the same ready window without placement | Coordinator retained-snapshot reopen test |
| Move persistence | One bounded-notification worker; coalesced burst; latest move across tabs wins; registry snapshot before off-lock IO; close flush serialized against worker writes | Rust `persistence_worker_coalesces_a_burst_and_writes_after_registry_unlock` exercises 1000 moves and asserts the write callback can acquire the registry lock; `a_coalesced_kind_remembers_the_latest_move_across_tabs` covers multiple dialogs |
| macOS Select All | Native and web Edit menus register the existing command; native routing follows the key window; shared field selection keeps dialog edits local with no document forwarding | Rust `select_all_targets_the_focused_dialog_without_touching_document_selection`, `appMenu.test.ts`, `editMenuUndo.dom.test.ts` and dialog DOM keyboard/menu tests |

Coordinator/protocol tests no longer carry a platform parameter: their policy has no platform branch.
Form shortcut tests still exercise macOS and Windows modifier differences. For Windows hands-on
verification, follow the detailed 100% ↔ 150%/200% placement, work-area-edge, negative-coordinate,
rapid-drag, immediate-close, monitor-removal and restore checks in the standing
[`manual-stress-checklist.md`](../manual-stress-checklist.md#native-custom-page-size-macos-and-windows).
Native ownership/taskbar/focus/DPI behavior remains unverified on Windows and real macOS windows;
automated macOS native tests are not a hands-on pass. `CURRENT_BUILD_STAMP` remains unchanged.

Validation in this isolated worktree: root lint passed; the full desktop suite passed 196 files,
3676 tests with two existing skips, using `--configLoader runner --maxWorkers 2` and a temporary
config mapping RDKit's exact public imports to this worktree. Dependency setup used symlinks only,
including the example plugin's existing dependencies; no install or dependency change was made.
All nine targeted TypeScript regressions failed against the original implementation at `289f29d6`
and passed with the fixes. Four Rust regression probes also failed when the reviewed pre-fix
behaviors were reintroduced (request-only reservation, resize-before-move, IO under the registry
lock, and Select All routed to main); the fixed sources were restored afterwards.
macOS Rust fmt and all-target clippy with `-D warnings` passed, with command-local Sparkle paths
and an offline scratch target. The full Rust suite's only failure is the existing OCSR test
`ocsr_engine::install::tests::system_download_verifies_pinned_bytes_and_rejects_tampering`:
the sandbox denies its loopback socket bind (`Operation not permitted`). Rerun that suite outside
the sandbox. With just that test explicitly excluded, the remaining 291 native tests passed with
two existing ignores, and binary/doc-test targets passed. The Windows menu churn smoke skipped on
this macOS host. The temporary framework link and scratch Cargo target were removed after checks.
Windows native build/tests and both platforms' hands-on checks remain required.
Recommended next task: perform those native checks before integration, especially Windows mixed DPI.
