# Native dialog host

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
- `DialogWindow.tsx`, `PageSizeForm.tsx`, and `ExportForm.tsx`: trusted snapshot rendering and local
  form drafts only. Export options have a strict shared TypeScript/Rust shape.
- `EngineInstallForm.tsx`: data-only local-engine installation disclosure and progress. It has no
  engine, filesystem, plugin-runtime or document capability.
- `App.tsx`: dialog routing precedes other routes. All window components are lazy imports, so the
  dialog entry does not initialize MainWindow, chemistry engines, or the plugin runtime.
- `src-tauri/src/dialog_windows.rs`: registration, validation, native construction/reveal/ownership,
  close/destroy hooks, bounded sessions, and position persistence.
- `src-tauri/capabilities/dialog-host.json` / `dialog-owner.json`: host receive/send only versus
  main-only create/publish/close. Existing filesystem/dialog/capture/engine grants are unchanged.


## Local engine installation

The generic `engineInstall` kind uses the same modeless native construction, owner, floating
level, focus policy, session limits and per-kind position persistence as the existing dialogs.
Its label is `dialog-main-engineInstall-<slot>`. The existing opaque-host route in App needs no
new query parameters. Dialog capabilities add only this label pattern; all engine commands remain
restricted to the document window. Recognition installation is unchanged.

The strict TypeScript and Rust snapshots contain engine display name, title, requesting plugin
name and ID, disclosure, required/free disk bytes, state and the host-selected button set.
States are `notInstalled`, `broken` with detail, `installing` with display phase, step/step count,
byte counts and estimated flag, `installed`, or `failed` with a message. Buttons are exactly
Install/Close before installation (including broken), Cancel installation/Close during it, and
Close after success/failure. Broken displays **Install engine again**. Disk and progress counts
are nonnegative JavaScript-safe integers. Nested unknown fields, unknown actions/kinds and
malformed states fail closed.

Engine messages have an additional 3400-byte serialized budget within the unchanged 16 KiB input
limit. This leaves room for Rust's complete delivery wrapper below 4096 bytes, even with maximum
envelope tokens and labels. Naming clips plugin/error/detail display strings by JSON-escaped UTF-8
bytes, including the abbreviation suffix. Native progress messages and installed receipts/paths
never enter the snapshot. Phase names are host-authored. Progress replaces the retained snapshot
at the same session revision: there is no user draft to overwrite. Ready flushes the latest
snapshot, including progress received during native construction.

`presentStructureNamingInstall` binds the naming controller to the document's coordinator using
a typed `NamingDialogContext`. The originating tab is captured synchronously before the engine
status await, so switching tabs during the status check cannot retarget the install. The
controller continues the pending naming after Install completes. Close, title-bar close and
originating-tab dismissal decline with `engineNotInstalled` and cancel an install owned by that
request. Cancel installation calls the naming adapter's native cancellation. Failure text stays
in the native window until Close; no successful naming report window is added. Reopening a live
install focuses its retained native window, even while installation is pending.
The document DOM retains only the existing “Naming the structure…” activity indicator.
No native creation failure falls back to an in-page installer.

MainWindow supplies the coordinator and active tab through `PluginRuntimeProviders`.

## Transport and lifecycle

Every message has `protocolVersion`, `ownerWindowId`, `documentTabId`, `dialogKind`, `sessionId`,
`requestId`, and `snapshotRevision`. Incoming payloads are limited to 16 KiB. Ordinary owner and dialog
channel deliveries are limited to 4096 bytes of final serialized JSON, including the delivery envelope
and escape expansion. This keeps deliveries below Tauri 2.11.2's 8192-byte direct-delivery threshold:
larger JSON enters an app-wide fetch queue that does not authenticate the requesting webview.
Export previews use a separate, bounded 5 MiB result containing an inline image or PDF. Rust
packs that result into ordered private-channel chunks of at most 7168 JSON-escaped UTF-8 bytes,
keeping each complete serialized delivery below 8192 bytes. A 256 KiB chunk would enter Tauri's
app-wide unauthenticated fetch queue; that is why previews retain smaller direct-channel chunks.
The host reassembles only one bounded preview at a time;
malformed, incomplete, superseded and closed-session previews cannot replace the current preview.

**Export preview and size presets** is a Preferences checkbox, off by default. Opening Export
reads the saved localStorage preference. Preferences persists and broadcasts changes; same-origin
storage notifications update open Export windows without giving draft windows generic native event
permissions. Main also subscribes to the native preference broadcast. Off uses the original form,
including Scale, Max dimension, JPEG quality slider and destination suggestion, and does no preview
requests, frame computation, rendering or preview IPC. Turning it off clears optional sizing drafts,
cancels outstanding preview requests and discards queued frames.
The owner also drops presentation options on export while its preference is off, so a
dialog awaiting a storage notification cannot export stale sizing settings.
The preference never enters the export engine: equal export options produce equal file bytes.
Preview requests do not reserve an export or grant file access. Rendering remains in the owner
window using the same pending-edit flush snapshot as the final export, debounced 250 ms by the
shared form and capped at 800 pixels on the longest side. Drawing edits
send frame revisions that refresh the preview while preserving the user's options. Frame updates
wait through a pending destination picker and resume afterward; the host retains a frame even if
it arrives before the picker receipt. Superseded form requests abort their local wait and ignore
stale render completions. A native rasterization already started cannot be interrupted. Oversized previews report a
specific error; the final export remains a separate explicit action.
PDF previews show the PDF writer's shared SVG page layout in an image, labelled
“Preview of the PDF page layout”, with PDF page-guide settings and a white background.
They require no embedded PDF viewer in WKWebView or WebView2; final PDF generation is unchanged.
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
The owner immediately publishes an `accepted` result after validating and reserving an action,
before awaiting any flush, preparation, picker or write. The dialog's 10-second action deadline
covers only this acceptance. After acceptance, completion has no deadline: busy state remains
and Cancel stays available, even during a long picker or write. Progress is informational and
does not refresh the deadline. Missing acceptance reports an error after 10 seconds without
retrying or releasing the reservation. While an action is pending, only cancellation is allowed.

Construction is async on a worker, serialized through `lock_window_creation()`, and refused after
quit begins. Builds are hidden, `focused(false)`, focusable, decorated, shadowed, and skip the
taskbar. The host's per-kind spec controls maximizable and resizable properties; Custom Page Size
is neither maximizable nor resizable on either platform. Dialogs are non-minimizable on both
platforms; reopening also unminimizes before showing
and focusing as a fallback, preserving the draft and position. Windows uses a top-level document
owner. macOS uses unparented, focusable floating-level windows at
`toolset_utility_window_level()`, like toolbars, with `hidesOnDeactivate` enabled. They are never
AppKit document children: adding a child makes it adopt the parent's normal level and keeps it
visible with the document on deactivation. Reveal and utility restoration never attach dialogs;
even a recorded child relationship is refused. Registry ownership still dismisses dialogs when
the document is hidden/closed or the app quits, without relying on `parentWindow()`. No menu is
attached. Native close/destroy is authoritative; the document's macOS hide-on-Close hook also
dismisses dialogs. Quit dismisses registered sessions before asking for the final document flush.
Late construction after owner close is discarded.

Dialogs share the floating toolbar level on macOS: normal level would always leave them behind
toolbars regardless of focus. Reveal, retained-window reopen, and becoming key order the dialog
front at that level. Windows uses relative `SetWindowPos` insertion above the highest visible
document-owned utility sibling on reveal/reopen/activation, without TOPMOST or always-on-top.
Toolbar levels and #140 ordering are unchanged. Toolbar flyouts and tooltips retain the utility
level and their front/sibling raise on reveal, so they remain visible above the invoking toolbar.
The front-raise path is suppressed throughout utility suspension/restoration; trait configuration
does not raise. Restoration uses the captured order including dialogs, preserving a dialog above
a toolbar even if that toolbar needs a later restore retry.

Dialogs participate in `UTILITY_SUSPENSION` alongside panels and toolbars, using the existing #140
relative stacking restore. A native message/file box hides them and restores only still-live
sessions. Opening Page Size acquires no suspension. Dialog moves never update toolbar frames or
logical toolbar visibility. First placement centres on the owner's usable frame and clamps to the
monitor work area, using the destination monitor's scale. Placement first moves to that monitor,
then sets client size at its DPI, measures the resulting outer frame and clamps that actual frame.
This avoids Windows WM_DPICHANGED scaling an already destination-sized client twice.
`dialog-positions.json` remembers logical
position, monitor identity and normalized work-area offsets per kind. Removed monitors recover
onto the owner's monitor. Genuine moves are debounced; hidden, minimized, maximized, fullscreen,
initial, restoration and quit moves are excluded. One bounded-notification worker debounces movement bursts, takes pending
positions under the registry lock, then reads/writes outside that lock. Final close flushes share
an IO mutex with the worker so an older worker snapshot cannot overwrite the final position.
Warm snapshot replay does not replace a draft or recentre a moved window.

Escape, title-bar close and Cmd/Ctrl+W cancel. Valid Enter in a field applies; composition Enter does
not. The first field focuses on mount, and dialog Undo/Redo stays local to text fields. macOS
Cmd+A and the native Edit > Select All route to the focused dialog field; with no field focused
they do not change document selection.

## Tool installation

`toolInstall` is the modeless native dialog for an external assistant tool requested by a plugin.
It is 520 × 460 logical pixels, resizable, and retains the shared owner, placement, lifecycle and
private-channel rules. Its typed snapshot records the requested tool, publisher, pinned download
facts, disclosure, disk space and a bounded install state. The Rust and TypeScript validators both
fail closed, including the 3400-byte delivery budget used by `engineInstall`.

The initial download view lists the publisher, version, host and download size. Both the initial
and consent views explicitly name the publisher that receives the prompt and open page, including
unpublished structures; the disclosure is shown verbatim. The accepted actions are `install`,
`allow`, `cancelInstall`, and `close`, with the state-specific button set validated by both hosts.
The document coordinator owns opening, progress updates and closure; plugins receive only the
typed callback and do not receive native window or download authority.

## Adding a later kind

Add a discriminated payload/action adapter and validators in TypeScript and Rust, a lazy trusted
body, and an owner callback in the coordinator. Extend Rust's kind/label allowlist and narrow
capability window matcher; URLs remain host IDs. Keep files, history, settings and plugin operations
in MainWindow. Add contract, lifecycle, originating-context and both-platform manual tests.

Plugin prompts, report readers, plugin manager, toolbar customization and colour editors
are deliberately unimplemented. Modal plugin prompts need an explicit document input lease at the
coordinator seam, including all command/pointer/menu/clipboard paths and dependent prompt stacking;
Page Size has no such lease. Other kinds will need their own busy/progress contracts,
snapshot revisions and cancellation semantics before they can use the host.

## Stage 2: modeless Export

`export.open` opens the second registered kind, `export`, labelled `dialog-main-export-<slot>`.
It is modeless: drawing, toolbars, and other tabs remain usable. Page Size and Export may each
retain a session for the same tab. Export starts at 520 × 620 logical pixels, has a 420 × 360
minimum, resizes with its form body scrolling and its action footer always visible, and cannot minimize or maximize. Its ownership,
floating level, macOS unparented/hides-on-deactivate behavior, first centring, per-kind position
persistence, and utility suspension are the same shared paths as Page Size. No AppKit child
relationship or new global window privilege is introduced. Browser builds retain an in-page
surface containing the very same Export form and validation.

The trusted Export body loads lazily and sends ready only after its form commits and focuses the
filename field; Page Size retains its existing commit-ready path. The snapshot contains only the
originating drawing's title and small initial options. Typed actions
are `chooseDestination`, `export` (each carrying validated options), and `cancel`. MainWindow owns
all rendering, pending-edit flushes, current tab documents, file panels, writes, last-directory
updates and status. Export snapshots the originating tab's document when Export is pressed,
including edits made after opening; switching tabs does not redirect it. Tab close or document
replacement settles the session before installing a new document. Async rendering/picker completion
checks that session again before writing. A write already handed to the filesystem cannot be undone
by closing its window.

The save panel runs in the document window through `nativeFileDialog.save` and the shared utility
suspension. Thus its filesystem grant belongs to the writer. The host receives no file-dialog or
filesystem permission. Both platform branches recognize Export labels as suspended utilities;
only live sessions return, in the captured stacking order and at their retained positions.
MainWindow records the exact granted path, format and filename. Name/format changes clear the
displayed destination; even a stale/forged destination requires another panel unless all three
values match the owner-held grant. The writer uses the exact granted path, without appending an
extension after the panel returns. Overlong path receipts fail visibly before a write.

Results are `accepted`, `progress`, `picked`, `cancelled`, `error`, or `exported`, with bounded path/name, error
or warning notice data. Main returns preparation/picker/write progress without completing the
request receipt or releasing its reservation. Failed operations and cancelled
panels release the reservation for an explicit retry. Completed exports keep Export disabled and
show success and warning details inside the dialog until Close/Escape/Cmd-or-Ctrl+W/title-bar close.
The original export functions, option mapping, PDF metadata generation, and rasterizer input are
unchanged. Long warning details are explicitly marked as abbreviated; encoded notices are bounded
before delivery, and Rust still enforces the complete 4096-byte serialized delivery cap.

Request receipts cover both picker and export actions. Duplicate IDs replay the earlier receipt;
distinct submissions while pending or after success cannot write again. Only cancel is allowed
after the successful export receipt, and `export.open` can focus that retained receipt window.
Cancel also bypasses pending-action reservations in the renderer, coordinator and Rust host.
It settles the session immediately: preparation and picker completions cannot start a write,
and a write already started may finish but cannot publish progress, errors or success to the
closed dialog. The write reservation remains in force while cancellation is delivered.
Warning abbreviation includes its suffix in both the 1024-character notice limit and the
1000-byte JSON-encoded notice budget, leaving room for the complete 4096-byte channel delivery.
The dialog's synchronous pending guard prevents same-turn double clicks before React commits busy
state. First-field focus, IME-safe Enter, Escape, platform-specific close shortcuts and Tab wrapping
live in the shared Export form. Undo/Redo and Select All retain the host's local-field routing.

Stage 2 regression coverage includes protocol/option validation, same-tab independent kinds,
receipt deduplication, visible failures, origin edits/inactive tabs/close/replacement, exact granted
paths, changed-name re-picking, both-platform picker suspension, keyboard/IME behavior, per-kind Rust
spec/placement, and export parity (real SVG/CDXML/PDF bytes; mocked native raster bytes with identical
SVG and raster options). Existing export fixtures remain unchanged. Hands-on acceptance is the
standing checklist's **Native Export** section on both platforms. The build stamp is deliberately
unchanged for the orchestrator to handle during integration.

Stage 2 worker verification: root `pnpm -s lint`, the required dialog command with
`--configLoader runner` (9 files, 52 tests), shell/tab/capability tests (3 files, 392 tests), the
web build with runner config loading, Rust formatting, and `git diff --check` passed. No install,
dependency changes or build-stamp change was made; missing package dependencies used the authorized
read-only source symlinks. The broader desktop/export run passed 3839 tests and skipped two but
initially failed three source assertions tied to the old form/allowlist (updated and passed in the
focused rerun), plus the existing `abbreviationChemistry` RDKit loader failure through the external
dependency symlinks. Export-engine fixtures were not changed.

macOS clippy and Rust tests both stopped in `tauri-plugin-sparkle-updater`'s build script because
this worktree lacks `Sparkle.framework`, before compiling ChemDraft. No framework workaround was
applied. Native launch was not attempted because `run-app` would prepare that missing framework.
Windows menu-churn smoke reported its macOS-host skip. Windows native compilation and all real
window checks on **both** platforms remain unverified. Recommended next task: run native
fmt/clippy/tests with the normal framework available, then the standing Native Export checklist on
macOS and Windows, especially the save-panel round trip, ownership, focus, stacking and mixed DPI.

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

## Dialog stacking fix handoff

The owner-observed macOS failure was a level mismatch: normal-level dialogs could never order
above floating-level toolbars. Dialogs now reuse the toolbar level and raise on reveal, retained
reopen and key activation. Windows explicitly reorders above visible owned utilities, avoiding
TOPMOST even when a foreign topmost window precedes the utility group. Ownership, toolbar levels,
flyout/tooltip reveal behavior and #140 relative restore remain intact. Regression coverage checks
the floating level, attachment/restore decisions and dialog-above-toolbar restore retries.
Panels and analysis windows retain their child policy.

macOS fmt and all-target clippy (`-D warnings`) passed. The dialog Vitest suite passed 6 files,
31 tests with `--configLoader native --maxWorkers 2` and dependency symlinks only. Full Rust tests
passed 299 tests with 2 existing ignores but failed the existing OCSR loopback-bind test because
the sandbox denied socket creation. Excluding only
`ocsr_engine::install::tests::system_download_verifies_pinned_bytes_and_rejects_tampering` passed
the remaining suite and binary/doc targets. Temporary Sparkle links and Cargo output were removed.
`CURRENT_BUILD_STAMP` is unchanged. Windows native compilation and both platforms' real-window
checks remain unverified. Before integration, run the standing Custom Page Size checklist: overlap
the dialog with a toolbar/panel, click it, use the toolbar and its flyout/tooltip, reopen the dialog,
then open/dismiss a native box and verify the prior stacking order survives.

## AppKit parenting correction

Owner measurements after the level fix still showed the dialog at window layer 0: the subsequent
`addChildWindow:ordered:` reset it to the document's level. Dialog configuration now leaves the
window unparented. The shared attachment gate and suspension restore reject dialog labels, even
when a snapshot records a prior child relationship. Plugin panels and analysis windows keep their
existing attachment and recorded restore relationships. Placement and owner dismissal use the
main-window label and dialog registry, independently of AppKit parenting.

Source-text stacking assertions were replaced by decision tests for initial attachment policy,
deferred dialogs, stale parent records and unchanged panel restoration. The floating-level test
and dialog-above-toolbar restore retry test remain. Real-window verification must measure the
dialog's layer, check Cmd-Tab hiding, and repeat reveal/reopen/native-prompt restoration.

Correction validation on macOS: Rust fmt and all-target clippy with `-D warnings` passed. The full
Rust suite passed 301 tests with two existing ignores; its sole failure was the existing OCSR
download test's sandbox-denied loopback bind. Excluding only
`ocsr_engine::install::tests::system_download_verifies_pinned_bytes_and_rejects_tampering` passed
all remaining tests and binary/doc targets. Temporary Sparkle links and Cargo output were removed.
Windows code and `CURRENT_BUILD_STAMP` are unchanged. Windows native compilation and both platforms'
hands-on window checks remain unverified; rerun the full Rust suite outside the sandbox.

Export handles Escape and Cmd/Ctrl+W on document keydown, including when focus has fallen to
body while fields are disabled. A successful export focuses Close. The shared browser form uses
the same scrolling-body/pinned-footer layout. Save-panel suspension release carries the originating
Export session ID; Rust restores focus only to that still-live, visible, ready session, after
restoration, while ChemDraft remains foreground and no other native box is suspending utilities.
Tauri makes it key on macOS and activates it on Windows. Closed or replaced sessions cannot receive
focus, and returning from another application never activates ChemDraft.

## Compound spacing adapter

`arrangementSpacing` reuses the modeless native host, with a 540 × 600 initial client and
resizing enabled. Sessions are keyed by originating tab and kind, allowing Page Size, Export and
spacing to coexist. Closing/replacing a tab closes all three; disabling layouts closes spacing only.
The owner retains an immutable document snapshot and validates it again on preview/Save.
Changes go through the owning tab's history, including when inactive, with one undo entry.

The dialog receives only the title, allowed percentage range and rendered preview, never
document objects or file paths. Nonterminal `preview` actions coalesce in the coordinator;
Save and Cancel retain session-wide terminal reservations. Owner-only `preview` deliveries
carry at most 2000 base64 characters, at most 1024 chunks, over the existing private channels.
No 4096-byte delivery limit or capability family was broadened. Rust and TypeScript validate
both kind-specific messages. The host assembles only the current request in order, with a
bounded total and a timeout; stale/partial/error previews cannot enable Save. Native bootstrap,
focus/ownership, monitor placement, position persistence and native-prompt suspension reuse
the shared host unchanged. Browser builds use the same draft-only form in their fallback.
