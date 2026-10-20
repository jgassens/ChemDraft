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

`usePluginRuntime` creates exactly one `PluginHost` via a lazy `useRef`, and
registers bundled plugins once inside that guard (StrictMode-safe). The active
document and selection reach the host through **provider callbacks**
(`() => documentRef.current`, a selection-snapshot builder), so the host is
**never rebuilt** when the document, selection, page, viewport, or undo history
changes. Core and plugin commands share one stable `CommandRegistry`; core
bindings are synchronized in place as state changes. React re-renders on
host/panel changes via subscriptions.

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
where the document and plugin runtime live. The native windows are children of
the main document window, not global always-on-top panels, and retain their
session position when hidden and reopened. The in-app `PluginPanelSurface` and
proposal tray are web-build fallbacks only.

Panel keyboard focus is a native-ended lease. Repeated input clicks may queue acquisitions,
but loss or failure of the outstanding lease cancels its queued retries; an older generation
also ends a successor that has not settled yet. Once that successor settles, obsolete native
events cannot end it. Report-text selection leases end when their range collapses or leaves
report text, or on a trusted key other than a copy/select-all, extension, or modifier key.
At the start of a panel webview load, native generations reset alongside the
JavaScript counter; a native epoch prevents queued work from the old page matching reused
generations. A newly built panel whose native focus/resize hooks fail is destroyed and its
open request fails.

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

The main window registers its analysis-window action listener once and reads
its live handlers through a ref, so no action can fall into a re-registration
gap when the document changes.

**Focus.** Opening or revealing a panel keeps keyboard focus in the document,
including Analyze commands and automatic report updates. The old `focus` hint
is ignored. Ordinary clicks, buttons, charts, hovering, scrolling and window
drags behave like floating toolbars. A trusted click on an editable control
borrows keyboard focus until Escape, committing single-line Enter, Tab out,
clicking elsewhere or loss of window focus. A deliberate drag or double/triple
click selecting non-empty report text borrows the same focus so native Cmd/Ctrl+C
copies it; a plain click or scripted selection does not. Clicking elsewhere,
clicking the document or Escape clears the text selection and returns focus.
During a selection lease, Cmd/Ctrl+C, Cmd/Ctrl+A, Shift+arrow/Home/End and bare
Shift/Control/Alt/Meta keep the lease. Any other trusted non-composing key (including
plain arrows, Home/End/PageUp/PageDown, letters, digits, Tab, Enter and Space) clears
the selection and returns focus for the following drawing shortcut. This does not
depend on the browser collapsing the range: WebView2 may scroll instead. Only the
scrolling keys (arrows, Home/End/PageUp/PageDown and Space) have their default action
prevented on release to avoid moving the report. Escape retains its handling below;
input leases retain their normal editing and navigation behavior.
Windows only lends focus while ChemDraft already owns the foreground, using
thread-local activation without synthesized input; background requests are dropped.
WebView2 can activate the panel on a content click despite `WS_EX_NOACTIVATE` and
`WM_MOUSEACTIVATE`. Windows therefore mirrors the toolbar's explicit hand-back:
`PaletteWindow` → `sendPaletteCommand` / `routeToolsetCommand` → native
`route_toolset_command` returns focus after dispatch. Panels use their existing
caller-validated `set_plugin_panel_input_focus(false)` after trusted non-lease
pointer releases/clicks, even when no lease was previously active. Unlike the
toolbar's force-focus route, this hand-back uses guarded `SetActiveWindow` followed
by document **webview** focus, never Tao's forced activation or synthetic Alt.
Report-text drags finish before the hand-back decision; double/triple clicks decide
selection before queuing it. Input and selection leases suppress this hand-back.
Click hand-back requires a matching trusted pointerdown in the same gesture; keyboard
activation never queues it. Focus requests carry monotonically increasing webview-local
generations, including across effect remounts, and remain serialized through native completion.
The caller-validated command returns a boolean: true only when that generation acquired
keyboard focus, false when the foreground/visibility guard dropped it, activation failed,
or a native deactivation cancelled it. JavaScript immediately ends a rejected lease.

Native code owns lease validity. IPC registers the generation before queuing its main-thread
acquisition, so a real deactivation while acquisition is queued cancels it before it can restore
focus. Windows observes the panel's own WM_ACTIVATE and WM_ACTIVATEAPP; macOS observes
NSWindowDidBecomeKeyNotification and NSWindowDidResignKeyNotification synchronously.
The panel receives one chemdraft://plugin-panel-focus event with { kind, generation },
subscribed through listenCurrentWindowEvent / safeTauriListen **before** acquiring.
A deactivated event for the current lease is terminal, even if the acquisition reply arrives
later reporting success. Notifications from an older generation cannot end a newer lease.
Native activation requested by the lease is tagged with that generation; child-webview
focusout/blur is not native window deactivation. No DOM blur timer, hasFocus() check, DOM
focus recovery, or selectionchange guesses lease ownership. Escape, single-line Enter,
Tab out, a trusted click elsewhere, removal/disablement of the leased control, or removal
of the selected report text also explicitly end the lease. Hover and wheel alone do not.

The native command waits for its main-thread operation before replying, so an older hand-back
cannot execute after a newer request from that panel. Native non-client presses and
move/resize entry/exit end the lease and use the same guarded helper, restoring webview
focus after Wry's own focus handling as well. A transient Windows foreground change is
possible, as with toolbars; the panel must not retain the keyboard after an ordinary click.
For **idle activation only**, the webview defers hand-back 32 ms so an immediately following
trusted pointerdown can establish intent. That check never ends a lease and uses only the
request generation and pointer/selection gesture state. It covers activation after closing
another application without interrupting an active/pending lease or a chart drag.
The native foreground/document-group guard still runs when hand-back executes.

Windows uses **one resize mechanism**: Tauri's existing TAURI_DRAG_RESIZE_WINDOW overlay,
adapted to share screen-coordinate hit testing with its parent. There is no second resize
window and no WM_NCCALCSIZE override. Tao keeps its zero top non-client inset on Windows 10
(necessary while WS_CAPTION remains set), and its DPI-scaled one-pixel top inset on Windows 11.
The top hit band is the panel's current-DPI `SM_CYSIZEFRAME` (`SM_CYFRAME`) plus
`SM_CXPADDEDBORDER`, measured in physical pixels from the outer window top, just like the
native side/bottom resize borders. Only that band returns HTTOP/HTTOPLEFT/HTTOPRIGHT;
below it, the title interior reaches WebView2's DOM drag handler (HTTRANSPARENT on the
overlay, HTCLIENT on the parent). Side/bottom edges retain their proper directions.
The same overlay's input region covers the client portion of that band, subtracting Tao's
actual top inset. Updating hit testing alone is insufficient: Tauri 2.11.2 otherwise clips
the overlay to SM_CYFRAME without the padded border. The adaptation refreshes this region
after Tauri's size handling, on DPI/settings changes, and on the overlay's position/region
notifications, including asynchronous sizing and shadow updates. Equal regions are left
alone to avoid recursive SetWindowRgn notifications. Windows owns each installed region.
WebView2 fills the whole client, without a second inset or exposed parent-client margin.
Tauri still owns the overlay's window size and lifetime; no new window, painted border,
caption, or WM_NCCALCSIZE adjustment is introduced. Maximized windows have no resize grip.
Portable geometry tests cover Windows 10/11 client origins at 100%, 150%, and 200% DPI,
each physical row of the top band, corner boundaries, title pass-through, negative monitor
coordinates, and the empty maximized region. Native visual/input checks remain in the
[manual stress checklist](../manual-stress-checklist.md).
macOS makes the nonactivating panel key without activating the application and
rejects background acquisition. A click on a panel or analysis window while another app is
frontmost does activate ChemDraft on macOS (the drawing stays key; a clicked menu opens):
`NonactivatingPanel` is set on Tao's `NSWindow`, and AppKit honours it only for `NSPanel`.
This is accepted as ordinary Mac behaviour (owner decision, 2026-10-20); Windows keeps the
other app in front. Neither platform activates ChemDraft without a click. The proposal window is marked open only once its native open
succeeds, so a failed open leaves the pending-proposals badge in place.

**Escape.** A report window closes on a bubbling window-level Escape unless the
event was already `defaultPrevented`. An inner overlay (the linked figure's
Full size view) handles Escape in the capture phase and prevents the default,
so the first Escape closes the overlay. An active input or text-selection lease
respects that prevented event; the next Escape releases the lease without closing
the panel. Without a lease, the next Escape closes the window.

## Menu integration + drift test

Plugin menu contributions become app-menu items via `pluginMenuModel`, tagged
`pluginContributed`. That flag excludes them from the *static core*
`nativeRoutedCommandIds` drift test. The desktop separately sends every dynamic
item — target location and enabled state included — to the native menu bridge;
clicks return through the same `plugin.*` command route used by the web menu.

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
