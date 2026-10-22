# ChemDraft Plans

This file describes **the slice currently in flight** — nothing else. Completed slices move to
`docs/shipped/README.md` when they land, so that an agent told to "follow PLANS.md" gets the work
in progress rather than a changelog.

---

# In flight

## Separate paired-bracket tools (`feature/paired-brackets`)

Add `tool.pairedSquareBracket` and `tool.pairedCurlyBracket` beside the existing single-bracket
controls, preserving their commands and click behavior. A new pair is one native bracket object
with optional `paired: true`; legacy objects omit this field and keep their existing rendering.
A click inserts a default pair and a drag sets its rectangular extent in either direction. Reuse
the placement capture, preview, cancel and undo paths, and the existing bracket move/resize controls.
The layout engine owns the matching paths for canvas and SVG/PDF export. Cover serialization,
geometry, chemistry preservation, toolbar routing, pointer capture, cancellation and undo/redo.
Scope: bracket schema/rendering, desktop tools and placement, tests, documentation and build stamp.
Native Windows/macOS verification remains required before closeout. No polymer semantics or new
CDXML compatibility claims are part of this slice.

Extension: selected pairs expose an inline lower-right label editor for plain text, a repeat count,
or a range, using the existing optional `label` field. Enter/blur commits one undo entry, Escape
discards the draft, and an empty value removes visible text. The layout engine owns placement for
the canvas and SVG/PDF output. Save/reopen, move/resize, rotation/projection, text escaping and
click-away editing must be covered; native focus/IME and scaling remain manual checks.

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
