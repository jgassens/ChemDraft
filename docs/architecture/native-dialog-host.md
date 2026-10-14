# Native dialog host (stage 1)

`page.setSizeCustom` opens a modeless, movable, document-owned native window on macOS and Windows.
The title and form identify the originating drawing. Drawing and floating toolbars remain usable.
Apply targets that tab, including when inactive, and records **Set Custom Page Size** once in its
own history. Closing the originating tab dismisses its dialog. Browser builds retain the in-page
surface as a browser limitation, with the same `PageSizeForm` and validation. Native creation
failure reports an error in the document status; it never creates an in-page desktop fallback.

## Authority and files

- `apps/desktop/src/dialogs/DialogCoordinator.ts`: one coordinator owned by MainWindow; subscriptions,
  startup deadlines, receipts, originating-tab callbacks, and exactly-once settlement.
- `dialogProtocol.ts`: internal version 1 request/snapshot/ready/action/result/closed contract and
  runtime validators; no callbacks or unrestricted command strings. Both platform policies can be
  exercised on one host by passing `platform`.
- `dialogTransport.ts`: narrow IPC adapter; both owner and host subscribe before creation/bootstrap.
- `DialogWindow.tsx` and `PageSizeForm.tsx`: snapshot rendering and local form drafts only.
- `App.tsx`: dialog routing precedes other routes. All window components are lazy imports, so the
  dialog entry does not initialize MainWindow, chemistry engines, or the plugin runtime.
- `src-tauri/src/dialog_windows.rs`: registration, validation, native construction/reveal/ownership,
  close/destroy hooks, bounded sessions, and position persistence.
- `src-tauri/capabilities/dialog-host.json` / `dialog-owner.json`: host receive/send only versus
  main-only create/publish/close. Existing filesystem/dialog/capture/engine grants are unchanged.

## Transport and lifecycle

Every message has `protocolVersion`, `ownerWindowId`, `documentTabId`, `dialogKind`, `sessionId`,
`requestId`, and `snapshotRevision`. Payloads are limited to 16 KiB; dimensions must be finite,
positive, at most 100000, in `inch`, `mm`, or `css-px`. Unknown kinds, fields, owners, stale sessions,
and wrong callers fail closed. Bootstrap uses only the opaque `hostId`, protocol version, and a
request ID; Rust derives its envelope from the actual registered calling window. Nothing about a
drawing or its file path appears in `/?window=dialog&hostId=…`.

Rust assigns `dialog-main-pageSize-<slot>` and supplies the actual sender label on deliveries.
The child cannot emit arbitrary events or create windows. Rust retains the snapshot for replay;
after React commits the form it sends ready without waiting for animation frames. The owner
retains request receipts; Rust reserves in-flight IDs and replays completed receipts rather than
delivering another mutation. A startup missing ready fails after 10 seconds with no automatic retry.
An action missing its matching receipt reports an error after 10 seconds and leaves Apply disabled
until the receipt arrives; Cancel stays available and the operation is never retried automatically.

Construction is async on a worker, serialized through `lock_window_creation()`, and refused after
quit begins. Builds are hidden, `focused(false)`, focusable, decorated, shadowed, and skip the
taskbar. Windows uses a top-level document owner. macOS attaches a normal-level, focusable child
only at reveal and after utility restoration, never a sheet or nonactivating panel. No menu is
attached. Native close/destroy is authoritative; the document's macOS hide-on-Close hook also
dismisses dialogs. Quit dismisses registered sessions before asking for the final document flush.
Late construction after owner close is discarded.

Dialogs participate in `UTILITY_SUSPENSION` alongside panels and toolbars, using the existing #140
relative stacking restore. A native message/file box hides them and restores only still-live
sessions. Opening Page Size acquires no suspension. Dialog moves never update toolbar frames or
logical toolbar visibility. First placement centres on the owner's usable frame and clamps to the
monitor work area, using the destination monitor's scale. `dialog-positions.json` remembers logical
position, monitor identity and normalized work-area offsets per kind. Removed monitors recover
onto the owner's monitor. Genuine moves are debounced; hidden/minimized/initial/restoration/quit
moves are excluded. Warm snapshot replay does not replace a draft or recentre a moved window.

Escape, title-bar close and Cmd/Ctrl+W cancel. Valid Enter in a field applies; composition Enter does
not. The first field focuses on mount, and dialog Undo/Redo stays local to text fields.

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
