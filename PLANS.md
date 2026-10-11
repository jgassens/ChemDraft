# ChemDraft Plans

This file describes **the slice currently in flight** — nothing else. Completed slices move to
`docs/shipped/README.md` when they land, so that an agent told to "follow PLANS.md" gets the work
in progress rather than a changelog.

---

# In flight

## Label anchoring (branch `claude/label-anchoring`, stacked on #83)

A group label such as "OMe" draws centred on its atom, so the bond meets the label's middle rather
than the atom it bonds to, and a group bonded on its right still reads left to right ("OMe–C"
instead of "MeO–C"). Two commits, each reviewed on its own:

1. **Move the atom-label grammar into layout-engine, verbatim** (`labelGrammar.ts`): the reading,
   the composite parser, the group's attachment atom and the valence tables it needs.
   document-workflow-core re-exports every name and keeps the verdicts, validation and expansion.
   No behaviour changes; the existing reading tests pass unchanged.
2. **Anchor and flip, in layout-engine.**
   - The attachment atom's symbol sits on the atom (the O of OMe, the C of CO2Me, a composite's
     head). A label that does not spell its attachment (Ph, Ms, Boc, TMS) puts its bond-end character
     there. Bond clipping follows the asymmetric bounds.
   - A group bonded on its right is drawn token-reversed (MeO, MeO2C, BocHN, PhH2C), but only when the
     reversed text reads as the same group; SCN is never drawn as NCS.
   - Display only: the stored label, its recorded bond side and the chemistry are untouched. The inline
     label editor stays centred.

Gates: stress numbers for canvas, SVG/PDF export, CLI bounds and bond clipping (OMe, CO2Me, NHBoc,
Ph, TMS × bonds left, right, up, down); review of each commit; the owner's check of OMe on both ends
of a bond and on a ring carbon.

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
