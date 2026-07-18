# ADR-0008: Extend the existing selection API; keep optional context properties

- **Status:** accepted
- **Date:** 2026-07-07
- **Source:** plan review vs. repository verification (commit 64cf513e)

## Context

The original plan assumed no selection API existed and specified a new one
(`getSelectedStructures()` returning `PluginSelectedStructure[]`), with a
stylistic stance that permission-gated APIs should always exist on the
command context and throw `PluginPermissionError` when unauthorized. The
repository meanwhile shipped `PluginSelectionAPI.getSelection()` returning
`{ objectIds, molecules }` as a permission-gated **optional** context
property (`selection?`), with `selectionStorage.test.ts` pinning that a
denied plugin sees `undefined`. Same conflict for `panels?` and `storage?`.
Both conventions are defensible; having two of them is not.

## Decision

Extend the existing API in place; never introduce a parallel contract:

- keep the name `getSelection()` and the snapshot shape, adding
  `PluginStructureFormat` narrowing, `sourceFingerprint`, host-side
  deep-copy/freeze, and `documentId`/`pageId` where available (M4);
- keep the optional-property convention for all permission-gated context
  APIs, including the new `analysis?` (M5) — consistency with the shipped,
  tested contract wins over stylistic preference, per AGENTS.md's
  "repository is authoritative" rule;
- methods on a *present* API still re-check permissions and throw, as the
  existing implementation does.

## Consequences

M4 shrinks from "create an API" to "harden an API"; no churn in existing
tests' philosophy. Plugins must null-check (`context.selection?.`) — the
cost the original plan disliked — but they do so uniformly. Converting the
whole context to always-present throwing APIs remains possible later as one
deliberate breaking change across all APIs at once; doing it piecemeal
inside an NMR milestone is what this ADR forbids.
