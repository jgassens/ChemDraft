# ADR-0003: Canary-first runtime bring-up with molscribe-ocsr

- **Status:** accepted
- **Date:** 2026-07-07 (codified from PLANS.md)
- **Source:** PLANS.md "Runtime milestone before NMR"

## Context

ChemDraft has plugin schemas, a `PluginHost` package, and five example plugin
packages — but no functioning desktop plugin runtime: the desktop never
instantiates `PluginHost` (verified 2026-07-07 @ 64cf513e), no plugin is
mounted, no report renderer exists, no plugin menu items render, no plugin
list exists. Building the runtime *and* the NMR plugin in one motion would
make every failure ambiguous (runtime bug vs. chemistry bug vs. dependency
bug).

## Decision

Bring the runtime up first using the existing `molscribe-ocsr` package as a
canary (M1–M3, assignment 01). The canary's command just pushes a trivial
panel report; OCR itself is explicitly out of scope. NMR work may not start
until `manifest → host → Analyze item → command → rendered report` is proven
in the running desktop and in tests.

## Consequences

Runtime defects surface against a dependency-free plugin. The NMR plugin
(M6+) lands on proven rails, and every later plugin (mass-fragment is
queued) gets the same rails free. Cost: one assignment of work before any
NMR-visible progress — accepted deliberately.
