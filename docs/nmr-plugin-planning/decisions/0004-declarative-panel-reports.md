# ADR-0004: Declarative panel reports, never plugin UI components

- **Status:** accepted
- **Date:** 2026-07-07
- **Source:** repository verification (plugin-api `PluginPanelReport`, commit 64cf513e); plan revised to match

## Context

The original plan proposed a desktop React panel registry mapping
`(pluginId, panelId) → React.ComponentType`. Repository verification found
the repo had already decided otherwise: `packages/plugin-api` defines a
declarative `PluginPanelReport` (text / keyValue / table / svg sections, svg
≤ 512 KB rendered in an `<img>` context "so scripts can never execute"), and
`PluginHost` already validates and routes reports via `showPanelReport`.
The two designs are incompatible: one lets plugins ship arbitrary UI code,
the other makes plugin output inert data.

## Decision

Adopt the repository's model everywhere. Plugins compose reports as pure
data (pure functions — unit-testable in Node); the desktop owns the single
renderer plus all chrome (title, close, run-again). Interactivity beyond
chrome is added, when needed, as new *declarative* section kinds (first
candidate: `actions` items bound to commands the same plugin contributes) —
never as plugin-provided components. The NMR "panel" is therefore report
composition in a `report/` module; the plugin package has no React
dependency at all.

## Consequences

Security and sandboxing posture improves ahead of any dynamic-plugin future;
report rendering is written once for all plugins; plugin UI is trivially
testable. Cost: rich interactivity (the ¹H toggle, live controls) must wait
for section-kind extensions or be expressed as separate commands — accepted
for Phase 1 (see D-03 in STATUS.md). Supersede only with a deliberate,
security-reviewed decision — this is the load-bearing boundary for untrusted
plugins later.
