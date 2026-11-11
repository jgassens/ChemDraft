# Runtime broker — A5 complete

A5a-6 enables the hidden `runtime` webview at desktop startup in production on macOS Apple
silicon, macOS Intel and Windows. Only its `RuntimeHostWindow` / `runtimeHostSession` path
constructs the sole `pluginRuntimeOwner`. MainWindow uses `runtimeDocumentSession` and
`usePluginRuntimeView`: detached state, contribution proxies and broker actions. Its static module
graph does not import the owner. The browser preview and local embedding compatibility hooks retain
their explicit in-process service; a desktop host failure never selects that path.

The document keeps its command handlers, drawing state, selection, history, gesture/page-fit gates,
dialog coordinator and final synchronous write checks. No plugin permission or captured write-scope
check is removed. One-document panel labels, persistence keys and presentation remain unchanged.
A5b now binds presentation per document window. Another document window is not enabled by this task.

Build stamp: `11.11.02.15-codex`. Implementation is complete; native execution remains unverified
by this worker (the coordinator runs Cargo and packaged app checks). See
[the adapter review](runtime-broker-a5a3-review.md).

## Implemented ownership boundary

`RuntimeBrokerHost` accepts a runtime factory and calls it once, independently of the number of
document clients. A second owner for the same endpoint is refused before the factory runs. It
dispatches through the existing `DesktopPluginHost`, with permissions, recognized-image review
policy, command lifetime and host scope checks intact. It publishes contributions only after the
runtime's complete registration/toolbar-gate/rollback stage, never on an intermediate bare-host
registration notification.

`RuntimeBrokerDocument` constructs no host or controllers. It installs `source: "plugin"`,
`pluginId`-marked command proxies into the document's existing `CommandRegistry`. A complete
manifest snapshot carries menus, toolbar buttons/toolsets, panels and overlays. The receiving
client independently refuses undeclared command permissions and toolbar contributions without
`ui.toolbar`. Core/foreign command collisions fail before mutation; an unexpected failure while
installing a snapshot rolls back the entire proxy registration. Older contribution revisions are
ignored. Snapshots are copied before being exposed to a renderer.

`PluginInvocationDocumentProvider` is an embedding-host contract, not plugin input or a new plugin
capability. Its callbacks are copied into the command invocation before any asynchronous read.
Document reads, selection reads, table document reads, direct-write preflight and application all
use that provider. Concurrent commands never change a global document provider. Existing plugin
permissions are checked on every capability call as before; a provider grants no permissions.

## Message/check table

Protocol version: `RUNTIME_BROKER_VERSION = 1`, separate from the public plugin API. Messages are
validated, copied as JSON-compatible data, and bounded to 32 MiB. Requests and responses are
correlated by authenticated sender, request id and method. Pending calls have a finite deadline
and reject on endpoint disposal. `RuntimeTransport` requires private, addressed deliveries with a
transport-authenticated sender. `connectNativeRuntimeTransport` implements this interface using
private, per-invoke native IPC channels. Tests also retain a JSON-serializing simulated transport.
Neither implementation uses the generic Tauri event bus for broker delivery.

| Method/message | Direction | Target handling | Check location |
| --- | --- | --- | --- |
| `initializeRuntime` | Document → runtime | First authenticated document initializes the sole owner; later documents join its client set; shared initialization promise | Host awaits core definitions before the sole owner factory; finite document readiness deadline |
| `chooseRuntimeFile` | Runtime → document | Fixed package/image picker choice addressed to the requesting document | Native sender/direction checks; existing document picker/suspension and chosen-file scope checks |
| `invokeCommand` | Document → runtime | Document captures `{windowId, tabId}`, drawing incarnation key, invocation id, plugin/command ownership and selection ids before dispatch | `RuntimeBrokerDocument.dispatch`; runtime verifies sender equals target window and plugin owns registered command; existing `PluginHost` checks permissions |
| `getDocument` | Runtime → captured document | Every request carries the same invocation reference; reads the requested tab even if another tab/window activates | Document checks its locally retained invocation, window/tab, plugin/command, current drawing key and tab existence |
| `getSelection` | Runtime → captured document | Same fixed target; reads that tab's current selection, without widening Send-time write scope | Same document-side binding/key/existence checks; host returns an independent frozen snapshot |
| `applyPatch` | Runtime → captured document | Fixed reference plus patch, undo label, plugin/command metadata and current command write scope; no `AbortSignal` crosses the wire | Host retains its original checks; document independently checks scope against its own grant, direct-write operation whitelist and `assertPluginPatchWriteScope` before waiting and immediately before synchronous commit |
| `undoOwnTransaction` | Runtime → captured document | Fixed reference plus transaction id; message cannot register or replace an undo callback | Document checks live binding/key and consumes only a transaction locally recorded for this invocation; callback must retain the existing history-tip check |
| `endInvocation` | Runtime → captured document | Fixed reference; invoked on completion, write cancellation and host-owner disposal | Document closes that binding and aborts its local command signal, so queued writes fail their commit-time recheck |
| `getContributions` | Document → runtime | Document-only peer; no document read or write | Host emits full manifests and enabled registered command ids; receiver validates the complete snapshot before installing proxies |
| `contributions` | Runtime → each document | Addressed to the supplied document-client list; never retargets invocations | Endpoint only accepts runtime sender; document enforces monotonic revision, plugin provenance, toolbar gate and transactional proxy registration |
| `assistantBegin/Read/End/Undo` | Runtime → captured document | Request session retains Send target/key/plugin/selection; history and owned Undo stay document-local | Captured invocation/session checks plus the existing transaction manager/history-tip check |
| `assistantWrite/prepareAssistantWrite` | Runtime ↔ captured document | One-use preparation id and data snapshots; document re-enters gesture gate before final local commit | Permission/lifetime, source incarnation, direct-write whitelist/scope, normalized chemistry and content rechecks |
| `assistantOpenInvocation` | Runtime → captured document | Extra tools receive child invocations with the request's fixed target and a narrowed grant | Local request scope and ordinary invocation write checks; successful receipts alone grow grants |
| `runtimeDialogRequest/Action` | Runtime ↔ requesting document | Open/update/close snapshots retain source window/tab/key; only that document owns a coordinator | Bounded existing dialog snapshot schemas, exact session/target/sender checks and native coordinator authorization |
| `setDocumentMetadata/setCoreCommands` | Document → runtime | Title/command definitions are revisioned data snapshots | Authenticated document sender; core dispatch still checks live document permissions/enabled state |
| `runtimeDocumentClosed` | Native lifecycle/document → runtime | Close only that sender's panels, assistant requests and presentation state | Native injected source, private host channel and connection generation; cleanup is idempotent |
| `getRuntimeView` | Document → runtime host | Serializable view/controller-source snapshots filtered by the authenticated source window | Broker peer/direction/correlation/byte checks; owner projects data only |
| `runtimeViewAction` | Document → runtime host | Fixed action name and argument schema; no arbitrary method path | Existing host/controller/install gates retained; receipts resolve original owner-held inspections |
| `runtimeView` | Runtime host → document | Addressed state plus per-window overlay and recognition activity topics | Only runtime sender; detached snapshots and stable-value reconciliation |

The native transport authenticates the sender and enforces registry membership and method direction
before forwarding. The broker's payload schemas, invocation bindings, permission gates and document
write-scope checks remain independently mandatory. All adapter methods now have native direction checks; nested invocation/session targets must match the authenticated document peer.

## Native transport and hidden host

`apps/desktop/src-tauri/src/runtime_broker.rs` owns the transport state and three commands:

| Command | Checks and result |
| --- | --- |
| `runtime_broker_connect(sender, channel)` | Injected `WebviewWindow.label()` must equal `sender`. Only exact `runtime`, or a ready registry entry whose id and native label both equal the caller, is accepted. Retains that caller's private IPC channel and returns a connection generation. Duplicate connections and more than 65 peers are refused. |
| `runtime_broker_send(sender, connection, recipient, chunk)` | Reauthenticates the caller, its current connection, and both peers on every chunk; recipient must have a native window and a connected channel. Only runtime↔document pairs are allowed. Reassembles bounded bytes, validates protocol version/envelope/method direction and the request's captured document target, then forwards on the recipient's private channel. Membership is checked again for each outgoing chunk. |
| `runtime_broker_disconnect(sender, connection)` | Same exact caller, live membership and connection checks; removes its channel and all incomplete transfers involving it. A stale connection cannot disconnect its replacement. |

Runtime authentication comes only from the exact native label `runtime`; it never registers as a
document. Document namespaces alone do not grant access. Creating/closing/removed documents,
unknown labels, aliases, palettes, tooltips, popovers, panels, dialogs and Preferences are refused.
Navigation-start and destruction hooks forget the old channel and transfers. Each delivery carries
its recipient connection generation, so queued deliveries from a prior webview cannot reach a new
broker subscription that happens to reuse a JavaScript callback id.

Each message is at most **32 MiB of UTF-8 JSON**, split into 4096-byte chunks encoded as canonical
base64. Chunks must declare the exact message byte count and corresponding count (at most 8192),
arrive in order with identical transfer metadata/recipient, and have the exact expected decoded
length. Transfer ids are 1–64 ASCII alphanumeric/hyphen/underscore characters. There is one incomplete
message per sender, at most eight globally, and at most 64 MiB of declared in-flight message bytes.
Incomplete transfers expire after 30 seconds (pruned on transport activity); disconnect, navigation
and destruction remove them immediately. Recipient connection changes invalidate the transfer.
Malformed chunk sequences discard their partial message. Fully reassembled malformed envelopes or
wrong-direction messages produce no delivery. Replies retain the broker's sender/id/method correlation.

Every outgoing channel envelope is checked to be at most **8191 bytes**. Tauri 2 sends larger JSON
through an application-wide fetch queue; keeping all broker payloads below its threshold preserves
private addressed delivery even when utilities can access core event APIs. The transport adds no
generic events, filesystem access, window controls or execution grants.
`capabilities/runtime-broker.json` grants only the three transport commands to
`runtime`, `main` and `doc-*`; utilities match none of those patterns. Native checks remain required
even for matching labels. Transport permissions and utility-exclusion checks are unchanged; the
separate host-services capability is audited below.

`apps/desktop/src/plugins/runtimeBrokerTransport.ts` connects before creating a `RuntimeBroker`,
snapshots and serializes outgoing messages, serializes concurrent sends, reassembles/validates private
deliveries, and disconnects when the broker unsubscribes. It imports no generic event listener. The
adapter connects both production peers. Bounded early deliveries are retained until subscription,
then validated against the returned connection generation.

The native builder consumes one shared `WindowConfig` on macOS Apple silicon, macOS Intel and
Windows: `focus: false`, `focusable: false`, `visible: false`, `skip_taskbar: true`, label `runtime`,
route `/?window=runtime`, and no parent. It adds no menu or document/session/utility ownership.
Windows `install_app_menu` continues to attach only to an active registered document; macOS keeps
its existing app menu. The menu router explicitly excludes `runtime`, including anomalous focus.
Registry-backed session enumeration and focus return exclude it already. Its title retains the
worktree label. The route mounts only the host service, with no document or secondary-window history hooks.

Startup always attempts the shared hidden-window builder; the debug/environment gate is removed.
A native creation failure is logged and drawing startup continues. The document registers its
reply handlers before connecting and requests `initializeRuntime`. The host awaits the document's
core definitions before constructing its owner once; duplicate initialization shares that promise.
The document then installs contributions and initializes its asynchronous view. Commands invoked
before readiness fail explicitly with “Plugin runtime host is starting”; they are never silently
dropped or replayed. Readiness alone retries unavailable-peer/handler errors, for at most 15 seconds.
An absent, refused or hung host produces “Plugin runtime host failed to start: … Drawing remains
available.” on the status line and as a plugin diagnostic; subsequent plugin commands return that
failure. Ordinary command/install deadlines retain their existing five-minute limit.

`runtime-host-services.json` is an exact-`runtime` grant, separate from the unchanged three-command
transport grant. It provides the existing naming/recognition/external-tool/MCP controllers, OPSIN,
plugin storage, fixed download diagnosis and the identical allowlisted release URLs. Staging access
is limited to `$APPDATA/installed-plugins*`. Image read/stat access has no broad path grant: it
requires the native file dialog's chosen-file runtime scope. `chooseRuntimeFile` carries only a fixed
`pluginPackage` / `image` choice; the document opens the same picker through its existing suspension
wrapper. Package bytes, integrity/manifest/handshake validation and inspection receipts stay in the
owner. Native package reads additionally admit the exact injected host label and retain the opened
file's chosen-path scope and exact-sibling checksum checks.

The download-diagnosis and external-tool capability guards admit exactly their existing document
capability file (`main`, `doc-*`) and `runtime-host-services.json` (`runtime` only), with no remote
or webview selectors. The host needs these native calls because it owns the install/update and
external-tool controllers. Keeping the exact host grant avoids adding document-side execution
forwarders to the broker. Each external-tool grant must contain exactly the registered command set;
every other capability file, including utilities, must contain none of these permissions. Diagnosis
remains limited to the fixed native host allowlist, and the existing consent/install gates remain.

Broker sends prune closed peers and their partial transfers before caller authorization, so a
closing sender's rejected continuation cannot retain its buffered message. Pruning uses the live
registry and connection state, never the claimed sender. Rejected aliases and stale connections
cannot discard a live caller's partial. Completion already removes the partial before validation
and delivery. The existing closing-caller and context-menu guard assertions remain unchanged;
the hidden builder now applies the shared default-context-menu policy to its created webview.

The host gains no window controls, menu/session/clipboard/document-write permissions, generic
event emission, native picker or utility-suspension permission. Its only generic event grants are
listen/unlisten for existing update preferences; broker traffic stays on private native channels.
The legacy synchronous proposal acknowledgement is refused on non-immediate transports; production
acceptance must use the captured one-use commit handshake.
Overlay Send asynchronously reads the owner's live declaration before applying the existing
control/command ownership checks; a cached rendering snapshot cannot authorize an obsolete control.

## Document-side scope and commit seam

The document retains its own copy of each invocation's initial selection. Scope arriving from the
runtime can narrow this grant but cannot widen it. Only a successful local commit receipt grows the
grant; failures and refused batches do not. Successful rebased insertion ids join both host and
document scopes. Another invocation starts with its own selection and receives no prior scope.

`RuntimeDocumentPort.read(tabId)` must return an incarnation key stable through ordinary edits,
selection, undo, activation and switch-away/back. Replacement, close and hand-off invalidate it.
Do **not** pass the current A1 activation-sensitive `DocumentIdentities.key` unchanged: it advances
on tab activation. `invalidateTab` is an explicit close/replacement/hand-off cancellation hook, but
`read` must independently detect stale keys; a missed notification must still fail closed.

`runWrite(tabId, commit, application)` is the integration seam for MainWindow's existing gesture
gate and asynchronous page-fit/consent preparation. It receives the stable document-local signal
and complete application. After every asynchronous wait it invokes `commit`, which rechecks the
target, command lifetime, scope grant and atomic indirect-effect scope. The port's final history
commit must be synchronous; no await may separate that recheck and mutation. Keep MainWindow's
existing page-fit/content preconditions too. The commit callback receives the invocation reference
so the document can record its own transaction handle. No second document mutation implementation
is introduced: tests use the existing `applyPluginDocumentPatch` path.

`runtimeDocumentPort.ts` now implements this seam using MainWindow's actual history port. Both
the existing local runtime caller and broker clients use `createRuntimeDocumentPort`. MainWindow
supplies the gesture gate, placement viewport, normalization, shared page-fit/consent path and
synchronous history mutation. A prepared write is retained only during its local commit callback;
a wire message cannot provide or replace that callback. After page preparation, the broker reruns
its binding/scope checks and the port additionally reruns cancellation, writable-state, incarnation,
content and scope checks before history mutation. Unrelated document edits cannot be overwritten
by an asynchronously prepared result.

`DrawingIncarnations` is separate from the activation-sensitive `DocumentIdentities` used by UI
snapshots. Its per-tab UUID survives edits, undo and activation, changes on replacement and is
removed on close; reusing a tab id obtains a fresh UUID. Reads of closed tabs fail before allocating
a key. Inactive commits use that tab's history and dirty flag and retain the active tab's document,
selection and status. Direct plugin writes still join an existing assistant transaction when one
owns the source tab. An ordinary plugin write interrupts an assistant entry as an editor write does.

Selection-warning collectors remain in the source document's invocation binding. The broker
forwards selection data only; overlapping requests and later activation cannot redirect their
collectors. `RuntimeBrokerDocument.invokeCommand` optionally accepts the existing caller's
`selectionWarnings` array, while an uncollected read stays silent.

## A5a complete

The private native transport, tab-addressed commit port, owner/view split, captured chemistry/
assistant/dialog adapters, asynchronous proposals/views, native method validation and production
hidden-host startup are implemented. No second document window is enabled by this task.

## A5b window presentation — complete

`runtimeHostSession` retains one initialization promise and one owner, with a set of authenticated
document clients. Every client refreshes the complete contribution snapshot and installs the same
command/menu/toolbar/panel/overlay proxies. Registration still crosses the runtime's `ui.toolbar`
gate and rollback boundary; no document constructs a host or worker. Core action dispatch and
fixed native package/image pickers return to the requesting document rather than the initializer.

Presentation callbacks in `plugin-host` carry the invocation's captured embedding provider. These
optional callback arguments are host-only; they add no plugin capability or public API version.
The existing schema, command ownership, `ui.panel`/`ui.canvas`, lifetime and document-write checks
remain mandatory. Retained report/status callbacks keep their original source, even after the
command ends. Closing an owner tombstones its presentation so late results cannot reopen its panels.

| Surface | Binding and checks | Proving test |
| --- | --- | --- |
| Panels | Controller entries and in-app slots are keyed by window + plugin + panel. A view contains only its owner's panels. Prompt/select/button actions resolve control metadata in that document and enter its ordinary command proxy. | `runtimeWindowBinding.dom.test.ts`; unchanged panel/controller/MainWindow DOM suites |
| Native panel identity | `main` retains `plugin-panel-v1x<plugin hex>x<panel hex>` and its frame key. Other owners use `plugin-panel-v2x<window hex>x<plugin hex>x<panel hex>`. Malformed v2 never falls back to main. Native open, publication and hide recheck registry ownership; event identity includes the owner. | New `panel_ownership.rs` tests; unchanged `PluginPanelWindow.dom.test.ts` |
| Native focus/placement | Windows builder parent is the encoded document HWND; AppKit attachment and both focus-return paths use the same registry owner. Default placement and lost-monitor recovery use that owner's destination scale. Existing unfocused/nonfocusable/no-taskbar/frame guards remain. | Native source guards; packaged verification remains below |
| Close | Native destruction/navigation destroys only that document's panels and removes its deferred restores. Disconnect sends `runtimeDocumentClosed` on the private runtime channel, even if membership pruning removed the closing peer. The runtime removes that client, notifies each panel's plugin once, and clears its assistant/prompt/image/overlay state. | Two-client close/late-report test; new native disconnect test (not executed) |
| Assistant/history | The broker addresses the document's own history port and transaction manager. The local compatibility history registry is keyed by window, replacing its single slot. Concurrent requests for one plugin are separated by window; `callTool` resolves the captured window/tab rather than the first plugin request. Closing a tab includes its window. | `runtimeWindowAssistant.test.ts`; unchanged `runtimeAssistantForwarding.test.ts` and real MainWindow Undo/Redo suite |
| Send capture | MainWindow prepares a one-use command closure before its command queue waits. It retains window/tab/incarnation and Send selection, then enters the ordinary registry and commit-time checks. Activation cannot redirect it or widen its write grant. | Two-client queued-Send test; unchanged write-scope and broker tests |
| Overlays | MainWindow passes its captured window id in the React key and storage key. Owner maps, draft-restore tokens, content, status, transcript and open requests are window-scoped and published separately to each client. Gestures and exports keep the existing hiding path. | `PluginCanvasOverlay.windows.dom.test.tsx`, two-client presentation suite; unchanged 100-case overlay DOM suite |
| Prompts/images | Requests retain their source window before awaits. Only that view shows/answers the prompt or image request; the chosen-file request returns to that document. Recognition install/activity retains the same source. | Two-client prompt/refusal test; unchanged prompt, image-provider/controller/dialog and recognition suites |

When more than one document exists, panel chrome also shows its owning window's current document
name. A single window retains its existing panel title, labels, frame keys and overlay position keys.
The async initial-view adapter merges topic snapshots independently of state revisions, so joining
or metadata notifications cannot discard an overlay's initial content.

### Hooks retained for the later tab hand-off

The source port still resolves tabs by id. `DrawingIncarnations.replace/remove` and
`RuntimeBrokerDocument.invalidateTab` invalidate queued or running source writes; they do not
retarget an old invocation. `AssistantTransactions.hasRunningForTab(tabId)` lets the later hand-off
refuse a move during a request. Panel ownership remains with the source window. No tab-moving,
window-creation, session or close-versus-quit policy is introduced here.

### A5b verification handoff

Existing test fixtures and assertions are unchanged. New fixtures use two document ids with the
same tab id intentionally, and generated assistant insertion ids are normalized only for the
cross-target history comparison. The source-text panel-hide guard retains its original call shape
through a window-local authorizer that still runs the full registry/owner check.

Scoped Vitest runs use explicit paths, at most two files per run, and
`--configLoader runner --no-cache --maxWorkers=1 --testTimeout=30000`. They cover production
two-client startup, contributions, panels, prompts, overlays, assistant history, broker/native
transport contracts, original write scope, real MainWindow commits, worker registration and the
existing image/recognition paths. The worker report records final TypeScript, web-build, whitespace
and standalone Rust-format results.

No install, Cargo, native build or native launch was run. macOS Apple silicon, macOS Intel and
Windows are **unverified natively**. The coordinator must run Rust fmt/clippy/tests and packaged
single-window checks on both OSes, then the two-window pass when creation is enabled: panel parent/
focus return/no-taskbar, owner-close cleanup and plugin notification, mixed-DPI placement/restoration,
prompt/image routing, independent overlay placement/content and captured assistant Undo/Redo.
Recommended next task: that native verification before integrating A5 and proceeding to A6/A7.

## A5a-6 verification handoff

New source/DOM suites prove host-only construction, one owner through StrictMode remounts, awaited
core definitions, main static-import isolation, startup refusal/failure with working core drawing,
finite absent/hung-host waits, buffered private startup delivery and connection-generation checks.
The native routing table is cross-checked against every typed method; additional Rust tests cover
adapter directions and nested target forgery.

Two obsolete test fixtures changed: `runtimeBrokerTransport.test.ts`'s capability-name inventory
adds the separate host-services capability (its exact transport permission and utility assertions
remain); `runtime_broker_tests.rs`'s builder-source fixture now requires production startup without
the removed debug gate. No existing behavioral assertion was weakened. The browser-only inert
runtime-route test is unchanged.

The worker handoff records scoped Vitest, web-build, standalone rustfmt, whitespace and final desktop
TypeScript results. No install, Cargo, native build or application launch was run. Native macOS
(Apple silicon and Intel) and Windows remain **unverified**: run Rust fmt/clippy/tests and packaged
startup, then check hidden focus/taskbar/menu/session exclusion, chosen-file reads and package
install/update, prompts, naming/recognition, panels/overlays and assistant Undo/Redo with one document.
Recommended next task: coordinator native verification; A5b presentation binding is complete above.

## Earlier verification and limits

For A5a-2, 128 unique TypeScript tests passed across `runtimeBrokerTransport`, both runtime broker
suites, `RuntimeHostRoute`, `DialogRoute`, `coreCapabilityGrants`, `dialogCapabilities`,
`createPluginRuntime` and `pluginWorkerBridge`. Every Vitest run used at most two files with
`--configLoader runner --no-cache --maxWorkers=1 --testTimeout=30000`. No existing fixture or assertion
was replaced; the native registered-command guard additionally checks the three broker commands.
The standalone Rust formatter was applied to the new modules and build script, without Cargo.
The desktop TypeScript check is the worker's final check after all edits; its result is in the handoff.
The full gauntlet and native launches remain for the coordinator.

Dependencies were relinked with the owner-specified script. No `pnpm install`, Cargo, application
build or launch was run. Existing tests and fixtures were not edited. New simulated clients carry
explicit `{windowId, tabId}` targets and separate drawing-incarnation keys because activation must
not invalidate a captured plugin command.

Broker tests cover every wire method, version/shape/size/direction checks, sender/id/method reply
correlation, utility refusal, deadlines/disposal, two concurrent clients and one runtime factory,
contribution propagation and rollback, activation changes, closed/replaced/handed-off targets,
transaction ownership, scope widening, successful rebased insertions, failed insertion/batch scope,
every ordinary out-of-scope edit kind, repeated ids, five reaction-reference paths, bracket
partner/pair changes, plugin unregistration and commit-time checks after a gesture wait. These
port representative #364 cases; they do not duplicate all 72 original scope tests. The original
72-test scope suite passes unchanged.

Required existing `createPluginRuntime.test.ts`, `pluginWorkerBridge.test.ts`,
`coreCapabilityGrants.test.ts` and `dialogCapabilities.test.ts` passed. Additional existing host,
selection, assistant, table, panel-input and desktop runtime tests passed. The worker's final JSON
records final broker/provider runs, TypeScript and whitespace results.

macOS Apple silicon, macOS Intel and Windows native behavior are **unverified**. After the cutover,
the coordinator must run Cargo fmt/clippy/tests and native builds, then verify hidden-window
focus/taskbar/menu/registry/session exclusion, prompts and installs, unchanged single-window
commands/panels/overlays/assistant history, and delayed commands while changing activation on both
OSes. Native tests are now authored in `runtime_broker_tests.rs` for shared builder flags and routing/
registry exclusion, caller/connection/utility refusal, all method directions, exact 32 MiB reassembly,
chunk ordering/encoding/count/size limits, aggregate budgets/expiry and capability/permission wiring.
They have **not been executed**, per the worker's no-Cargo instruction. No native build, launch or
platform verification is claimed by the TypeScript tests. The coordinator must run those native
tests and check the production hidden host on both macOS architectures and Windows before integration.
