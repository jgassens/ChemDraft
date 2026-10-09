# ChemDraft Plans

This file describes **the slice currently in flight** — nothing else. Completed slices move to
`docs/shipped/README.md` when they land, so that an agent told to "follow PLANS.md" gets the work
in progress rather than a changelog.

---

# In flight: user feedback fixes (branch `claude/user-feedback-fixes`)

Two tester reports (2026-10-08) and one owner report (2026-10-09), triaged against the code. Three
slices, one branch, one PR when all three are done. Every item works the same on macOS and Windows
(AGENTS.md §1) and keeps chemistry unchanged (§7).

Not in scope, by owner decision: an Undo button on the default toolbar. `edit.undo` is already in
the Customize Main Toolbar gallery ("Clipboard & History"), in Edit ▸ Undo, and on ⌘Z/Ctrl+Z; that is
enough.

## Slice 1 — drawing interaction fixes

1. **Rotation snaps to angles.** Dragging a rotate handle on a molecule, ring, arrow, or art object
   rotates freely today (`objectRotateDragDegrees`, group rotate, `rotateDocumentObject`); only
   partial-fragment rotation snaps. Whole-object and group rotation use the same snap helper as
   fragment rotation (one implementation): a magnetic pull to 15° steps by default, exact 15° steps
   while Shift is held during the drag. Typed rotation is unchanged.
2. **One click draws a ring.** A press on a toolbar button with a flyout opens the flyout after
   150 ms, so a slightly slow click opens the menu and leaves the old tool active. Raise the hold
   threshold. When a ring click near an atom or bond cannot fuse or attach, place a standalone ring
   at the click and say why in the status line, instead of doing nothing.
3. **Typing a substituent never erases.** Typing "OMe" over a hovered atom sets O, then "e" falls
   through to the Eraser shortcut; a text box whose editor loses focus to a flyout stays selected,
   so the next Backspace deletes it. Consecutive letters typed over the same hovered atom continue
   its label (OMe, OEt, CF3, NO2, OBn); no keystroke while labelling switches tools or deletes. The
   text-box editor survives focus moving to another app window, as the atom label editor already
   does.
4. **Orbital lobes meet cleanly.** Lobe tips sit on the shape's box edge; the p orbital's two lobes
   match the single lobe, meet at one shared node, and have smooth outer ends.

## Slice 2 — chemistry-aware drawing features

1. **Text becomes atoms.** A committed text box placed on a bond end becomes that atom's label
   (abbreviations and condensed formulas such as OMe, CH3, NO2 resolve through the label path), and
   a "Convert Text to Atom Label" command does it explicitly. Text that cannot be read as a label
   stays text, with a status message.
2. **Centered double bond.** A double bond position `center` beside `left`/`right`: both lines
   straddle the bond axis and both join the neighbouring bonds. Selectable from the bond inspector
   and by dragging; CDXML "Center" imports and exports; spin 3D and flatten keep it.
3. **Lobes attach to atoms.** A placed lobe puts its tip on the atom under the pointer, and rotating
   a lobe turns it about its tip.

## Slice 3 — sketch style stereo bonds

With the sketch effect on, hashed and dashed bonds show a solid stroke through their hashes, because
the sketch strokes trace each bond's centre line (`moleculeEffectSketchBasePathD`) rather than what is
drawn. Sketch strokes trace each hash, each dash, and the wedge outline. Canvas and export match.

## Open question

The owner's screenshot circles the four-membered ring of a sketch-style penicillin core; the report
names only the dashed bonds. What the circle marks is not yet known.

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
