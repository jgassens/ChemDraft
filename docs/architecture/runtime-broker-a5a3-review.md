# A5a document commit seam and adapters — hidden-host cutover complete

A5a-6 moves the sole production desktop runtime into the hidden `runtime` route and enables its
native window in release builds on both platforms. MainWindow constructs only its broker document
view. Startup awaits core definitions and then view/contribution initialization; an unavailable host
reports a specific failure while drawing remains usable. No local desktop fallback is constructed.
The browser/local embedding path remains separate. Native execution is still for coordinator
verification; another document window is not enabled.

## What moved in A5a-3

MainWindow's direct plugin patch application now uses `createRuntimeDocumentPort` in
`plugins/runtimeDocumentPort.ts`. The port shares the existing `applyPluginDocumentPatch` function,
MainWindow's per-tab history, gesture gate, normalization and page-fit preparation. The local runtime
and broker clients use the same commit path. A5a-3 moved no controller, plugin registration,
installed reload or update ownership; A5a-4 below adds that split. No Rust, capability grant, native transport method or public plugin API changed.

The port's final commit has independent cancellation, window/tab/incarnation, writable-state,
content and `assertPluginPatchWriteScope` checks. They run synchronously after preparation, alongside
the broker's original invocation lifetime and captured-scope checks. A prepared callback stays in
the document and cannot be supplied by a wire message. The runtime's existing permission checks and
recognized-image proposal review are retained.

`DrawingIncarnations` records a UUID per drawing lifetime, independent of activation-sensitive
UI snapshot revisions. Replacement invalidates the old UUID and close removes it. Activation,
selection, ordinary edits and undo leave it alone. Inactive writes update that tab's own history,
dirty flag, selection and saved status. Its active neighbor's state stays intact.

## A5a-4 owner/view split (single webview)

`createPluginRuntimeOwner` constructs the runtime and bundled workers once. Its `start` owns
installed-plugin loading, update scheduling, naming and external-tool presenters, and controller
subscriptions. The stable application registry identifies the local service lifetime. View
subscriptions and React StrictMode effect replay do not recreate or dispose that service.
`usePluginRuntime` remains a local embedding compatibility hook over the same owner factory for
existing callers/tests; production MainWindow uses `usePluginRuntimeView`.

`RuntimeViewClient` has detached data and explicit actions only. Its host-shaped read facade is
not a PluginHost; controller-shaped sources contain snapshot getters, subscriptions and broker
actions. The owner publishes general view state separately from overlay content/status/transcript/
open requests, naming state, recognition activity and install progress. General-state reconciliation
retains equal menu/panel/catalog references; progress events do not rebuild MainWindow's menus.

`getRuntimeView`, `runtimeViewAction` and `runtimeView` notifications use the existing addressed,
JSON-serializing channel implementation, promoted from the test helper to
`runtimeInProcessChannels.ts`. `RuntimeTestChannels` now extends that implementation and adds its
delivery log; no existing test assertion or fixture was changed. Actions have a fixed name, arity
and argument schema; functions, controllers, signals and worker descriptors never cross it. Package
reviews carry owner-held inspection receipts, preserving original archive bytes and install gates.
Large recognition previews are reconstructed from bounded data reads as the identical data URI.

At A5a-4, proposal acceptance used an immediate acknowledgement and core/plugin commands shared a
registry. A5a-5 below replaced production proposal acceptance and command dispatch; A5a-5b
below completes the document bootstrap, assistant and dialog adapters. No Rust, native grant,
hidden-host startup or public plugin API changed.

## A5a-5 forwarding adapters — original handoff (completed by A5a-5b below)

MainWindow now supplies its existing document port to the local session. The session binds
`RuntimeBrokerDocument` and `RuntimeBrokerHost` to the **same** owner runtime, without creating a
second runtime. Plugin handlers live in the owner's registry; the document registry owns contribution
proxies and core handlers. `runtimeCoreCommands.ts` forwards bounded command definitions and explicit
core invocations as data, rechecking the live document registry's enabled/permission gates. It refuses
plugin handlers on the core path and prevents core/plugin registration collisions. Core definition
reads at that handoff required the immediate channel; A5a-5b replaces them with asynchronous snapshots. Native startup is not enabled.

Naming, default SMILES layout and recognition preparation now read through each invocation's broker
document provider. Naming also reads that invocation's selection, preserving its permission and
cancellation gates. Recognition retains the host's same-invocation chosen-image check and mandatory
proposal review. Table placement reads the captured viewport through `getViewportRect`. Their writes
use the existing real history port and its independent scope/content/lifetime checks. Proposals retain
their captured window as well as their source tab. Non-invocation bootstrap reads were still local at the A5a-5 handoff; A5a-5b below removes them.

Production proposal acceptance now uses asynchronous `acceptPreparedProposal` → `commitProposal`
messages. The document retains its prepared document and one-use commit callback under an opaque
receipt. The owner reserves the pending proposal, validates the source target, requests the local
commit, and resolves the reservation only after success. During the reservation, a second acceptance
or rejection is refused. Failure releases the reservation and keeps the proposal pending. The
document rechecks mount/quit, active tab, drawing identity, canvas gesture and content immediately
before its unchanged labelled history commit. No document or callback crosses this handshake.
The old synchronous host-shaped facade remains for local embedding compatibility; production
MainWindow uses the new handshake.

A5a-5 originally left assistant contexts/history and bootstrap ports open. A5a-5b below completes
those data adapters; A5a-6 below completes the native hidden-host cutover.

## Adapter table

All paths are under `apps/desktop/src` unless stated otherwise.

| Dependency | Old path | New path/status | Proving test |
| --- | --- | --- | --- |
| Document read/history | MainWindow active-document refs inside `applyDocumentPatch` | MainWindow supplies `RuntimeDocumentPort.read(tabId)` through its existing `AssistantHistoryPort` | `plugins/MainWindow.runtimeBroker.dom.test.tsx`: late inactive-tab write, exact source Undo/Redo |
| Drawing identity | Activation-sensitive `DocumentIdentities.key` | Independent `DrawingIncarnations` for the broker port; existing UI keys remain in place | `plugins/runtimeDocumentPort.test.ts`: replacement/remove/reuse; MainWindow broker DOM: activate away/back retains key |
| Gesture gate | Inline `pluginWriteGateRef.run` in MainWindow callback | `createRuntimeDocumentPort.runWrite`, same gate supplied by MainWindow | `plugins/runtimeDocumentPort.test.ts`: final gesture state used for preparation |
| Page-fit preparation/commit | Inline `commitWithPageFit` and MainWindow history callback | Same functions supplied to the port, followed by independent commit-time checks | `plugins/runtimeDocumentPort.test.ts`: replacement, content edit, cancellation, quit and indirect-effect changes during preparation refuse mutation |
| Assistant direct-write grouping | MainWindow local `assistantTransactions` lookup | Same manager and history port, looked up by the captured source tab | `plugins/MainWindow.runtimeBroker.dom.test.tsx`: broker writes group into one entry; exact Undo/Redo selection; Undo this request |
| Selection-warning collection | Runtime-owned synchronous collector around document snapshot reads | Broker retains the caller's collector in its source-document invocation; only selection data crosses the transport | `plugins/runtimeBrokerIntegration.test.ts`: overlapping tabs, delayed reads and silent uncollected reads |
| Proposal acceptance callback | MainWindow calls real host with a function | Asynchronous reservation/one-use document commit receipt; preparation, final checks and history commit stay local; failed commits remain pending | `runtimeProposalForwarding.dom.test.ts`; `MainWindow.recognitionAccept.dom.test.ts` (failure injection fixture retargeted; assertions unchanged) |
| Assistant begin/end, history and contexts | Local controller, transaction manager and module-level history slot | Owner controller uses captured assistant session messages; the source document owns the transaction manager, history port, page consent and final gesture-gated commit | `runtimeAssistantForwarding.test.ts`: full local/broker history, label and touched-selection equivalence, redo without tools/providers, extra-tool/direct-write grouping, owned Undo, closed-tab refusal |
| Naming, recognition preparation and structure layout | `createPluginRuntime` callbacks use desktop providers | Invocation-bound broker document/selection reads feed the existing owner-side engines; chosen-image, permission and cancellation checks retained | `runtimeForwardingAdapters.test.ts`: exact direct/broker history, label and selection; activation/replacement |
| Table placement viewport | Active-tab/module-level history lookup | Captured invocation `getViewportRect` data read, ordinary direct-write history path | `runtimeForwardingAdapters.test.ts`: identical placement, history, label and selection |
| Shared CommandRegistry | Owner and view share a registry object | Owner plugin registry, document contribution proxies, asynchronously mirrored core definitions and data-only invocations; live enabled/permission checks remain in the document | `runtimeProposalForwarding.dom.test.ts`: core commit, selection, disabled handler, collision and plugin-path refusal; MainWindow broker/recognition DOM suites |
| Runtime view, panels, overlays, prompts, image and external-tool actions | Direct host/controller calls and subscriptions | Serializable snapshots and explicit actions through `RuntimeViewClient` / `runtimeViewOwner`; owner retains controllers | `runtimeOwnerView.dom.test.tsx`, unchanged plugin DOM suites |
| Naming/external-tool dialogs | Owner receives a document DialogCoordinator | Owner sends bounded snapshot/open/update/close requests with the captured target; only the requesting document holds a coordinator; actions return through authenticated broker replies | `runtimeDialogForwarding.test.ts`: same-tab sessions in two owners, routed actions, stale/foreign refusal and capture before external-tool status awaits |
| View initialization and preview reads | Immediate broker receipts | Production uses async initialization, cached declarations/metadata and bounded async preview reconstruction; legacy synchronous facade remains for local embeddings only | `runtimeAsyncView.test.ts`: native-style async channels, no immediate calls, exact large preview and core dispatch |
| Installed-plugin reload/update | `usePluginRuntime` effects/actions | `pluginRuntimeOwner` startup, scheduler and actions; metadata/receipt view only | Unchanged hook install suite; new owner/view package-receipt test |

## A5a-3 verification and integration limits

The new MainWindow broker DOM suite uses the real port captured at construction, a real
`RuntimeBrokerDocument`, a real `RuntimeBrokerHost` and the JSON-serializing simulated private
channels. It does not mock document application, history, transactions or selection. Its extra
runtime is a test harness only; production startup is unchanged. Both macOS and Windows shortcut
parameters are exercised on this macOS test host. New unit tests also cover preparation failures and
refuse commits made outside the local prepared-write callback.

No existing test fixture or assertion was changed. New test fixture mistakes (attempting to mutate
an immutable engine selection and an invalid reaction field) were fixed in the new tests. The
worker's JSON handoff records commands and final outcomes, including the final desktop TypeScript
check. No `pnpm install` or Cargo command was run.

The following 721 unique tests passed across 34 files. All Vitest commands used
`pnpm exec vitest run`, `--configLoader runner --no-cache --maxWorkers=1 --testTimeout=30000`.
Paths below are relative to `apps/desktop/src`. Each row was a two-file invocation except the last
two rows, which ran together with `runtimeDocumentPort.test.ts` in separate invocations. An initial
MainWindow filter unintentionally matched three files because `.ts` also matched `.tsx`; it passed,
and the intended pair was rerun with `--exclude apps/desktop/src/MainWindow.plugins.dom.test.tsx`.
All other invocations ran at most two files. No test assertion was weakened to resolve a failure.

| Files | Passed tests |
| --- | ---: |
| `plugins/usePluginRuntime.dom.test.ts`, `plugins/usePluginRuntime.installs.dom.test.ts` | 6 |
| `plugins/createPluginRuntime.test.ts`, `plugins/pluginRuntime.test.ts` | 37 |
| `plugins/createPluginRuntime.naming.test.ts`, `plugins/StructureNamingInstall.dom.test.tsx` | 19 |
| `plugins/StructureRecognitionController.test.ts`, `plugins/pluginStructureRecognition.test.ts` | 52 |
| `plugins/PluginPanelController.test.ts`, `plugins/PluginPanelSurface.dom.test.ts` | 30 |
| `plugins/PatchReviewTray.dom.test.ts`, `plugins/detachedPanel.integration.dom.test.tsx` | 8 |
| `MainWindow.plugins.dom.test.ts`, `plugins/MainWindow.plugins.dom.test.ts` (explicit `.tsx` exclusion) | 31 |
| `MainWindow.plugins.dom.test.tsx`, `pluginCommandUnmount.dom.test.tsx` | 120 |
| `assistant/AssistantToolsController.test.ts`, `assistant/assistantTransaction.test.ts` | 112 |
| `assistant/pluginWriteScope.integration.test.ts`, `plugins/selectionSnapshot.test.ts` | 68 |
| `plugins/pluginPanelActions.test.ts`, `plugins/overlayChat.integration.dom.test.tsx` | 42 |
| `plugins/runtimeBroker.test.ts`, `plugins/runtimeBrokerTransport.test.ts` | 20 |
| `plugins/createPluginRuntime.externalTools.test.ts`, `plugins/PluginManagerDialog.dom.test.ts` | 65 |
| `documentIdentity.test.ts`, `plugins/runtimeDocumentPort.test.ts` | 13 |
| `MainWindow.assistantTransaction.dom.test.ts`, `plugins/MainWindow.recognitionAccept.dom.test.ts` | 19 |
| `plugins/StructureRecognitionInstallDialog.dom.test.ts`, `plugins/pluginStructureNaming.test.ts` | 37 |
| `plugins/MainWindow.runtimeBroker.dom.test.tsx` | 4 |
| `plugins/runtimeBrokerIntegration.test.ts` | 38 |

The new document-port and MainWindow broker suites, plus the existing assistant-history and
recognition-acceptance DOM suites, were rerun after the final commit-path edits and passed.

macOS Apple silicon, macOS Intel and Windows native execution are **unverified**. The coordinator
must run the native gauntlet and app checks after the actual ownership cutover. No native build,
launch or full gauntlet is claimed here.

## Remaining work — native verification after A6

A6 adds the sole Rust session coordinator, revisioned v2 persistence, a one-time atomic v1 backup,
per-window restore views, the temporary combined-window restore, metadata preservation and queued
OS file opens. See [document-session.md](document-session.md) for the format and API. Build stamp:
`11.11.03.00-codex`. No Cargo command or native launch ran in this worker session. Integration must
run Rust fmt/clippy/tests and packaged checks on macOS Apple silicon, macOS Intel and Windows,
including exact migration/backup retention, fresh-start preservation, crash/relaunch, strict update
flush and three-file Finder/Explorer opens. The source assertions in `App.test.ts` for the old
panel parent/title remain baseline failures from before A6; their expected patterns are absent in HEAD.

Remaining implementation is A7's close/quit and all-renderer flush barrier, A8/A9 menus/focus,
A10 native window creation and separate-window restore, A11 diagnostics, A12 final docs, and
the held A10b tab moves. A6's offer/installed/release hooks have a stub-client dry run; no tab
movement or second-window UI is enabled.

**A5a implementation is complete**, including production hidden-host startup, native adapter
method/direction/target checks, minimal host service grants and asynchronous readiness. The first
authenticated document initializes the sole owner after its core definitions arrive. MainWindow's
static import graph excludes the owner and local bootstrap. Startup failures never construct a
replacement owner and never prevent core drawing. The source/DOM/transport tests are
`runtimeHostContract.test.ts`, `runtimeHostStartup.dom.test.tsx` and
`runtimeStartupTransport.test.ts`.

The coordinator still must run native Rust checks and packaged single-document verification on
macOS Apple silicon, macOS Intel and Windows: hidden focus/menu/taskbar/session exclusion,
dialog suspension/focus, chosen-file reads and plugin install/update, naming/recognition,
panel/overlay/prompt actions, proposals and assistant history.

**A5b implementation is complete** at build `11.11.02.15-codex`. The production host admits
multiple document clients without constructing another runtime. Panels, native owners/frame keys,
panel actions, overlay subscriptions/content/transcripts and assistant history are window-bound.
MainWindow captures queued Send targets and scope before waiting; assistant `callTool` selects the
captured request rather than the first request for a plugin. Prompt/image/file-picker presentation
also returns to its source window. See [the A5b binding and verification table](runtime-broker.md#a5b-window-presentation--complete).

No existing fixture or assertion was edited. New tests cover two production clients, contribution
proxies, panel prompt/select/button routing, capture across activation, owner-only close and plugin
notification, late-result refusal, independent overlay positions, source-only prompts, and identical
assistant history/selection with Undo/Redo making no AI call. The existing broker, scope, panels,
overlay, assistant, worker and native-contract suites pass unchanged.

Remaining work is coordinator verification: Cargo fmt/clippy/tests and packaged execution on macOS
Apple silicon, macOS Intel and Windows. Check the encoded native owner/Windows HWND, AppKit focus
return, no taskbar entry, deferred-close cleanup, monitor-scale restore, single-window parity and
two-window panel/prompt/overlay/assistant behavior. The new Rust tests were formatted but not run,
per the worker's no-Cargo instruction. No second-window UI or tab move is enabled here; A6 is now
implemented above, while A7 and the held A10b implementation remain separate tasks.

The new host-services grant is exact-`runtime`: existing engines/controllers, scoped plugin storage/
staging and the unchanged release URL allowlist. Image read/stat depend on the native picker scope.
Pickers and utility suspension stay in the document. No window/menu/session/clipboard/document-write
or generic event-emission grant was added. Package reads admit only the exact injected host beside
registered document callers and still enforce the chosen opened-file path and checksum sibling.

Two obsolete fixtures were necessarily updated: the transport capability-name inventory adds the
host-services grant, retaining all transport isolation assertions; the native builder-source fixture
now asserts production startup without the removed debug gate. No existing behavior assertion was
weakened. Build stamp: `11.11.01.10-codex`. No Cargo, native build or launch ran.

## A5a-5b data adapter details

`runtimeAssistantClient` retains only owner callbacks and detached snapshots. Send opens a
document-retained session with the invocation's window, tab, drawing incarnation, plugin and
selection. Host tools asynchronously refresh that session before reading; plugin extra tools open
a child invocation with the same target and independently checked scope. Neither path consults the
owner webview's module-level history slot. End/owned Undo reach the same document-side
`AssistantTransactions` used by direct plugin writes. User-edit interruption, cumulative touched-id
selection, labels and exact history restoration remain in that existing implementation.

The document waits for its existing PluginWriteGate, asks the owner to prepare a one-use write id
against its gate-time snapshot, then re-enters the gate after the reply. It checks lifetime,
incarnation, writable state, patch whitelist/scope, normalized chemistry and content before a
synchronous local history commit. Shared `pageGrowthWrite.ts` retains the original page translation
and selection semantics. No executable value, AbortSignal, history callback or controller crosses
the broker. Cancellation ids abort document-local waits; completed requests cannot write.

The local bootstrap no longer passes document/key/tab/title/selection/write callbacks to the owner.
Even local test embeddings keep their legacy source callbacks inside a document adapter.
Tab titles travel as metadata snapshots, keyed by source window. Owner-initiated compatibility
commands first capture a target through messages, then dispatch through that document; production
Send already captures its target in `RuntimeBrokerDocument`.

Naming/external-tool policy controllers and install work remain in the owner. Their presenters use
a data dialog port; the requesting window opens/updates/closes its own coordinator session and
returns action receipts. Naming activity is rendered from data in the document, preserving its
existing appearance and cancellation action.

Production view initialization, overlay/proposal metadata and large preview reconstruction use asynchronous calls or received
snapshots. Acceptance queries screen-capture provenance asynchronously at decision time; rejection
awaits the owner receipt so stale/reserved proposals retain their existing failure behavior. Core definitions are
revisioned snapshots; the document still checks enabled state, command ownership and permissions
at invocation. The legacy synchronous proposal/view facade remains available only to local
embedding callers; production and native-style tests do not call it.

All existing tests and fixtures are unchanged. The new fixture compares complete local/broker
histories after normalizing only generated opaque ids and wall-clock update timestamps; redo
restores the exact recorded object within each run. Engine boundaries are mocked. The final JSON
handoff records scoped Vitest/typecheck/whitespace outcomes. No install, Cargo, native build or
launch ran. macOS Apple silicon, macOS Intel and Windows native behavior remain **unverified**;
the coordinator owns those checks. Build stamp: `11.11.00.15-codex`.
Historical A5a-5b handoff: its recommended native allowlist/grant review and ownership cutover are now implemented by A5a-6.

## A5a-4 verification handoff

The new `runtimeOwnerView.dom.test.tsx` covers one owner across StrictMode view remounts, a
snapshot-backed facade rather than a PluginHost, broker-only actions, prompt settlement,
invocation-specific warning collectors and retained permissions, local proposal preparation with
owner acknowledgement, action schemas, executable-data refusal, React event exclusion, owner-held
33 MiB package inspections and exact bounded recognition-preview reconstruction.

Existing tests are unchanged. The only existing test-support change is
`testSupport/runtimeBrokerChannels.ts`: it extends the production JSON channel so tests and
production exercise the same implementation, retaining its existing log and injection API.
Initial new-test fixture errors used a nonexistent prompt permission and selection method; those
were corrected in the new test only. Regression tests exposed two required live owner reads and
React's extra click-event argument; the implementation was corrected without weakening assertions.

All Vitest runs use explicit paths, at most two files, and
`--configLoader runner --no-cache --maxWorkers=1 --testTimeout=30000`. The final JSON handoff
records the passing runs and the final desktop TypeScript/whitespace checks. Some existing DOM
tests emit React act warnings and the detached-panel fixture logs a caught shortcut-listener
assertion; those suites still pass.

The root `pnpm lint` check passed. Two later runs of the existing cold RDKit paste case exceeded
its unchanged five-second wait while a desktop typecheck was active; an isolated repeat passed.
The final handoff records the subsequent complete plugin DOM rerun and desktop typecheck results.

No `pnpm install`, Cargo command, native build or native launch was run. macOS Apple silicon,
macOS Intel and Windows native behavior remain **unverified**. The coordinator must run the
native gauntlet and hands-on single-window pass on both OSes. Recommended next task: the captured
document/provider and asynchronous commit adapters above, before enabling hidden-host startup.

## A5a-5 verification handoff

`runtimeForwardingAdapters.test.ts` compares direct and broker execution for naming, layout,
recognition preparation and table placement, including exact history entries, labels and selected
objects. Engine boundaries are mocked; recognition still uses the real preparation/import builder,
with only its opaque generated fixture id pinned because reservations intentionally span runtimes.
`runtimeProposalForwarding.dom.test.ts` switches the channel to asynchronous deliveries and disables
immediate receipts for proposal acceptance. It covers success, failed/stale commits, retry, wrong
window/tab, reservations, duplicate acceptance and forged preparation receipts. It also covers core
dispatch and refusal with both platform parameters. Existing MainWindow broker tests continue to
exercise real Undo/Redo and assistant direct-write grouping on macOS/Windows parameters.

One existing fixture changed: `MainWindow.recognitionAccept.dom.test.ts` injects its existing
acceptance failure at `reserveProposedPatchAcceptance` instead of `acceptProposedPatch`, which is no
longer called by production acceptance. Its failure message and assertions are unchanged. No other
existing test/fixture changed. Initial failures in the new tests were invalid fixture page layout,
missing recognition agreement, and non-deterministic generated ids/clock; those were corrected in
the new fixtures without weakening existing assertions.

All Vitest runs use explicit paths, at most two files and
`--configLoader runner --no-cache --maxWorkers=1 --testTimeout=30000`. The final JSON handoff records
the final test, typecheck and whitespace outcomes. No install, Cargo, native build or native launch
was run. macOS Apple silicon, macOS Intel and Windows native behavior are **unverified**; the
coordinator must run native checks and the single-window command, prompt, proposal, selection and
history pass on each build. That handoff recommended the assistant/context/history and bootstrap
work now completed by A5a-5b above; native routing/grant review and ownership cutover remain.

## A5a-6 cutover review

| Seam | Final path/check | Proving test |
| --- | --- | --- |
| Runtime construction | Lazy native host route; initialize promise shared; await core definitions before owner factory; no desktop local fallback | `runtimeHostStartup.dom.test.tsx`, `runtimeHostContract.test.ts` |
| MainWindow imports | Failure-result helper has no owner dependency; native view's static graph excludes owner/bootstrap | `runtimeHostContract.test.ts` |
| Startup ordering/failure | Finite readiness retry only; commands before ready refuse specifically; failed startup appears in status/diagnostics and later command errors; core drawing still works | `runtimeHostStartup.dom.test.tsx` |
| Private transport startup | Bounded early delivery buffer, existing sender/connection/chunk/parser checks on subscription | `runtimeStartupTransport.test.ts`, unchanged transport behavior cases |
| Native adapters | Every typed method mapped to a direction; captured invocation/session/window targets must match the document peer | `runtimeHostContract.test.ts`; new native adapter-direction/forgery test (not executed) |
| Native window | Always built, same hidden/unfocused/nonfocusable/no-taskbar/unparented config; creation error does not abort drawing startup | Source contract and retained native flags test (native execution pending) |
| Host native services | Exact host-only grants; app-data-only staging and chosen-image reads; fixed document-owned native pickers | Source capability contract; coordinator must verify actual ACL/chosen-file behavior |
| Overlay Send authorization | Read the owner's live declaration asynchronously; refuse changed tab/incarnation/selection during that wait before starting a command; retain existing ownership checks and the draft on refusal | Unchanged live-declaration/foreign-command MainWindow DOM case; `runtimeOverlayAction.test.ts` |
