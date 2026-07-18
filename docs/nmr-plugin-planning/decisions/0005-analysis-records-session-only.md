# ADR-0005: Analysis records are session-only derived data

- **Status:** accepted
- **Date:** 2026-07-07 (codified from PLANS.md)
- **Source:** PLANS.md "Generic analysis storage" / AGENTS.md "Analysis API rules"

## Context

Predictions could be stored in the native ChemDraft document (persistent,
undoable, shareable) or held as session state. Document storage entangles
the document schema with every analyzer's payload, gives plugins a path to
mutate user files, complicates undo, and forces schema-versioning of
speculative data. The repo's existing pattern for plugin→document writes is
the proposed-patch queue with explicit user approval — derived analysis is
not that.

## Decision

Phase 1 analysis records live in an in-memory, host-owned `AnalysisStore`:
host-stamped (record ID via injectable factory, plugin ID, injectable-clock
timestamp), deep-copied in and out, queryable, subscribable, unbounded,
gone at session end. The NMR plugin gets **no** document permissions
(`document.read`/`write`/`proposePatch` all unrequested). Rerunning creates
a new record; old records are never mutated. Read policy: a plugin reads its
own records; trusted desktop code reads all; no cross-plugin reads without a
future explicit permission.

## Consequences

The document format stays clean; plugins can't corrupt user files; staleness
is handled by fingerprint comparison instead of document coupling. Cost:
predictions don't survive restart or travel with the file — a future
"persist analysis" feature would need its own design (document sidecar or
plugin storage) and would supersede the unbounded-growth stance too.
