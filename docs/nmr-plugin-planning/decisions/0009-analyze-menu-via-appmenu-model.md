# ADR-0009: Analyze menu via the existing appMenu model + drift-test exclusion

- **Status:** accepted (validated in assignment 01 / M2, 2026-07-07 — the `pluginContributed` exclusion shipped and the native-menu drift test stays green; see reports/0001)
- **Date:** 2026-07-07
- **Source:** plan review; repository verification of `appMenu.ts` / `appMenu.test.ts`

## Context

The plan left menu integration open between (A) adapting plugin
contributions into the existing menu model and (B) a separate plugin-owned
Analyze menu surface. Verification settled the facts: an Analyze section
already exists in `apps/desktop/src/appMenu.ts` (one core item,
`chemistry.validateSelection`); the web menu bar deliberately mirrors the
native Tauri menu one-for-one, enforced by a drift test that reads
`MENU_COMMAND_IDS` out of `src-tauri/src/lib.rs`; the model already has a
per-item exclusion mechanism (`nativePredefined`) for deliberate
differences; and the native layer already builds dynamic menus for toolsets
(`create_app_menu_for_toolsets`).

## Decision

Design A, concretely: the desktop adapts
`PluginHost.listMenuContributions("analyze")` into `appMenu.ts` items marked
`pluginContributed: true`, excluded from the native-sync comparison the same
way `nativePredefined` items are. Selection dispatches through
`PluginHost.invokeCommand` (permission checks apply), not the core command
path. Native-menu support for plugin items may follow later using the
dynamic-toolset-menu approach; until then plugin items are web-menu-only and
the gap is documented. A separate plugin-only menu surface (B) is rejected:
it duplicates rendering, keyboard handling, and native-sync machinery.

## Consequences

One menu system, consistent styling and shortcuts, no new surface. The
drift test stays meaningful for core items. Risk to validate in assignment
01: the exclusion must not mask genuine core-menu drift, and menu context
(enabled-state) for plugin items is host-derived or omitted in Phase 1.
Accept or revise this ADR from assignment 01's report.
