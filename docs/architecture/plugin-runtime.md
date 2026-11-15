# Plugin runtime architecture

How ChemDraft hosts bundled plugins: the persistent host, the generic
capability APIs, the declarative panel model, menu integration, the worker
pattern, and the panel lifecycle. The mass-fragment demo is the only bundled plugin.
Official plugins, including the NMR predictor and MolScribe OCSR, are installed from
their own repositories. Everything here is domain-neutral — no domain concepts leak
into `plugin-api` / `plugin-host`.

## Layers

| Layer | Package | Role |
|---|---|---|
| Generic contracts | `@chemdraft/plugin-api` | Manifest, permissions, command context, selection/analysis/panel APIs, declarative `PluginPanelReport`. **React-free.** |
| Host | `@chemdraft/plugin-host` | `PluginHost`: registration, permission gating, command invocation, contribution enumeration, subscriptions, selection snapshotting, `AnalysisStore`, panel-close hook. **React-free.** |
| Desktop runtime | `apps/desktop/src/plugins/` | The one persistent runtime, the report renderer, the panel surface, menu adaptation, diagnostics, staleness. |
| Plugins | `examples/plugins/*` | Manifests + command handlers. Ship data (declarative reports), never framework components. |

## Persistent host

The A5a broker and owner/view split are described in [runtime-broker.md](runtime-broker.md).
Production desktop constructs one `createPluginRuntimeOwner` service only in the hidden `runtime`
webview. `runtimeHostSession` awaits document core definitions before constructing it;
`runtimeDocumentSession` / `usePluginRuntimeView` give MainWindow detached snapshots and explicit
private-native-broker actions. Host startup failure leaves drawing usable and reports a specific
plugin error, with no local replacement owner.
Its host-shaped read facade is not a PluginHost and its controller-shaped sources contain only
snapshot getters, subscriptions and action proxies. The compatibility `usePluginRuntime` hook
uses the same owner factory for existing local embeddings/tests; the browser preview retains its
explicit `localPluginRuntime` embedding.

The owner creates the runtime and bundled workers once, and owns installed reload/update,
recognition, naming, prompt, image, external-tool and assistant controllers. Production plugin
commands capture their document target through `RuntimeBrokerDocument`; naming, layout, recognition
preparation and table placement read that invocation's document/selection/viewport through messages.
The owner registry keeps plugin handlers; the document registry keeps core handlers and contribution
proxies. Core definitions and invocations cross the broker as data. Edits, selection, viewport, undo
and view remounts never recreate the runtime. Assistant lifecycle, contexts, extra-tool invocations,
history and gesture-gated write preparation now use captured-target broker messages. The source
document retains its transaction manager and synchronous final commit; naming/external-tool
dialogs open through that document's coordinator using data requests/replies. View/preview reads
and core definitions use asynchronous initialization or received snapshots. A5a's data adapters
and native routing/grants/hidden-host startup are complete. The host has narrowly scoped service
grants; native file pickers and utility suspension remain document-owned.

MainWindow retains the document-write port, history, gesture waiting, page-fit consent and
synchronous commit. Proposal preparation stays local; asynchronous acceptance reserves the pending
proposal, sends a one-use document commit receipt, then resolves it after the local final checks and
history commit succeed. Failure leaves the proposal pending. See
[the adapter review](runtime-broker-a5a3-review.md) for A5b per-document presentation seams and coordinator native verification.

Plugin storage survives updates and bundled/installed id handovers; explicit Uninstall clears the
stored file and session cache after teardown and catalog removal, reporting deletion failures after
completing uninstall (including its UI entry and disabled preference).

## Capability APIs (permission-gated, optional)

The command context exposes capabilities as optional properties, present only
when the manifest declares the matching permission (ADR-0008). A handler sees
`undefined` otherwise — it never throws for a missing capability.

- **`selection`** (`selection.read`) — `getSelection()` returns an immutable,
  deep-frozen snapshot (the host `structuredClone`s + freezes it, so a plugin can
  mutate neither host state nor a later caller's copy). Each molecule carries a
  `structureFormat`, `documentId`/`pageId`, and a `sourceFingerprint`
  (FNV-1a over identity + payload — a synchronous change detector, not a
  molecular hash).
- **`analysis`** (`analysis.write`) — `write` / `list` / `getLatest` over an
  in-memory, session-scoped `AnalysisStore`. The host stamps id / plugin id /
  time, deep-copies in and out, and **scopes a plugin's reads to its own
  records**; trusted desktop code reads all via `host.listAnalysis`. Records
  never enter the native document.
- **`panels`** (`ui.panel`) — `showReport(panelId, report)` pushes a validated,
  declarative `PluginPanelReport`.
- **`documents`** — read + `proposePatch` (queued for user approval).
- **`images`** (`image.read`) — command-scoped `requestImage`; the host owns source selection,
  validates a strict result, and caps inputs at 25 MB / 8192 pixels per side.

## Declarative panels (no plugin React)

Plugins describe results as data — a `PluginPanelReport` of `text` / `keyValue` /
`table` / `svg` sections — and the desktop's single `PluginReportRenderer` draws
them with core UI. SVG travels as a string rendered through an `<img>` data URL,
so embedded script can never execute and the plot is theme-isolated. A report may
carry an optional `source: { objectId, sourceFingerprint }`; desktop chrome
compares it against the live document (`computeObjectFingerprint`) and shows a
**stale** banner when the structure changed since the report was computed.

On desktop, a report goes directly to its own native analysis window, keyed by
plugin id plus panel id. Several reports may remain open at once; none render in
the main drawing viewport. `PluginPanelWindow` is also the host for core-owned
Molecular Inspector, validation result, bundled-plugin diagnostics, and plugin
proposal review snapshots. They all reuse `openPluginPanelWindow` and the same
request/replay event bridge; interactive actions travel back to the main window,
where the document lives; plugin actions then cross the private runtime broker. The native windows are children of
the main document window, not global always-on-top panels, and retain their
session position when hidden and reopened. The in-app `PluginPanelSurface` and
proposal tray are web-build fallbacks only.

Panel webview focus requests use generations and a native page epoch to reject stale requests.
Native focus events carry a generation, but no page epoch. Each trusted click advances the
generation immediately, so a delayed loss from the preceding activation cannot clear the new
interaction. The input handler validates loss notifications once and shares accepted deactivation
with consumers such as Export. Requests can focus the webview only while the panel is already
active; they cannot activate a panel after the user has switched windows. A newly built panel whose
native focus/resize hooks fail is destroyed and its open request fails.

The document window hides a panel through `hide_plugin_panel_from_main`, which restores a
full-size panel's normal frame on the main thread before hiding it. That command is granted to the
main window only (`capabilities/plugin-panel-hide.json`).

Analysis windows hold no dialog, filesystem, or clipboard permission
(`capabilities/plugin-panel.json`), and must not gain one. Anything that needs
one is performed by the main window on the window's behalf:

- **File saves** (the NMR figure's JCAMP-DX export): `saveTextFile` detects the
  `?window=pluginPanel` route and sends a `saveTextFile` analysis-window action;
  the main window shows the save dialog, writes the file, and answers on
  `chemdraft://analysis-window-action-result` with `saved` / `cancelled` /
  `failed`, keyed by request id, so the button reports what really happened.
- **Copy** from the floating Molecular Inspector goes through the native
  clipboard command, because the web Clipboard API refuses a write that arrives
  over the event bridge without a user gesture in the main document. A failed
  write is reported as a failure.

Native code stamps analysis-window actions with the caller's `sourceLabel`; the main window
authorizes each action for its owning window and sends replies only to that window. The main
window registers its listener once and reads its live handlers through a ref, so no action can
fall into a re-registration gap when the document changes.

**Focus.** Panels are built and shown without activating them, so opening, revealing,
or updating a report leaves focus in the document. The old `focus` hint is ignored.
A user click activates the panel, preserving its current OS focus until the user switches windows
or closes it. Editable controls own editing and navigation keys; Enter in a single-line control,
Escape and Tab can end DOM editing without returning OS focus. Menus own their keyboard navigation
and buttons keep activation/navigation keys. Selected report text keeps Copy, Select All, modifier
keys and Shift navigation local, including ranges extended into panel chrome. Any key ending that
selection is consumed, including Delete, Backspace, cut, paste and history shortcuts; it never also
edits the drawing. Escape dismisses an open Export menu first, then Full size, then DOM editing or
report selection before panel close.
Other recognized shortcuts are forwarded to the document through the live command catalog without
moving focus. Close accelerators (Alt+F4 on Windows and Cmd+W on macOS) stay local and close only
the panel. Browser reload defaults are suppressed before selection handling, including shifted
reload chords; an otherwise unclaimed panel key can still invoke a registered drawing shortcut
such as Ctrl+R for rulers.

Each panel's frame is saved relative to its monitor. Resize grab zones extend 6 logical
pixels inside the border along every edge and corner. Full size uses the caller-bound native
`set_plugin_panel_full_size` command and restores the previous frame on exit. The proposal
window is marked open only once its native open succeeds, so a failed open leaves the
pending-proposals badge in place.

**Escape.** A report window closes on a bubbling window-level Escape unless the event was
already `defaultPrevented`. The linked figure handles Escape first in Full size, restoring
the panel's previous frame. Escape in an editable control blurs it, and Escape with report
text selected clears the selection; a subsequent Escape can close the panel.

## Menu integration + drift test

Plugin menu contributions become app-menu items via `pluginMenuModel`, tagged
`pluginContributed`. That flag excludes them from the *static core*
`nativeRoutedCommandIds` drift test. The desktop separately sends every dynamic
item — target location and enabled state included — to the native menu bridge;
clicks return through the same `plugin.*` command route used by the web menu.

## Panel actions, canvas overlays, and the Plugins menu

Interactive panel controls do not invoke a command from their detached webview. The action path is
panel window → `chemdraft://plugin-panel-action` → the main-window resolver → `invokeCommand` with
validated `input` → `chemdraft://plugin-panel-action-result`. `requestPluginPanelAction` waits at
most 10 seconds. Desktop panels use the Tauri event bridge (addressed to the main window); the web
build uses the same named `CustomEvent`s. The main window keeps one listener and resolves each
request against its current report and plugin ownership before invoking the command, so the message
itself cannot choose a command id, payload, options, or length limit. It acknowledges acceptance
without waiting for command completion, allowing an independent Stop command while a submit runs.

The report renderer owns prompt, action, and image rendering. A prompt's textarea is kept through a
report replacement, stays enabled to retain input focus, and clears its draft only after
the main window accepts the action. Replacement autoscrolls only when the reader was at the bottom,
or after that reader submitted; a report with a prompt hides the generic Run again action.

`canvasOverlays` are host-rendered document-viewport chrome, not plugin React. The runtime permits
one declaration per plugin and requires `ui.canvas`. The collapsed icon expands to the same prompt
control, status line, and optional panel opener; its submissions are resolved by the same action
path with `context.input.source = "overlay"`. Both the icon and expanded header are draggable; an
icon click expands only if it has not moved at least four pixels. Each mode persists its own position
per window and overlay id. Moving the icon anchors the next expansion nearby; subsequent expansions
restore the box's saved position. Both positions clamp to the drawing area on resize, and the box is
at most 300 px wide, further limited by that area's width and height. The overlay hides during canvas
gestures and export, and Esc collapses it
and returns focus to the drawing. It takes keyboard focus only after a click. `overlays.setStatus`
is the permission-gated host capability that supplies the status line.

The overlay's panel link invokes the panel contribution's `commandId`, which must publish its report.
For packages omitting that optional field, the host also accepts a unique owned menu command with
the same title (ignoring a trailing ellipsis). It never picks an unrelated command. A reportless panel
with no resolvable opener produces a specific status message instead of an empty native window.
Existing report-only panels can still reopen their cached detached content.

Native menu contributions at location `plugins` form the dedicated Plugins block, appended after a
separator in `plugins_menu`. The same native builder supplies macOS and Windows; the other standard
locations (`file`, `edit`, `view`, and `tools`) remain web-only.

## Worker pattern

Each analyzer plugin runs in its own lazy ES-module Worker through
`PluginWorkerBridge`. A versioned `ready` handshake must complete before
registration; startup has a finite timeout, invocation/capability messages carry
request ids, and `terminate()` rejects startup plus every command in flight.
Disable, uninstall, failed install, startup cancellation, and successful package
replacement all perform that teardown. Installed worker responses allow only
same-origin code/data/network access; external network access cannot bypass the
manifest capability layer.

On Windows/WebView2, a nested module worker's main-script request to `http://tauri.localhost`
can be aborted even when the server returns 200. Installed plugins therefore start through a
host bootstrap selected by `__chemdraft_worker_bootstrap=windows` on their existing entry URL.
The native handler validates and reads that entry as usual, then serves the dependency-free
`workers/nestedModuleWorkerShim.js` and dynamically imports the original entry after installing
the shim. Dynamic import ensures even transitive plugin dependencies see the shim before
executing. On Windows, the bundled plugin worker uses a separate bootstrap that installs the
same shim before importing its original worker entry; macOS and web builds retain the original entry.

The shim proxies only construction of same-origin module workers on the Windows desktop
custom origin. It returns a real native Worker with the original options, using a blob containing
`import "<absolute URL>"; URL.revokeObjectURL(import.meta.url);`. The imported module keeps its
real URL for sibling assets. The blob is revoked after module evaluation; construction or load
errors also revoke it without consuming the native error event. A worker terminated before
evaluation can retain its blob until the creating worker exits. Platform selection is injectable
for tests and otherwise detected. macOS and web builds keep native worker construction, as do
classic, cross-origin, opaque, and credential-bearing URLs.

On Windows this supports one nested-worker level: the plugin worker can start a nested module
worker, but a worker started from inside that nested worker (depth 2 or greater) is not supported.
The blob wrapper does not reinstall the shim, so deeper nesting uses native construction and may
fail under WebView2.

The bootstrap response retains `INSTALLED_PLUGIN_WORKER_CSP` verbatim. Starting the plugin
itself from a page-created blob would inherit the page's broader CSP, so that approach is avoided.
Nested blobs inherit the installed worker's restrictive CSP; their static imports still obey
`script-src 'self'`, and worker construction still obeys `worker-src 'self' blob:`. Neither the
bootstrap query nor the shim grants host capabilities or bypasses manifest permissions.

## Panel-close lifecycle (ADR-0012)

`RegisterPluginOptions.onPanelClosed(panelId)` lets a plugin cancel in-flight work
when the desktop closes its panel. `PluginHost` stores that handler for the
registration and invokes it for a real panel-close signal. For worker-routed plugins,
`PluginWorkerBridge` forwards the signal to the worker; the plugin can then stop its
work, and a late result cannot revive the dismissed panel. Disable and uninstall close
the panel while the plugin is still registered, so that lifecycle hook runs before
teardown.

Closing a native plugin report window sends the same real panel-close signal.
Closing a core analysis window only hides that host-owned surface; invoking its
Analyze command reopens it with the latest cached snapshot. Proposal review
opens when the queue gains a proposal and hides when the queue becomes empty.

## Command error channel (ADR-0010)

A command may fail by throwing **or** by returning `{ ok: false, error }`. The
desktop's dispatch surfaces both in the status bar, so a returned not-ok result is
never silent.

## Image input

No image-input plugin is bundled. MolScribe OCSR is an official plugin installed from its own
repository (`jgassens/ChemDraft-MolScribe-Plugin`) through the host catalog; it reaches the host-managed
engine through `recognition.recognizeStructure` (see `ocsr-engine.md`). Host tests drive the same path —
manifest → host → Analyze menu → provider registry → user-selected image → recognition → proposal — with
the test-only fixture in `apps/desktop/src/testSupport/recognitionFixturePlugin.ts`. Mock recognition
stays test-only.

## Extension points

Adding a plugin is one import + one `registerPlugin` call in
`registerBundledPlugins`. New report section kinds, capability APIs, and
contribution enumerators are additive to `plugin-api`/`plugin-host`; the desktop
report renderer is the single place UI is added, once, for all plugins.
