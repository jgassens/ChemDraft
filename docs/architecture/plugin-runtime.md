# Plugin runtime architecture

How ChemDraft hosts bundled plugins: the persistent host, the generic
capability APIs, the declarative panel model, menu integration, the worker
pattern, and the panel lifecycle. The NMR predictor is the first real consumer; the
MolScribe OCSR plugin (installed, not bundled) is the image-input consumer. Everything here is domain-neutral — no
NMR (or any domain) concepts leak into `plugin-api` / `plugin-host`.

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

## Panel-close lifecycle (ADR-0012)

`RegisterPluginOptions.onPanelClosed(panelId)` lets a plugin cancel in-flight work
when the desktop closes its panel. The NMR registration shares one
`AbortController` across the command and `onPanelClosed`: a new prediction
supersedes the prior; closing the panel aborts the active one; replacing it with a
different plugin/panel is also treated as a close; and the command
re-checks `signal.aborted` after the predictor resolves, so a late result never
writes a record or resurrects a dismissed panel.

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
