# Code review: `claude/chemdraw-keybindings` vs `main`

Date: 2026-08-30. Reviewer: Kimi (9-angle review, four area passes + five whole-diff concern passes).

Scope: `git diff main...HEAD` — 20 commits, 32 files, ~+4,263/−345. The branch ships roughly
eight slices: the ChemDraw-compatible keybinding scheme, literal atom labels / naked typed atoms,
dashed-as-dative bonds + cross-molecule merging + metal coordination ceilings, charge-mark stacking
(±2…±9) + Clear/Restore Warnings, magnetic canonical-geometry snap + junction-pivot rotation, the
flexible chain tool + chain flyout, the 30° first-bond orientation + ring reorientation, and E→eraser.

Verification run: `pnpm test` — **3017 passed, 12 skipped (green)**. `pnpm lint` — **fails**
(2 type errors, see Blocker). Focused suites run by the reviewers: documentWorkflow 341/341,
App 191/191, layout-engine/export-engine/chem-core 148, hitTest + graphicPathEdit 84.

**Verdict: request changes.** The interaction machinery and the keybinding plumbing are well-built
and well-tested; what blocks merge is one type error, three silent-chemistry-degradation issues on
the serialization surfaces, one broken flagship gesture, and a durable record that covers about one
eighth of what the branch actually ships.

---

## Resolution status (2026-08-31)

Post-fix verification: `pnpm lint` — **clean**; `pnpm test` — **3053 passed, 12 skipped, 0 failed**;
`git diff --check` — clean. Launch smoke (`./run-app --dev`) not run.

Fixed in the working tree (uncommitted) after this review:

- **B1** — lint error: `mergeNativeMoleculeObjects` now narrows style colors through
  `styleColorMap` like every other consumer. `pnpm lint` clean.
- **M1–M3** — serialization fidelity: literal atoms and non-organic-subset elements bracket-emit in
  SMILES (`[C]`, `[Zn]`, verified by reparse through the repo's OpenChemLib build); unspellable
  condensed labels write as `[*]`/`*` dummy with a warning instead of garbage; dative bonds write as
  V3000 coordination type 9 and read back as dashed singles (clipboard-adapter included); V2000
  dative flattening and dummy-atom exports push warnings; `copyAsSmiles`/`copyAsMolfile` warnings
  are wired to the status bar. Ordinary-molecule SMILES output unchanged (ethanol is still `CCO`,
  pinned by tests).
- **M4** — shipped doc corrected (sprouts/fusion ARE mapped; numeric row disclosed as live in both
  schemes; E added to released keys; tool-keys-are-global rule stated; compatibility notes added);
  the same stale claim in `keybindingScheme.ts`'s header fixed.
- **M5** — layout-engine tests for the multi-magnitude charge glyph (text, `data-charge`, radius,
  radical combination) + chem-core round-trip test for `labelLiteral`/`warningSuppressed`.
- **M6** — charge hover-hotkey re-derives the hovered target from the last pointer position after
  each commit, so repeated `+`/`−` over a stationary atom stacks. One undo entry per press
  preserved.
- Minors fixed: charge-mark proximity fallback restricted to the same molecule; cyclic-0 sprout
  derives its turn from `chainAngleDegrees`; first-bond half-angle derives from the preset's chain
  angle; gem-dimethyl is all-or-nothing with a refusal signal; charge overlay `data-charge`/
  aria-label report the real magnitude; ±9 cap names the cap ("Charge is already at the ±9
  limit"); Space no longer double-fires on focused buttons; Preferences copy notes case-sensitivity
  and quotes key names; radical-dot offset on multi-magnitude marks; dead import removed;
  `hasOwnProperty` hardening in `keybindingScheme.ts`; stale JSDoc/test comments corrected;
  `migrateDocument` now frames unrecognized keys as "may have been saved by a newer version";
  redundant test override removed.
- Record-keeping: `docs/shipped/README.md` entries for the branch's other slices,
  `toolbar-command-map.md` chain-flyout rows, AGENTS.md §20 stress-list extension, build stamp
  bumped to `8.31.11.52-kimi`.

Deliberately left open (owner decisions or out of scope):

- Abbreviation/element collisions in formula metadata ("OAc" → O + actinium): behavior unchanged,
  limitation now stated honestly in `parseCondensedLabelFormula`'s JSDoc. An exclusion list is an
  owner call.
- The new→old one-way door and old-build charge degradation: documented in the shipped doc; old
  builds cannot be fixed retroactively. Release notes should state it.
- Dashed→dative reinterpretation of pre-branch drawings: it is the branch's intended feature;
  documented, not changed.
- Label-clear preserving charge/suppression onto the new element identity: defensible, left as-is.
- Performance tidy-ups (`findDocumentObject` hoist, `pointAtArcLength` cursor): low value, skipped.
- Hover-hotkey discoverability hints (status bar / tool usage text): a feature decision, not made.
- `./run-app --dev` launch smoke: not run as part of the fix pass.

---

## Blocker

> Status: **fixed 2026-08-31** — see Resolution status above. Findings below are the original review text, kept as the record.

### B1. `pnpm lint` fails — type error in the cross-molecule merge path

`apps/desktop/src/documentWorkflow.ts:16396-16397` — `mergeNativeMoleculeObjects` passes
`host.style.atomLabelColors` / `style.bondColors` (typed `unknown` via
`BaseObjectSchema.style = MetadataSchema = z.record(z.string(), z.unknown())`,
`packages/chem-core/src/schemas.ts:153`) directly into
`remapColorKeys(hostColors: Readonly<Record<string,string>> | undefined, …)`. tsc rejects it
(TS2345 ×2); `main` lints clean. Every other consumer narrows through
`styleColorMap`/`styleColorMapValue` first — this site should too.

---

## Majors — silent chemistry degradation (AGENTS.md §5.7 / §10 / §6.7)

> Status: **M1–M6 all fixed 2026-08-31** — see Resolution status above. Findings below are the original review text, kept as the record.

All three were verified by reading the code paths and by the reviewers' live harness runs. They sit
on the branch's flagship features and share a fix pattern plus a test-harness extension, so they
belong in one "serialization fidelity" slice.

### M1. `structure` SMILES re-invents the phantom hydrogens the branch abolished

`nativeAtomSmiles` (`apps/desktop/src/documentWorkflow.ts:17687`) emits bare `atom.element` for
uncharged atoms and has no `labelLiteral` handling; `convertNativeTextObjectToAtom`
(`documentWorkflow.ts:4330`) builds `structure: nativeSingleBondGraphSmiles([atom], [])` from it. A
typed literal `C` atom yields `structure: "C"` — methane to every SMILES parser — while the
literal-aware metadata path correctly reports formula `C`. Literal `N` serializes as `"N"` (= NH₃);
an under-valenced literal atom (`C` with one bond → `"CC"`) regains implicit H on reparse. The same
object now carries two contradictory chemistry claims.

Consumers of `structure`: `copyAsSmiles` (`documentWorkflow.ts:15715`), the plugin selection
snapshot (`plugins/selectionSnapshot.ts:38`), and the Ketcher adapter — a plugin asked for the mass
of a naked carbon gets methane's.

Fix: bracket-emit literal atoms (`[C]`, `[NH0]`) and extend the existing OCL-reparse invariant
harness (`documentWorkflow.test.ts:13257`) to literal atoms.

### M2. Hotkey/merge-first-class elements produce invalid SMILES; dative bonds serialize as covalent

The merged Zn–ethane complex from the branch's own test scenario yields `structure: "ZnCC"` — bare
`Zn` is outside the SMILES organic subset (B C N O P S F Cl Br I), so the string is invalid. Same
for hotkey-placed `Li`/`Si` (`nativeHotkeyElements`, `documentWorkflow.ts:732`) and condensed labels
(`"CH3"` → `structure: "CH3"`). Additionally `bondOrderSymbol` (`documentWorkflow.ts:17676`) ignores
`display.bondStyle`, so a dative seam bond is written as an ordinary single bond — the coordination
semantics vanish even where the string parses. `nativeAtomSmiles` predates the branch, but this
branch moves it from corner case to core gesture (typed metal atoms, cross-molecule merge at
`documentWorkflow.ts:16349`, Li/Si hotkeys).

Fix: brackets for charged/unknown/condensed atoms, and a decision for the dative case
(dot-disconnected components, or a documented degradation warning).

### M3. Molfile copy degrades dative bonds to covalent with no warning — including in-app copy→paste

`moleculeToMolfileV2000/V3000` (`packages/chem-core/src/molfile.ts:133,197`) writes
`BOND_ORDER_CODE[bond.order]` and ignores `bondStyle` (read at `molfile.ts:73` only for the wedge
stereo flag). A dashed dative single bond goes out as type 1 and re-enters via `parseMolfileGraph`
as a covalent bond — bond semantics change across a clipboard round trip with zero warnings,
violating §6.7's no-silent-lossy rule and §14. V3000 has a coordination bond type (9); if that's
out of scope, `copyAsMolfile` (`documentWorkflow.ts:15726`) at least needs to emit a warning.
Relatedly, V2000 writes `atom.element.padEnd(3)`, so a condensed-label atom exports `"CH3"` as an
element symbol — invalid molfile.

### M4. Shipped documentation contradicts shipped code

`docs/shipped/chemdraw-keybinding-scheme.md:51-57` says ring/fragment sprouts onto atoms, ring
fusion onto bonds, and wedge-direction sprouts (`4`/`5`) are "deliberately not mapped… their keys do
nothing." The code maps atom `3`–`0` and bond `4`–`0` to exactly those
(`apps/desktop/src/commands.ts:392-417`), spread into both hover maps
(`keybindingScheme.ts:94,123`), with `a` sprouting/fusing benzene; App.test.ts pins them as
deliberate. The same stale claim is repeated in `keybindingScheme.ts:6-9`'s header comment. The
doc's "What the ChemDraw scheme covers" section also omits the numeric row beyond `1`/`2`, and never
discloses that the numeric-row hotkeys are live in the **default** ChemDraft scheme too
(`MainWindow.tsx:18467-18479`) — new hover behavior for existing users. This repo treats
`docs/shipped/` as the authority on what shipped; the durable record is wrong in both directions.

### M5. No test for the multi-magnitude charge glyph on the canvas/export parity surface

The stacking commit (`46eb953e`) added ~58 lines of shared rendering math in
`packages/layout-engine/src/index.ts:3089-3165` (the `"2+"` text fragment, 0.42 radius,
`data-charge` magnitude) consumed by both the canvas and SVG/PDF export (`planPageSvgRender` —
MainWindow.tsx:2300, export svg.ts:38), i.e. the §6.22 parity surface. The only `charge: 2`
assertions are document-state level (`documentWorkflow.test.ts:4268`); nothing exercises the
renderer. §13 requires package-level tests for exactly this kind of change.

### M6. Charge stacking via the hover hotkey breaks after the first press

ChemDraw users stack charge by hovering an atom and pressing `+` repeatedly.
`addChargeToHoveredNativeAtom` (`MainWindow.tsx:3458-3465`) clears the hover target and growth arrow
after every commit, and hover is only re-derived on pointermove (`MainWindow.tsx:9889`). The second
`+` over a stationary, unselected atom finds no target and announces "No hovered atom for positive
charge" — while the pointer is visibly on the atom. Stacking works via charge-tool clicks (each
click re-hit-tests) and via a selected atom part, but not via the hover-hotkey gesture the feature
exists for. The clear-after-commit pattern is pre-existing; the new stacking
(`documentWorkflow.ts:7197-7228`) is what makes it matter. Fix options: re-derive hover from
`lastCanvasPointerClientPointRef` after commit, or keep the target for the charge path.

---

## Minors

> Status: mostly **fixed 2026-08-31** — the Resolution status section above lists exactly which; the rest are called out there as deliberately left open (owner decisions or low value). Findings below are the original review text.

### Correctness / behavior

- **Pointer-steered growth lost outside bond tools** — `hoveredNativeAtomStateRef` is only
  populated while the growth-arrow preview is on screen, so `1`/`2` under the select tool grow in
  the default direction instead of toward the pointer. Matches the new "commit what the arrow
  previews" contract and may be deliberate, but it's a behavior change vs `main` that no doc
  mentions.
- **Charge stacking can bump the wrong atom's mark** — `nativeAssociatedChargeMarkForAtom`
  (`documentWorkflow.ts:7242`) falls back to the nearest charge mark within ~1.15 bond lengths
  across *all* page objects, no same-molecule or same-anchor restriction. In tightly packed
  coordination complexes, `+` over atom A can increment B's mark; reconciliation then keeps the
  charge on B.
- **Gem-dimethyl sprout can apply partially and silently** — `applyNativeAtomSproutTarget` commits
  `second ?? first` (`documentWorkflow.ts:7555`): if the second methyl can't be planned, the 9-key
  yields one methyl with no refusal signal. No up-front valence check either (the badge flags the
  result afterward, so it isn't silent chemistry — just a partial-gesture surprise).
- **Cyclic `0` sprout hardcodes the 60° turn** (`documentWorkflow.ts:7586`), assuming a 120° chain
  angle; the molecule's own `drawingStyle.chainAngleDegrees` is read two lines earlier but only used
  for bond length.
- **Metal coordination ceilings above 8 unreachable** — `nativeMetalMaxCoordination` gives Re/Tc/W a
  ceiling of 9 (`documentWorkflow.ts:780`), but every growth/merge path gates on
  `nativeAtomAvailableBondCount`, which caps at `nativeAtomInvalidGrowthLimit = 8`
  (`documentWorkflow.ts:706`). The table advertises a state the UI can't produce.
- **Label-clear preserves charge, radicals, suppression, and label offset onto the new element
  identity** (`applyNativeAtomLabelClearTarget`, `documentWorkflow.ts:8595`): erasing an "O⁻" label
  yields a carbanion C⁻ still wearing its floating minus mark, and a suppression granted to the old
  identity persists onto the new one. Unexamined edge; tests cover only uncharged single-letter
  labels.
- **Abbreviation/element collisions miscounted in formula** — `parseCondensedLabelFormula`
  (`documentWorkflow.ts:17089`) counts any all-element label verbatim: typed "Ac" (acetyl) →
  actinium, "Pr" (propyl) → praseodymium, "Ts" (tosyl) → tennessine; "OAc" → O + actinium. The
  code comment promises abbreviations "contribute nothing rather than a wrong count"; the colliding
  subset does contribute a wrong one. Confined to formula/mass metadata — the valence path is safe
  (`nativeSingleHeavyElementLabelValence` requires a valence-table entry).
- **`e` over an atom falls through to the arrow tool** — the hover ladder misses `e`, so the
  registry's `tool.reactionArrow` binding fires while hovering an atom, exactly where a ChemDraw
  user presses it expecting an ethyl label. Either swallow `e`/`E` over atoms or amend the "keys do
  nothing" promise (doc and `keybindingScheme.ts:40-41` comment).
- **Element-symbol text converts with no opt-out** — every text-edit end routes through
  `convertNativeTextObjectToAtom`; a caption that is exactly an element symbol silently becomes a
  naked flagged atom, recoverable only via undo. Consider a "keep as text" affordance.
- **Space→select can double-fire when a non-toolbar button holds focus** —
  `shouldIgnoreShortcutTarget` doesn't exclude `button`; palette buttons guard Space themselves but
  context-menu `menuitem`s don't. Edge case (focus only lands there via tabbing).
- **Dead import** — `applyNativeAtomWarningSuppression` imported at `MainWindow.tsx:333`, never
  used (the context-menu path uses `applyNativeWarningSuppressionToScope`).

### Compatibility & migration

- **New→old one-way door, undocumented** — files containing `labelLiteral`/`warningSuppressed`
  atoms hard-fail on old builds (`.strict()` schema, `migrateDocument` strips only page/graphic
  keys), with an "invalid document" error rather than a "saved by a newer version" message. Files
  that never use those features open fine (the fields are omitted when false,
  `documentWorkflow.ts:16480-16488`).
- **Stacked charges silently degrade on old builds** — `ElectronMarkObjectSchema.charge` was
  already a plain int on `main`, so a 2+ zinc *passes* old-build validation; then
  `reconcileNativeChargeMarks` at load rewrites the atom down to ±1 and the mark re-renders as a
  single ⊕. Chemical identity silently lost in the downgrade direction, no warning.
- **Old documents reinterpreted on open** — dashed bonds were shippable on `main`; this branch
  redefines them as dative (zero valence), so existing drawings gain implicit hydrogens/badges on
  open, and stored `chemistry.formula` stays stale until the first edit re-derives it. Intentional
  and test-covered, but a retroactive semantic change to user drawings, disclosed only in code
  comments.
- **Valence-table expansion re-badges existing documents** — hypervalent halogens/P/As/S/Se/Te,
  transition-metal ceilings, new entries Al/Ge/As/Se/Sn/Te: old documents lose badges they had or
  gain new ones on open. Hypovalent badges are correctly gated on `labelLiteral`, so old documents
  can't gain *those*.
- **Element-symbol text in old documents converts to atoms when any edit of it ends** — a gesture
  that was inert before now mutates content type.

### Docs & record-keeping

- **Shipped record covers ~1 of ~8 slices** — only the keybinding scheme got a `docs/shipped/`
  entry. Undocumented: literal labels / typed atoms / text→atom conversion, dative bonds + merging +
  valence tables, charge stacking + Clear/Restore Warnings, snap + pivot, flexible chain, 30° first
  bond + ring reorientation, E→eraser. Several are chemistry-meaning decisions the shipped record
  exists to preserve (AGENTS.md: "Completed slices move to `docs/shipped/README.md` when they
  land").
- **Build stamp unbumped across 19 commits** — `CURRENT_BUILD_STAMP` is `8.12.12.48-claude` on both
  `main` and HEAD (`MainWindow.tsx:1355`). §22 requires a bump per slice; a build of this branch is
  indistinguishable from main's on sight.
- **§20 cumulative manual-stress list not extended** despite new interactive surfaces: chain flyout
  + flexible-chain drag, numeric hover hotkeys, charge stacking, Clear/Restore Warnings, text→atom,
  cross-molecule merge, magnetic snap, junction-pivot rotation, live scheme switch.
- **`docs/architecture/toolbar-command-map.md` lacks the chain flyout** — `tool.chain` still maps as
  a plain button; `tool.chainFlexible` has no row.
- **Stale/contradicted comments** — `nativeLiteralAtomValenceComplete` doc's hypervalent list is a
  shrunken enumeration (As(V), Se/Te, halogen states, and charged ammonium-like states all complete
  too); `findForeignNativeMoleculeBondTarget` doc says "editable" but the filter doesn't check
  editability (a nearer non-editable molecule shadows a farther editable one, and the merge then
  silently no-ops); `chargeMarkFragment` header still says "drawn as vectors" though 2+…9± marks
  render as text; "Labels are literal by default" test comments (App.test.ts:4563,
  documentWorkflow.test.ts:9449) are false — `atomLabelHideImplicitHydrogens` defaults `false`, so
  both "opt-in" patches are no-ops, contradicting the branch's own `styles.ts:105-107` comment;
  `commands.ts:240` "Grow two methyl groups" and the "gem-dimethyl pair" comment overpromise the
  `second ?? first` fallback; metal-ceiling comment claims "highest known coordination" but La: 10
  is below the 12-coordinate [La(NO₃)₆]³⁻.
- **Redundant test override** — `layout-engine/src/index.test.ts:2522` sets
  `atomLabelHideImplicitHydrogens: false`, which the spread preset already carries; leftover from
  the 70b5990a→62df6d4e default flip-flop, and its comment now misleads.
- **Scrambled Rust doc comment** — `apps/desktop/src-tauri/src/lib.rs:2293-2299`:
  `reinstall_app_menu`'s doc block now attaches to `set_keybinding_scheme`; `reinstall_app_menu`
  lost its doc.
- **Released-keys enumeration misses E** — the shipped doc lists "(V/L/M/C/R/+/−) are released" but
  E was bound to the eraser (`drawingTools.ts:74`) and released under the scheme on this same branch.

### UX / accessibility

- **Charge-mark overlay mislabeled to assistive tech** — `MainWindow.tsx:22537` clamps
  `data-charge`/`aria-label` to ±1 while the SVG fragment reports `sign * magnitude`: a mark
  visually reading "2+" announces as "Positive charge". The status noun likewise drops the
  magnitude.
- **±9 cap feedback is misleading** — the tenth `+` press is refused by returning the same document,
  and the caller reports "Cannot place positive charge on hovered atom" — but the mark *is* placed;
  the message should name the cap ("Charge capped at 9+").
- **Hover-hotkey discoverability is one Preferences sentence** — nothing in tooltips, usage hints,
  or the status bar mentions the numeric row or element relabels, and the Preferences description is
  only seen by scheme-switchers even though `0–9` is live in both schemes. A status-bar hint on atom
  hover would close this.
- **Case-sensitive keys are silent in-app** — `b`→Br vs `B`→boron is documented only in the
  developer-facing shipped doc; the Preferences description never says case matters. "l for Cl" is
  also typographically ambiguous (lowercase-L reads as I or 1 in most fonts).
- **No chem-core round-trip test for `labelLiteral`/`warningSuppressed`** — §13's chem-core row
  calls for one; the file's per-field round-trip pattern (e.g. `z`, bond display) has a slot for it.
  Pre-existing gap for `markCharge`/`markRadicals`, hence minor.

### Cross-package drift risks (nits)

- **The "dashed = 0 valence" rule now lives in two packages** — `nativeBondValenceContribution`
  (`documentWorkflow.ts:17921`) and layout-engine's `nativeAtomBondOrderUsage`
  (`packages/layout-engine/src/index.ts:5137-5144`), added in lockstep with nothing pinning them
  together. §5.26 prescribes a shared exported helper for exactly this case. Verified to agree
  today.
- **`mergeNativeMoleculeObjects` silently drops `superatoms`/`rGroups`** (`documentWorkflow.ts:16349`)
  — every producer currently writes `[]`, so no live data loss, but the drop is silent the day an
  import path populates them.
- **`labelLiteral`/`warningSuppressed` absent from the visible CDXML layer** — they survive the
  embedded JSON payload but external apps reopening the file see implicit-hydrogen semantics, with
  no export warning. Inherent to CDXML's model, but worth a `CompatibilityWarning` per §6.6's
  posture.
- **First-bond angle inconsistency** — parameterized (`targetBondAngleDegrees`) in the growth
  planner but hardcoded `Math.PI/6` in `createNativeSingleBondMolecule`
  (`documentWorkflow.ts:1098` vs `layout-engine/src/index.ts:595`): a document with
  `chainAngleDegrees ≠ 120` gets a 30° first bond from the tool but a different half-angle from
  hotkey sprouts.
- **Radical dot overlaps the "2+" glyph** — for a radical multi-magnitude mark, the dot at
  `centerX − radius*0.75` lands on the glyph edge (the offset was tuned for the 0.32-radius circled
  form; the text variant uses 0.42). Cosmetic, edge case.
- **Scheme-flip transient in PaletteWindow** — a chemdraw→chemdraft flip can briefly re-clear
  restored keys if a transformed snapshot arrives before the palette's own scheme-state update;
  self-heals on rebroadcast (the spec signature includes the shortcut fields). Worth a comment at
  most.
- **Security hardening nit** — `keybindingScheme.ts:82` uses `in` instead of `hasOwnProperty`; a
  command id of literally `"constructor"` would resolve to a prototype member. Unreachable today
  (core ids static, plugin ids forced into `plugin.*`).

### Performance (all low / informational — no action required)

- `findForeignNativeMoleculeBondTarget` runs an unmemoized O(page atoms) scan per pointermove in the
  freeform-drag preview (`MainWindow.tsx:9981`) — microseconds at realistic sizes, no early-out
  above the per-atom radius check.
- `findDocumentObject(drag.startDocument, drag.objectId)` re-scans page objects per pointermove in
  the snap drag/rotate paths (`MainWindow.tsx:11051, 10298`) — could be resolved once at drag start.
- Flexible chain replans the full pointer path per pointermove, with `pointAtArcLength` restarting
  its scan per station (carrying the cursor forward would make it O(path) total) — bounded by
  `maxNativeChainSegments = 200`, well under a millisecond; SMILES re-derivation happens once at
  commit, not per move.
- Scheme flips rebuild three MainWindow memos + one per palette + a rebroadcast + a native menu
  rebuild, all guarded to actual changes on both the JS deps and the Rust `changed` check. Startup
  gained nothing heavy (§15 clean).

---

## Angles checked clean

- **Security & permissions (§16, §7)** — `set_keybinding_scheme` is registered least-privilege in
  build.rs, capabilities, and the autogenerated permission TOML; unreachable from plugin workers (no
  IPC, no command namespace, `plugin.*` id namespace enforced); validates input and fails closed.
  Broadcast payloads are double type-guarded; localStorage is guarded on read with default fallback;
  no innerHTML/eval injection surface for typed labels (React-escaped, closed element-symbol set);
  document mutation routes through `applyPatch`/`applyPatches`; hotkey tables use `hasOwnProperty`
  (one `in` nit above).
- **§5.26 / §5.27** — no rendering math duplicated in app code; growth planning imports
  `planBondExtension`/`planFreeformBondExtension` from layout-engine; spin overlay, flatten, and
  `ScreenPlacement` paths untouched.
- **§9 command routing** — hover hotkeys resolve to command IDs dispatched through
  `invokeCommandRef` byte-identically to `main`; sprout/attach/fuse/display commands are registered
  value-encoded specs, not handler-local closures; `tool.chainFlexible` is a real manifest command.
- **§2 toolbar contract** — chain flyout items are live registered commands with real tooltips and
  ARIA (`aria-haspopup`/`aria-expanded`/`aria-controls` only when open; menu/menuitem roles); no
  placeholder buttons; native flyout transport untouched.
- **Keybinding conflict-clearing** — every ChemDraft default whose key is repurposed is nulled; the
  `""` sentinel survives every `??` merge and is filtered by the shortcut engine; registry
  `conflicts()` asserted empty in both schemes including the detached-palette registry;
  case-sensitivity matches the doc, including the `toString` prototype-pollution probe.
- **React correctness** — memo dependency arrays complete; keybinding listener uses the
  disposed-flag + unlisten pattern; scheme read via ref at event time so a live flip can't leave
  stuck resolutions; input-focus guards cover every canvas hotkey path (typing `b` in the label
  editor cannot trigger Br).
- **Undo granularity (§20)** — one history entry per gesture throughout, including the cross-object
  merge (single `applyPatches`). Caveat: no test pins undo-entry *counts* for the new paths.
- **Layout-engine geometry math** — tie-break comparator is a total order; −30° first bond matches
  comment, tool, and tests; new valence-electron entries chemically correct.
- **Old documents → new build** — schema is additive-optional; pre-branch files load unchanged;
  stored coordinates never recomputed on open; CDXML/CDX paths untouched.

---

## Recommended fix order

1. **B1** lint error — trivial, unblocks the gate.
2. **M1–M3** as one "serialization fidelity" slice: bracket-emit literal/exotic/condensed atoms in
   `nativeAtomSmiles`, decide dative serialization (V3000 type 9 or dot-disconnect + warnings),
   warn on lossy molfile export; extend the OCL-reparse harness to literal atoms and add a dative
   molfile round-trip test.
3. **M6** hover-hotkey charge stacking — re-derive hover from the last pointer point after commit.
4. **M4 + docs slice** — fix the shipped doc (and the `keybindingScheme.ts` header), add shipped
   entries for the other slices, bump the build stamp, extend the §20 list, update
   `toolbar-command-map.md`.
5. **M5** layout-engine glyph test (+ the cheap chem-core round-trip test for
   `labelLiteral`/`warningSuppressed`).
6. **Owner decisions** before merge: the dashed→dative reinterpretation of existing drawings; the
   new→old compatibility story (release notes at minimum; ideally a `migrateDocument` atom-key strip
   or a "saved by a newer version" error); the abbreviation-collision formula miscount (exclusion
   list vs documented limitation); `e`-over-atom behavior.

Everything else can ride along or ship after.
