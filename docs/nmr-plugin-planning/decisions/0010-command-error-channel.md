# ADR-0010: One canonical, user-visible command error channel

- **Status:** accepted & implemented (M8, 2026-07-08 — `MainWindow` inspects the resolved plugin-command result and surfaces `{ ok: false }` like a throw; see reports/0005)
- **Date:** 2026-07-07
- **Source:** gap found building M1–M3 (reports/0001)

## Context

A plugin command can fail two ways today, and they behave differently:

1. **Throw** — the desktop `invoke` path catches it and shows
   `Plugin command failed: <message>` in the status bar.
2. **Return `PluginCommandResult { ok: false, error }`** — this resolves
   normally; nothing in the host or desktop inspects the return value, so the
   user sees **nothing**.

Nothing enforces or consumes `PluginCommandResult`; even the molscribe example
returns a raw domain object, not a result union. The planned NMR command
returns typed not-ok results (`NMR_NO_SELECTED_STRUCTURE`,
`NMR_MULTIPLE_SELECTED_STRUCTURES`, …). With today's wiring, clicking "Predict
NMR" with nothing selected would silently do nothing — the worst outcome for a
scientific tool.

## Decision

Make user-visible failure independent of which channel a plugin uses:

- The desktop plugin-command dispatch inspects the resolved value: if it is a
  `{ ok: false, error }` result, surface `error.message` (and code) the same
  way a thrown error is surfaced.
- A thrown error remains a valid failure and is surfaced as today.
- The NMR command may use either channel; both reach the user.

Optionally the host may normalize thrown errors into a `PluginCommandResult`
so callers see one shape, but the desktop must handle both regardless.

Implement when the first command that returns `ok: false` lands (M8); do not
build the plumbing before there is a consumer.

## Consequences

No silent command failures. Plugins keep the ergonomic choice of throw vs.
return. Cost: the dispatch path grows a small result-shape check. Revisit only
if a richer error surface (inline panel errors, toasts) is wanted — that is
additive to this decision, not a replacement.
