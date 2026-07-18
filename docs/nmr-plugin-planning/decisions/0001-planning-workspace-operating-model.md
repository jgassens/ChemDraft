# ADR-0001: Planning-workspace operating model

- **Status:** accepted
- **Date:** 2026-07-07
- **Source:** initial plan review (reports/0000)

## Context

The NMR plugin is ChemDraft's first *live* plugin and the first of several
planned analyzers. The user's existing workflow runs one worktree/clone per
feature (`chemdraw-toolbars`, `chemdraw-structure inspector`, …), each
carrying branch-specific `AGENTS.md`, `PLANS.md`, and `CODEX_PROMPT_NN`
files, with implementation done by coding agents against bounded prompts.
That workflow had no durable home for: which assumptions were verified and
when, what each assignment actually produced, why decisions were made, or
what the next prompt should say. Plans silently rotted as `main` moved
(this review found the plan's selection-API and panel assumptions already
stale).

## Decision

`~/Documents/programming/Chemdraw-NMRplugin` is the control room, separate
from any implementation worktree:

- `PLANS.md` + `AGENTS.md` — masters of the docs that get dropped into the
  feature worktree;
- `prompts/NN-*.md` — one bounded assignment per milestone group, stamped
  from `prompts/TEMPLATE.md`;
- `STATUS.md` — milestone table, assumption ledger (every repo assumption
  with verdict + evidence + verification commit), open decisions, risks;
- `decisions/` — ADRs; `reports/` — archived agent reports, numbered to
  match prompts.

The loop: draft prompt → issue against the worktree → archive report →
update STATUS + ADRs → fix PLANS/AGENTS if contradicted → next prompt.

## Consequences

Every future plugin can clone this directory shape and inherit the process.
Assumption rot is caught at prompt-issue time (the ledger says what to
re-verify). Cost: the workspace must actually be updated after each report —
if STATUS.md goes stale the system degrades to what it replaced. Supersede
if the docs move wholesale into the ChemDraft repo itself.
