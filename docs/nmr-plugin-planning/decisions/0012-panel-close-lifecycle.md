# ADR-0012: Panel-close lifecycle and closed-panel report policy

- **Status:** accepted & implemented (M9, 2026-07-08 — `onPanelClosed` host hook + shared `AbortController` in the NMR registration + post-predict `signal.aborted` check; see reports/0006)
- **Date:** 2026-07-07
- **Source:** gap found building M1–M3 (reports/0001)

## Context

Plugins can push panel reports but can never learn a panel closed. Two problems
follow once work is asynchronous (M7 worker):

1. PLANS says "closing the panel cancels the active request," but a plugin has
   no close signal to cancel on.
2. `PluginPanelController.showReport` unconditionally opens/replaces the panel.
   A late worker result arriving after the user closed the panel would
   **resurrect a panel they just dismissed**.

Neither mattered for the synchronous canary (report pushed and rendered in one
tick), so M1–M3 shipped without addressing it. Both matter the moment the NMR
predictor runs in a worker.

## Decision

Two additions, implemented when the worker lands (M7):

- **Close notification.** Registration options gain an optional
  `onPanelClosed(panelId)` hook (alongside `commandHandlers`). The desktop panel
  controller calls it when the user closes a contributed panel, giving the
  plugin its cancellation trigger.
- **Closed-panel report policy.** A report for a panel that is not currently
  open is **delivered but does not reopen** the panel (the plugin's state is
  updated; the UI is not resurrected), and a superseded/stale request's late
  report is dropped with a diagnostic. The controller tracks whether the target
  panel is the currently-open one before rendering.

## Consequences

Async cancellation has a real trigger; a dismissed panel stays dismissed.
Keeps the "desktop owns chrome/lifecycle, plugin owns data" split — the plugin
learns *that* a panel closed, not *how* chrome works. Cost: the controller
gains open/closed bookkeeping and one more registration hook. If multiple
simultaneous panels arrive later, this policy generalizes per-panel rather than
being replaced.
