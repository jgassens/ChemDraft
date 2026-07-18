# ADR-0027: Core-owned plugin manager; disable means unregister; package install deferred

- **Status:** accepted (2026-07-12)
- **Source:** M32 (user-directed)
- **Builds on:** [[0003-canary-first-runtime-bringup]], [[0009-analyze-menu-via-appmenu-model]], [[0012-panel-close-lifecycle]], [[0016-plugin-native-menu-bridge]]

## Context

ChemDraft now ships three statically bundled plugins, but the only user-facing inventory was the
diagnostics panel. Bundled JavaScript is compiled into the desktop application; there is no package
format, signature policy, installer, or dynamic loader yet. A manager must therefore be honest about
the boundary while still letting a user remove a plugin from the live runtime.

`PluginHost` already owns registration, unregistration, command contributions, and change
subscriptions. The desktop already re-derives web and native Analyze menus from that registered set.
The missing pieces were a durable catalog of compiled plugins, a persisted enabled policy, and a
core-owned management surface.

## Decision

1. Add a core `Plugins` menubar section with `plugins.manage` / **Add or Remove Plugins…**. The
   command is routed through the same core command registry in web and native menus.
2. The desktop exposes an ordered, runtime-scoped catalog of bundled descriptors: manifest plus
   registration options. The manager renders this catalog generically and uses `PluginHost` only as
   the live enabled-state source. Disabled plugins therefore remain visible and can be re-enabled.
3. **Disable/remove means unregister.** Enabling re-registers the same manifest and handlers. The
   reconciliation operation is idempotent and changes only bundled descriptor IDs.
4. If a plugin owns the open report panel, close that panel before unregistering it. This preserves
   the existing `onPanelClosed` cancellation hook and avoids a dead Run-again action.
5. Persist disabled IDs as a sorted JSON array under `chemdraft.plugins.disabled` in `localStorage`.
   Storage is best-effort and safe under SSR, blocked storage, or malformed data.
6. Package installation is explicitly deferred. The manager shows a disabled **Add plugin from
   package…** button and an inline note naming the later plugin-packaging milestone. It does not open
   a file picker or simulate installation.

## Consequences

- Enable/disable is live: contributed commands and Analyze-menu entries appear or disappear without
  reloading the desktop.
- The generic host remains framework-free and unchanged; React UI and persistence stay in the
  desktop integration layer.
- Plugin storage, proposal history, and session analysis records survive unregistration, matching
  the host's existing lifecycle policy.
- Preferences are local to one browser/webview profile. Cross-device synchronization and managed
  policy are outside M32.
- A real package installer still requires a package format, provenance/signature policy, extraction
  boundary, dynamic-loading model, and a separate packaging milestone.
