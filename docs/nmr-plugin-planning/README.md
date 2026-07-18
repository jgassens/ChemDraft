# ChemDraft NMR Plugin — Planning Workspace

The control room for building ChemDraft's **first live plugin** (an NMR
chemical-shift predictor) and, more importantly, the plugin runtime and
process that every later plugin reuses. No implementation code lives here —
implementation happens in a dedicated worktree of the ChemDraft repo.

> Naming note: the target app is **ChemDraft** (`~/Documents/programming/chemdraw`,
> `github.com/jgassens/ChemDraft`) — an independent open-source project.
> This folder's "Chemdraw" name is historical; do not infer the product name
> from it, and keep ChemDraw®-adjacent trade dress out of everything.

## The map

| File / dir | Role |
|---|---|
| [PLANS.md](PLANS.md) | Authoritative technical plan (verified against the repo 2026-07-07). Destined for the NMR worktree root. |
| [AGENTS.md](AGENTS.md) | Repo rulebook for agents on the NMR branch (build stamp, boundaries, conventions). Destined for the worktree root, replacing the previous branch's AGENTS.md per repo convention. |
| [STATUS.md](STATUS.md) | Where things stand: milestone table, **assumption ledger** (what was verified, when, with evidence), open decisions, risks. Start here every session. |
| [prompts/](prompts/) | One bounded assignment per milestone group. `01` is ready; `02` is drafted; the rest get stamped from `TEMPLATE.md`. |
| [decisions/](decisions/) | ADRs — the *why* behind the rules (ADR-0001…0009 so far). |
| [reports/](reports/) | Archived agent reports, numbered to match prompts. `0000` is the initial plan review. |
| [FIRSTPROMPT.md](FIRSTPROMPT.md) | Legacy pointer → `prompts/01-runtime-bringup.md`. |

## The loop

```text
draft/finalize prompt (prompts/TEMPLATE.md)
        ↓
re-verify STATUS.md assumption ledger against current main
        ↓
cut/refresh the implementation worktree; drop in AGENTS.md + PLANS.md
        ↓
issue the prompt to the coding agent
        ↓
archive its report under reports/
        ↓
update STATUS.md; graduate decisions to decisions/;
fix PLANS.md/AGENTS.md where the report contradicts them
        ↓
next prompt
```

Ground rules that make this work:

- **The repo outranks the plan.** When code and plan disagree, the plan gets
  fixed and the discrepancy gets a ledger row — never silently reshaped.
- **One active assignment at a time**, milestone-scoped, with named
  non-goals.
- **Every repo assumption a prompt relies on carries evidence** (file:line +
  commit) and gets re-verified before issue. Assumption rot killed v1 of
  this plan; the ledger is the vaccine.
- **Extensibility is an exit criterion, not a vibe** — see PLANS.md
  "Extension-point inventory" and acceptance tests 91–93 (a second analyzer
  must cost one package + one registration line).

## Starting a future plugin

Copy this directory's shape (`STATUS.md`, `prompts/`, `decisions/`,
`reports/`), write the new `PLANS-<topic>`-style plan and branch `AGENTS.md`,
carry over the ADRs that still bind (0004 declarative panels, 0005
session-only analysis, 0008 API conventions), and run the same loop. The
mass-fragment analyzer is the queued first test of this claim.
