# ChemDraft Plans

This file describes **the slice currently in flight** — nothing else. Completed slices move to
`docs/shipped/README.md` when they land, so that an agent told to "follow PLANS.md" gets the work
in progress rather than a changelog.

---

# In flight

Multiple document windows on branch `multi-window`, based on upstream/main df025e39.
The tabs prerequisite (#102), #99 QuitFlow and optional quit prompt (#144) are merged.
Use f3ad30c6 as reference, preserving current native dialog and toolbar architecture.

Design: Open targets the active document window; already-open files activate their owner.
Move Tab transfers history, file state, selection and viewport with confirmed receipt before
source removal. An emptied source closes. Closing a window does not quit its peers.
App Quit coordinates optional Save/Discard/Cancel decisions and flushes all window sessions
through QuitFlow before exit, retaining its bounded grace and Windows watchdog.
Document events use emit_to with explicit labels. Document commands are granted only to
document windows. Each document has full menus; toolbar marks synchronize. Utility ownership
is assigned at creation, never changed with SetWindowLongPtrW.

Fresh independent design and implementation reviews cover native/security/platforms and
session/transfer/quit correctness. Verify lint, Vitest, cargo fmt/clippy/tests and available
hands-on checks; macOS requires a separate host. No push without user approval.
Scope: desktop document/window/session/menu/permission code, tests and architecture/manual docs.

---

# Parked

These items are not in flight; reopening any item needs a reason recorded here first.

The analyzers slice shipped and moved to
[`docs/shipped/analyzers-property-prediction-suite.md`](docs/shipped/analyzers-property-prediction-suite.md).
What remains open from it:

- **The prospective applicability protocol**, `docs/benchmarks/pka-applicability-prospective-protocol.md`.
  §7 — the rule deciding when a prediction is shown with an interval, without one, or not at all — is
  deliberately blank, and the evaluation set it will be judged on has not been assembled. Order of
  operations is enforced by three commits in sequence: the sealed set's hash, then the rule, then the
  scores. Writing the rule after seeing the set voids the result.
- **OpenClatura silent omission.** A validated patch exists at `docs/benchmarks/openclatura-patch`; it
  has not been submitted upstream.
- **The pKa model itself is frozen** at SHA-256 `79061c4d…`. Model research is stopped, not paused for
  lack of ideas: the measured gap is not where feature or optimizer work reaches. Reopening it needs a
  reason recorded here first.

Other parked work:

- **Structure naming on the CLI and MCP (jgassens/ChemDraft#165 follow-up).** The policy is shared in
  `document-workflow-core/structureName.ts`; a headless caller needs the engine directory listed in the
  user's trust file (§5), never an environment variable alone.
- **MolScribe engine install on the `engineInstall` dialog kind.** The OCSR install still uses its own
  flow; moving it onto the shared dialog kind the naming engine introduced is parked.

---

# Known open items (not in flight)

These are standing gaps left by the toolbar,
palette, and arrow bug-fixes slice (shipped 2026-08-02, PR #26, merge `2fa4c21` — see
`docs/shipped/README.md`), not active work. One of its three original open items has since been
fixed; it is not repeated here.

1. **Art inspector still styles only graphics and molecules.** `ArtInspectorStyleObject` is
   `GraphicObject | MoleculeObject` (`apps/desktop/src/artInspectorModel.ts:156`), so Color
   Controls and Object Settings route a bracket or mechanism-arrow selection to a status message
   rather than a working panel. Widening it is its own slice.
2. **Stale comment in the CDXML importer.** `packages/cdx-compat/src/index.ts:2445` says
   equilibrium and retrosynthesis "stay the legacy `reaction-arrow` object until they're migrated
   in a later pass" — they were migrated in `163d7b7` and `4248c59`, and the condition on the
   line below already routes all four kinds to `importReactionArrowAsArtArrow`. Only `unknown` is
   legacy now. One-line comment fix.

(Fixed since: the third original open item — that electron-pushing arrows were art, not mechanism
annotations, and `tool.mechanismArrow` was a retired stub — was resolved 2026-08-12 by PR #32,
merge `a4477da`. `tool.mechanismArrow` and `tool.mechanismFishhook` are now live, atom/charge-anchored
`mechanism-arrow` document objects; see `docs/shipped/README.md`. `packages/mechanism-tools` is
still only shared types, but the working feature lives in `chem-core`, `documentWorkflow.ts`, and
`layout-engine`, not that package.)

Work scoped to a branch other than `main` carries its own plan; this file does not describe it.

---

Repo-wide scope lives in `PLAN.md`. One further scoped plan applies inside its area:
`PLAN-spin3d-forcefields.md` (Phase 3 blocked on owner decisions). The selection-architecture plan
finished and moved to `docs/shipped/selection-policy-refactor.md`.
