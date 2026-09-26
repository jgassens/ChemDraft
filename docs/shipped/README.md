# Shipped slices

Completed implementation slices, newest first. These moved out of `PLANS.md` on 2026-07-30 so that
file could go back to describing only the work in flight; the records themselves are unchanged apart
from heading levels and cross-reference fixes.

Each entry describes the state as shipped. When a later slice supersedes a decision recorded here,
the superseding entry says so — read the newest entry that touches a subsystem, not the oldest.

**Superseded decisions, at a glance:**

- *Toolbar Wiring and Honesty* decided that the four tool-drawn arrows would be semantic
  `reaction-arrow` objects rather than art graphics. That decision was reversed by the "Toolbar,
  palette, and arrow bug fixes" slice below (2026-08-02, PR #26, merge `2fa4c21`): all four
  families are art arrows tagged for CDXML interop, on `main` since that merge.

**Slices with their own file:**

- [ChemDraw-compatible keybinding scheme](chemdraw-keybinding-scheme.md) — a Preferences toggle that
  remaps tools, hover hotkeys, and menu chords to match ChemDraw's defaults for migrating users;
  documents the mapping rules, what is covered, and what is deliberately unmapped.

- [Analyzers: property and prediction suite](analyzers-property-prediction-suite.md) — the Molecular
  Inspector, isotope envelopes, OPSIN and OpenClatura plugin work, Joback estimates, and the pKa
  system. Kept separate because its later sections document how the pKa method behaves today: what it
  declines to answer, where its interval is validated and where it is not, and how every published
  figure regenerates. **The model is frozen**; the applicability protocol that would gate abstention is
  deliberately unfinished.

- [Selection Policy Refactor](selection-policy-refactor.md) — one pure selection policy, one hit
  resolver with atom→bond→ring precedence, uniform additive behavior across click/marquee/lasso, and
  cross-molecule part storage. All phases landed; kept separate because its design section still
  documents how selection works today.

---

## Windows port: updater, CDXML robustness, large drawings (2026-09-26, branch `windows-port`, not yet merged)

On top of the Windows build itself (installer, single-instance open, menu, clipboard; see AGENTS §20's
Windows surfaces), this branch shipped four slices.

- **App updater.** `tauri-plugin-updater` on Windows only, the counterpart of Sparkle: a signed
  `latest.json` feed on `main`, a daily launch check plus File ▸ Check for Updates…, and the document
  saved before the passive installer ends the process. A save that cannot happen (autosave off, the
  restore still running) stops the update unless skipping it loses nothing. The permission is
  `capabilities/app-updates.json`, marked Windows-only. Procedure: `docs/releasing/windows-updates.md`.
- **CDXML robustness.** Groups import as native groups (their own attributes kept on the group; a
  one-member group imports ungrouped, with a warning). `Order="dative"` reads and writes as the native
  dative bond, and a ChemDraw dashed single bond is said to be read as dative, since that is the only
  dashed single bond ChemDraft has. Hostile files fail with a message: bonds to missing atoms are
  skipped with a warning, out-of-range numbers are refused, a 100,000-member group imports. `.cdx` opened
  from Explorer reaches the opener, which says what it is, and UTF-16 files open by their BOM.
- **Large drawings.** The patch engine shares unchanged objects between document versions instead of
  deep-copying the document per patch, so a one-object edit costs the object, not the page; derived
  documents (charge-mark reconciliation) are re-admitted with `adoptDerivedDocument`. Object views are
  memoized, with handlers routed through `useStableCallbacks`, and molecule SVG plans are cached per
  object. Undo is bounded by retained size, counting shared objects once. On a 5,000-molecule page a
  single-object edit went from about 1 s to about 180 ms, and the heap no longer grows with each edit.
- **Molecular Inspector reads the drawing.** Properties analyse a V3000 molfile of the live atom and
  bond graph instead of the object's `structure` string, which was empty for imported molecules and a
  lossy SMILES for fused rings. Condensed labels such as OH and NH2 are spelled with their hydrogens.

## Tester feedback fixes + 0.3.5 (2026-09-25, PR #47 merge `60cc59e`, release PR #48 merge `e107b23`)

Two tester-reported problems, fixed and released same day.

Atom-label typing was leaking into canvas hotkeys: when the label input lost focus mid-edit, the
edited atom stayed selected, so the rest of a typed label (or a subsequent keypress) hit canvas
hotkeys instead — `e` armed the eraser, an element letter overwrote the label with a naked atom,
Backspace stripped it. The pre-edit selection is now restored whenever a label edit closes by any
path other than Enter/Tab/Escape (including a tool picked from a palette mid-edit); the label box
shares the text editor's focus-hardening; Tab now finishes the edit like Enter; and a blur caused
only by the window losing key status (a palette taking focus) keeps the edit open rather than
closing it.

Edit ▸ Undo/Redo were AppKit's predefined menu items, which sent `undo:`/`redo:` to the web view's
native text-undo manager and never reached the drawing's own history — ⌘Z only worked through the
JS shortcut handler, never through the menu. They are now routed `edit.undo`/`edit.redo` commands
(still ⌘Z/⇧⌘Z) delivered to the key window: a focused text-entry field gets native text undo,
otherwise the drawing's history is undone; secondary windows (palettes) forward to the main window
with a marker that forces drawing-history undo rather than whatever text field last had focus
there. No toolbar button was added — an owner decision.

Open: a tester report of "benzene needs several clicks to draw" has no confirmed cause from code
reading alone; it needs the tester's own answer (did the ring flash and vanish, or never appear at
all?) before it can be reproduced.

---

## ChemDraft agent toolkit: CLI, render CLI, and MCP server (2026-09-24, PR #41 + PR #45, merge `dbd3974`)

A headless `pnpm chemdraft <subcommand>` CLI and a stdio MCP server exposing the same operations, so
an AI agent can do chemistry through the app's own chemistry stack instead of guessing at structures
or numbers. Eight subcommands: `render` (SMILES → cropped SVG/PNG; PR #41 shipped this alone first as
`pnpm render`, then PR #45 superseded it inside the full toolkit), `grid` (many SMILES → one labelled
multiple-choice image), `reaction` (reaction SMILES or explicit reactant/agent/product → a scheme with
plus signs, arrow, and charged formula labels), `analyze` (properties, pKa with intervals and source
atoms, m/z table, provenance report), `name` (IUPAC/trivial name → SMILES via the vendored OPSIN,
refusing ambiguous names unless overridden), `stereo` (R/S centres, E/Z bonds, unspecified and
unrepresentable stereo), `nmr` (¹H/¹³C shifts and a stick spectrum via the NMR predictor plugin,
loaded at run time from its separate repo), and `export` (cdxml/pdf/sdf/mol/smi). `packages/chemdraft-mcp`
wraps all eight as MCP tools; each call gets its own output directory and calls run one at a time.

Every chemical-file export compares the RDKit canonical SMILES (with stereo) of what was written
against the input, and fails the job rather than writing a file that silently changed identity.
Dative bonds, unspecified E/Z, radicals, isotopes, and oversized/empty input are refused or preserved
rather than guessed at; `analyze` fields carry `{value, status}` so a declined computation and one
never requested cannot look the same (AGENTS.md §8b). Reviewed by Fable, then Kimi, then a max-effort
astra pass across ~50 adversarial inputs that returned "do not merge" on 13 findings — all fixed
except two, deferred with tracked follow-ups: the NMR plugin loads without the app's permission gates
(it is the owner's local checkout; proper isolation is a separate design), and the CLI imports desktop
modules directly (extracting a shared workflow package is a larger refactor).

---

## Download site (2026-09-23, PR #42 + PR #43 + PR #44)

A static download page at `site/`, deployed to GitHub Pages (`https://jgassens.github.io/ChemDraft/`)
on pushes to `main` touching `site/**`. The download button asks the GitHub API for the latest
release and links to its `.dmg`; with JavaScript disabled it falls back to `/releases/latest`. PR #43
added a "What it does" feature section — five groups of bullets (Draw, Inspect, Predict, Spin 3D,
Open), each checked against the shipped code — with real screenshots (a Suzuki coupling, the
Molecular Inspector's isotope envelope and pKa view) and a looping GIF of Spin 3D turning a helicene.
PR #44 swapped the pKa screenshot for one taken in the packaged Mac app rather than the browser
preview build, and the intro text now says which images come from which build.

---

## ChemDraw-parity drawing interactions (2026-08-31; extended 2026-09-20)

Implemented and tested on `claude/chemdraw-keybindings`, integrated with its later clipboard,
interchange, and cleanup slices. The keybinding scheme that rides with them has its own doc,
[chemdraw-keybinding-scheme.md](chemdraw-keybinding-scheme.md). Unless noted, the code lives in
`apps/desktop/src/documentWorkflow.ts` with coverage in `documentWorkflow.test.ts` and
`App.test.ts`.

### Literal atom labels, typed naked atoms, Delete-strips-label

Committing a text box that holds exactly an element symbol ("C", "fe", "Br"…) converts it into a
real one-atom molecule at that spot — hover hotkeys, bonding, and valence checking all apply, and
lower-case symbols canonicalize (`convertNativeTextObjectToAtom`). Conversion runs on every way
an edit ends (Escape, click-away, tool switch), not just Escape, and is idempotent so overlapping
end paths no-op. Literalness is a per-atom `labelLiteral` mark set by text conversion and by the
atom-label editor: the label draws exactly as typed, contributes no implicit hydrogens to the formula,
and is
valence-checked literally — a lone typed "N" is a flagged hypovalent atom until three real bonds
arrive, while a naked typed "OH2" is complete water (condensed literal labels spelling one heavy
element are checked with their own hydrogens; multi-heavy labels and abbreviations stay
unchecked superatoms and contribute nothing rather than a wrong guess). Element hotkeys produce
ordinary skeletal atoms — implicit hydrogens drawn and counted — and pressing a hotkey over a
literal atom clears the mark. The label editor commits with `literal: true`, so its element labels
keep the same explicit-hydrogen contract as text conversion. While the label editor is
open the molecule overlay strips the edited atom's rendered label so the draft never
double-draws. Delete/Backspace over a labeled atom strips the label first — reverting to a plain
skeleton carbon with bonds and position intact, hover preserved so the second press lands without
re-aiming — and deletes the atom on the second press (`applyNativeAtomLabelClearTarget`);
unlabeled carbons and multi-part fragment deletes behave exactly as before.

Compatibility: a document containing `labelLiteral` atoms fails to open in older builds — the
atom schema is `.strict()` and the error names the unrecognized key.

### Dative dashed bonds, cross-molecule merging, valence/coordination tables

A dragged bond dropped on another molecule object's atom merges that object into the source
molecule and bonds across the seam (`findForeignNativeMoleculeBondTarget`,
`mergeNativeMoleculeObjects`) — the absorbed atoms and bonds are re-minted onto fresh ids (every
molecule starts at `atom_001`, so ids collide), per-atom/per-bond style colors follow the remap,
and anchored electron marks and mechanism/reaction arrows are re-pointed at the host. Dashed
single bonds now depict dative/partial interactions — coordinate bonds, hydrogen bonds — and occupy no
covalent valence slot on either atom (`nativeBondValenceContribution`): pyridine's N keeps three
bonds and no badge while dash-bonded to a zinc, and a fourth *covalent* bond on neutral N still
demands its +1. Valence checking grew coordination ceilings for the whole d-block
(`nativeMetalMaxCoordination`): variable oxidation states make hypovalence unjudgeable, so metals
are never flagged naked or hypovalent — only a bond count beyond the element's highest known
coordination number earns the badge (V past 7, Pd past 6, Re allowed its 9-coordinate hydride) —
and all thirty metals carry standard atomic weights so metal-containing formulas get real masses.
Main-group coverage extended to Al, Ge, As, Se, Sn, Te with the neutral-plus-hypervalent model,
and the heavy halogens' ceiling rose to 7 so lambda-3/-5 iodanes (Dess–Martin, PhI(OAc)2) stop
reading as drawing errors. Dashed display is accepted only on single bonds; the serializers write a
dashed non-single bond with its real order plus a warning. A pyrrole-type N–H (imidazole, pyrazole,
pyrrole, indole) that carries a dative bond to a metal is drawn deprotonated — the label reads N,
the formula loses that hydrogen, the atom stays neutral — because such a nitrogen has no free pair
to donate and coordinates only as its conjugate base; pyridine and amine donors keep their hydrogens.

Compatibility: documents drawn before this branch reinterpret existing dashed bonds as dative on
open — labels on atoms with dashed contacts may gain implicit hydrogens immediately, and the
stored formula keeps its pre-branch value until the first edit re-derives it
(`refreshNativeSingleBondGraph` re-computes the chemistry metadata on every edit).

### Stacking charge marks, Clear/Restore Warnings

The charge tool and the `+`/`−` hover hotkeys **stack** on the atom's existing charge mark
instead of piling up overlapping marks: + on ⊕ gives a single 2+ mark, − steps back down, and the
mark is removed at zero — capped at |9| (`nativeChargeMarkMaxMagnitude`). Multi-magnitude marks
render real "2+"/"3−" glyphs in the circled and plain styles and reconcile like any mark.
Elements outside the covalent valence tables (transition metals, alkali/alkaline-earth) now
associate any charge — the octet math cannot refuse a solid-bonded Zn its 2+. Right-clicking an
atom wearing the valence badge offers Clear Warning: a per-atom `warningSuppressed` flag that
silences the badge and the stored warning until the same menu's Restore Warning brings it back.
The scope follows the selection (`applyNativeWarningSuppressionToScope`): whole-molecule
selections clear every warning in each selected molecule, while a partial selection — an atom, a
bond (its endpoints), a ring, a lassoed fragment — clears only the selected parts' atoms. The
menu item pluralizes with the live count, flips to Restore Warnings when everything in scope is
already dismissed, and clearing suppresses only atoms that *currently* warn, so a valid atom
keeps its voice for future mistakes.

Compatibility: charge marks with magnitude >1 open in older builds but silently degrade to ±1 on
load (the old renderer drew only ±1 glyphs and the old reconciliation recognized nothing else).
A document containing `warningSuppressed` atoms fails to open in older builds (strict schema, as
above).

### Magnetic canonical-geometry snap, junction-pivot rotation

Dragging an atom — or any partial selection — snaps magnetically to canonical geometry: when a
boundary bond comes within 6° of a canonical direction (the 30° drawing grid, or 120° off the
stationary anchor's other bonds) it clicks onto the exact angle, and within 3 px of the style's
bond length it clicks to the exact length; both snaps engage independently and apply every
preview frame, so the pull is felt during the drag and releases cleanly outside the capture
windows (`snapNativeMoleculePartDragDelta`; every bond crossing the selection boundary is a
candidate, so mid-chain slices snap too, while whole-molecule selections still move freely).
Rotations click as well: junction-pivoted fragments snap when the rotating bond reaches a
canonical direction (3° window), center-pivoted selections at 15° steps, and the on-screen degree
readout shows the snapped angle the drag will commit
(`snapNativeMoleculePartRotationDegrees`). A selection that meets the unselected remainder
through exactly one of its own atoms rotates **about that junction atom** — the junction and the
attachment bond stay put while the substituents swing — and only a selection with no single
junction rotates about its center (`nativeMoleculePartRotationPivot`, `rotateNativeMoleculeParts`;
the rotate and 3D-tilt drags measure the pointer angle about the same pivot so the handle feel
matches what commits).

### Flexible chain tool, chain flyout

The chain button carries the standard variant flyout (corner indicator, long-press /
Alt+ArrowDown) with two items in both palette sections: Chain (zig-zag along the straight
press→drag axis) and Flexible Chain (`tool.chainFlexible`), whose zig-zag snakes along the
pointer path so the chain bends wherever the drag turns. `planNativeFlexibleChainVertices`
resamples the pointer path into stations every reach-per-segment of arc length and steps each
bond ±half the zig-zag angle about the local tangent — every bond keeps its exact length, a
straight drag reproduces the straight planner exactly, and the same page-edge stop and
200-segment cap apply. The placement drag accumulates the thinned pointer path so preview and
commit plan identical vertices, free and atom-anchored alike.

### First-bond 30° orientation, ring reorientation

Hotkey sprouts follow geometry and the growth arrow, ChemDraw-style: candidates are open-space
bisectors and ±chain-angle directions with ties breaking upward (matching ChemDraw's rising
sprouts); a bare atom's first bond and the empty-canvas seed bond default to 30° above horizontal
instead of lying flat; and the hexagon templates (cyclohexane, benzene) stamp vertex-up — the
journals' orientation — so fresh-ring sprouts head vertically and diagonally. When a bond tool's
growth arrow is on screen, the hotkeys commit exactly what it shows (steered candidate, guided
ring closure included), and carbonyl on an atom that can't carry =O (aromatic carbon, existing
carbonyl) sprouts a new carbon along the open direction and puts the C=O on it — ChemDraw's
aldehyde behavior — instead of refusing.

### Fragment copy and mixed selections

A lasso or marquee copies its selected atoms and every bond whose ends are kept, as a standalone
molecule. Whole objects and fragments share one payload, with a whole-selected molecule taking
precedence over its fragment. Anchored charge, radical, and lone-pair marks travel with their atoms;
paste remaps their molecule anchors, and Cut removes the same objects and parts that were copied.

### Paste at the pointer and the bare-canvas Paste menu

Selection paste centres the copied bounds at the pointer's page position, with repeated pastes
offset through the existing placement state. A right-click on empty canvas offers Paste, and a
right-click over a selected fragment preserves that fragment instead of promoting its whole molecule.
An empty Copy is swallowed so the web view cannot put the app's own markup on the clipboard.

### SMILES-list grid paste

Lists of SMILES are parsed into editable molecules and laid out in a row-major grid, with progress
for longer lists and skipped-token counts in the result. Prose stays text; one SMILES with surrounding
whitespace follows the single-structure path. Oversized grids expand the page rather than pile
structures against its edge (`smilesListPaste.ts` and `insertSmilesMoleculeGrid`).

### SDF and .smi structure-list export

Selected molecules, or the page when nothing is selected, export in reading order through
`structureListExport.ts`. SDF carries one V2000 record per molecule with SMILES and index fields;
.smi carries one SMILES/name-or-index row. Copy As SMILES shares the lazy RDKit identifier path,
preserving stereo from the drawing. Native fallback warns for wedge/hash and substituted double-bond
stereo; writer losses, including dummy replacements for condensed labels, reach the export warnings.
Literal element valences and D/T isotope spelling follow the package writers.

### CDXML abbreviation expansion

Nested abbreviation fragments expand into their carried atoms when the body and attachment can be
resolved without guessing. Unsupported, charged, or over-deep abbreviations stay literal labels
with warnings; numeric text runs survive so SO3 cannot silently turn into SO
(`packages/cdx-compat`).

### Dative cleanup passes

2D Cleanup lays out the covalent ligands before placing free coordination metals in their donor
pockets. Chelate and bridging passes adjust placement, donor angles, and metal–donor distances
while preserving the ligand graphs; stereo checks still guard the result. Nickname placeholders
are compared against the writer's actual symbols, so an engine returning C for Ph's dummy atom
does not abort geometry-only cleanup or replace the document's Ph label.

### Running-build reporter

`pnpm running-build` (`scripts/running-build.mjs`, with `--json` for raw records) reads each
desktop app's `runtime-build.json`. Windows report on load, hot update, and return to the foreground,
so the report identifies what a window actually loaded, including the worktree/build and record age,
rather than assuming the newest source has reached every open window.

---

## Movable charge marks, mechanism-arrow tools, and Copy As (2026-08-12, PR #32 merge `a4477da`; charge-mark follow-up PR #33 merge `4c88848`)

Three independent pieces landed together.

**Charge marks became proximity-associated objects instead of a raw formal-charge flag on the atom.**
Dragging a charge mark away from its atom reverts that atom to its neutral valence — no more a mark
stuck on an atom that can no longer support it, and no more a spurious `(!)` warning. The full
charge/electron-mark palette (8 symbol tools: circled and plain charges, radical cation, radical
anion, plain radical, lone pair) sits behind one dropdown, matching the reference corpus. A same-day
follow-up (PR #33) fixed anchored charge marks not carrying through molecule rotate/scale/flip.

**Mechanism arrows became real, atom-anchored objects.** `packages/chem-core/src/schemas.ts` gained
a `MechanismArrowObject` (`type: "mechanism-arrow"`) with one or two Bézier handles depending on
length, anchored to an atom or a charge mark. `tool.mechanismArrow` (full-headed) and
`tool.mechanismFishhook` (half-headed) are live tools built on this type — this **resolves** the
toolbar/palette/arrow-bug-fixes slice's open item that `tool.mechanismArrow` was retired and
`packages/mechanism-tools` a stub. `packages/mechanism-tools` itself is still only shared types
(`MechanismToolKind`, `MechanismToolDefinition`); the working implementation lives in `chem-core`,
`documentWorkflow.ts`, and `layout-engine`, not in that package. The renamed-command map
(`apps/desktop/src/renamedCommands.ts`) redirects the old stamp-style curved/fishhook *art* arrow
ids (`tool.art.curvedArrow90`, `tool.art.curvedArrow180`, `tool.art.fishhookArrow`,
`tool.art.fishhookCurved`) to these real tools; the art geometry itself survives only for CDX-imported
documents that already used it.

**Copy As** joined Cut/Copy/Paste in the Edit menu and the object right-click menu: SMILES, InChI,
InChI Key, CDXML, MOL text (V2000/V3000), SVG, PNG. Its scope expands to anchored charge marks and
mechanism arrows tied to a selected molecule, rather than only the literally-selected objects — a
prior gap that dropped charges and mechanism arrows from Copy As ▸ PNG/SVG. `moveDocumentObject`
gained a branch for mechanism-arrow objects (their Bézier control points previously never moved with
the object, which also fixes dragging one in the editor). Bundled fixes: desktop clipboard paste
between two app instances producing garbled/CJK text (native pasteboard byte-decoding), double-click
relabel not opening the text editor in dev builds, a right-click on an object inside a multi-selection
collapsing the selection to just that object, Copy As ▸ SVG pasting as literal markup instead of
vector art in Illustrator (missing `public.svg-image` clipboard flavor; `paint-order` and
`dominant-baseline`, both silently ignored by Illustrator, replaced with a stroked-under-fill halo and
a `dy` baseline offset), and low-resolution PNG pastes (now 4x oversampled with embedded 288dpi
density metadata).

---

## Toolbar, palette, and arrow bug fixes (2026-08-02) — on `main` (PR #26, merge `2fa4c21`)

Branch `codex/toolbar-bug-fixes`, opened 2026-07-26, 26 commits. Two independent threads that
touched different files and were reviewed separately: Thread A hardened the native
toolbar/palette window system after a Claude + Codex review; Thread B rebuilt the arrow family on
the art pipeline. A third, smaller thread (C) made the Main Toolbar's style widget
selection-aware.

### Thread A — Native toolbars, palettes, and popover flyouts

- **Customization could break commands app-wide** (`ad98d4f9`). `toolCommandSpecs`'s generic
  binding loop ran *after* the domain-handler loops with last-wins semantics, so dragging Undo,
  Save, or a hovered-atom edit onto any toolbar re-registered that id as a no-op — breaking it in
  menus and shortcuts too, since the registry is shared. The generic loop now skips ids an earlier
  handler has claimed. Landed alongside it: dead gallery commands removed, mojibake labels
  repaired repo-wide, the Distribute button stopped invoking on Enter/Space while disabled, and
  `toolbarAsset()` guarded at its three direct-render sites against an unknown/IPC-sourced value.
- **Plugin palette windows rendered as the Main toolbar** (`17dcbde3`). A native palette webview
  ships only the core toolset manifest; plugin toolsets are contributed at runtime in the main
  window, and nothing carried their definitions to detached palette webviews — so a plugin
  toolset's window fell back to `core.main` and rendered the Main toolbar under the plugin's
  title, with a close button targeting the real Main window. A toolset-definitions IPC channel now
  mirrors the command-specs channel; the `core.main` fallback is replaced by an empty placeholder
  carrying the window's real id.
- **Palette reconciliation was open-only** (`3ff9a5de`). The startup reconciler opened toolsets
  that should be visible but never closed any, and substituted defaults whenever the desired set
  was empty — so a toolbar saved hidden but OS-restored open stayed open, and "hide everything"
  was silently overridden. `reconcileNativePaletteWindows` now converges toward the desired set,
  closing known windows that are open but undesired and honoring an empty desired set as hide-all,
  while deliberately leaving unknown/orphan windows (a plugin still loading or uninstalling)
  alone.
- **Two data-loss traps in Rust persistence** (`13067a1b`). Reads swallowed every error as "file
  absent," so a transient/permission read miss looked like "no saved state" and the next write
  overwrote the real file with defaults — `read_optional_file` now returns `Ok(None)` only for
  `NotFound`. Writes used plain truncate-then-rewrite, so a crash mid-write could strand the user
  in the fallback with customization gone — `write_file_atomic` now writes a pid-namespaced temp
  sibling and `rename(2)`s it over the target. Rewired: toolset customization state, document
  session autosave, internal toolset layout state, and plugin storage.
- **Flyouts that never appeared** (`eb6612d9`, `f247e922`, `68e7d920`, `6239db8a`). Four fixes in
  sequence, the last of which was the actual root cause: hold delay cut 420→150 ms; a
  prewarm-and-content-acknowledged reveal replaced building the popover webview at press time; the
  content-acknowledged reveal was made synchronous after `requestAnimationFrame` turned out to be
  *suspended in a hidden webview* (a deadlock — the reveal waited for a frame that couldn't arrive
  until the reveal happened); and finally, the popover's Tauri capability granted
  `core:window:allow-hide` but never `core:window:allow-show`, so every reveal had been silently
  denied since the popover was built. That single denial explains the whole bug history: warm
  reuse used to work because Rust showed the window directly on that path, and the prewarm rework
  removed that — the only show that was ever permitted — so no flyout could appear at all.
  **Standing lesson:** a missing Tauri capability fails silently through swallowed JS rejections
  and presents as intermittent UI, not as an error; check `capabilities/default.json` and the
  window server before rewriting the JS.

### Thread B — Arrows become art objects

This reverses a decision from *Toolbar Wiring and Honesty* below — see that entry's superseded-note
— by agreement with the project owner (`49d4de52`: "per the design we agreed on"). All four
families (reaction, resonance, equilibrium, retrosynthesis) became art `GraphicObject`s tagged with
`artToolId` (`packages/chem-core/src/schemas.ts`), gaining the editing mechanics the semantic
object never had: draggable endpoints, arc, arrowhead sizing, hover dot handles, drag-to-move,
hover-delete, drag-to-draw. `insertNativeReactionArrow` and the `reaction-arrow` schema type
survive for older documents and for arrows CDXML imports as `unknown`.

**CDXML interop.** Export re-emits the standard spellings (`<graphic GraphicType="Line"
ArrowType="FullHead"|"Resonance"|"Equilibrium"|"RetroSynthetic">`), so other programs still read
these as reaction arrows; exact geometry round-trips internally through the embedded native
payload. Import turns a foreign arrow of any of the four kinds back into an editable tagged art
arrow (`importReactionArrowAsArtArrow` in `packages/cdx-compat/src/index.ts`) — so tool-drawn and
imported arrows became the same object type after import, answering the original objection to the
art route, at the cost of `unknown` arrows remaining legacy objects. Bold/dashed reaction variants
also export as `FullHead`; fishhook stays a generic graphic with no `ArrowType` mapping.

**Geometry.** New `dualShaft` graphic data: equilibrium is two parallel half-shafts straddling the
axis pointing opposite ways with independent per-shaft length handles; retrosynthetic is
`dualShaftParallel`, both shafts the same way under one open head with no per-shaft handles. A
shared `dualShaftGapPx` middle knob resizes the whole arrow (gap, harpoons, seats together) instead
of bending the axis into a curve.

**Interaction rules.** Nothing paints on the initial press for any arrow family — it appears on
pointer move or release. Arrow mode doubles as an arrow-editing mode (hover reveals grabbable dot
handles); select mode uses the same small dots for line-family arrows. Arrowhead size snaps to 4 px
steps, default head 16 px (was 10 px). Body drag moves the arrow; hover-delete removes the hovered
one in arrow mode.

**Per-tool arrow style defaults** (`5b5c08a2`). Right-clicking any arrow offers "Set as Default
Arrow Style," capturing its reusable look (head sizes, dual-shaft heft/half-lengths, arc sweep,
stroke color/width/dash — a curved default's bow is stored as a signed length fraction) into a
per-tool session registry persisted through localStorage, consulted by both drag-drawn and
click-placed creation paths. The gesture's own geometry (endpoints, length, angle) is never
captured.

**The curated flyout** (`c2567d8e`, `12718cc5`). An 11-item grid covering the arrow families
rather than the full ~56-cell wall, as pure data over the existing art pipeline: bold/dashed
reaction arrows, `curvedArrow90`/`curvedArrow180` electron-pushing curves, `fishhookArrow`/
`fishhookCurved` using a new `half-arrow` marker kind, and `noReactionArrow` using a new
`shaftMark: "cross"` field. (The curved/fishhook stamp-style art tools were themselves later
superseded by real atom-anchored mechanism-arrow objects — see "Movable charge marks,
mechanism-arrow tools, and Copy As" above.)

### Thread C — Selection-aware Main Toolbar style widget

The Main Toolbar's style widget (`widget.core.mainStyleControls`) swaps layout by selection: text
(the prior widget, also the fallback for empty/mixed selections and customize mode), molecule
(bond width, double-bond spacing, atom-label font/size, H/terminal-C toggles), shape
(fill/stroke target, paint type, width/dash/corners, swap), and arrow (head kind/size, tail
toggle, width/dash, set-as-default, flip) — one widget id, one 12×2 grid slot, every layout
budgeted to 11 cells per row so no variant can resize the toolbar.

Command ids introduced: `object.marker.end.kind.*` / `object.marker.start.kind.*` (8 static head
presets per end), `object.marker.size:<n>` (dynamic head size, 4–96 px steps), and
`arrow.setDefaultStyle` promoted from a context-menu-local string into a real `invoke` handler
(`applyArrowStyleDefaultCommand`) so the style widget's button can capture the single selected
arrow. Retro arrows are excluded from marker commands (their head is path geometry, not markers).

### Verification

`pnpm vitest run` across `App.test.ts`, `toolsets.test.ts`, `documentWorkflow.test.ts`,
`graphicPathEdit.dom.test.ts`, `PaletteWindow.pluginToolset.dom.test.ts`,
`toolbars/reconcileNativePalettes.test.ts`, `packages/art-engine`, `packages/cdx-compat`, plus
`pnpm lint`/`test`/`build`, `git diff --check`, and the Rust fmt/test checks (native code changed:
`build.rs`, `capabilities/default.json`, a new `prewarm_toolset_popover` permission, `src/lib.rs`).
Manual stress covered each arrow family by click and drag, head resize stepping, independent
equilibrium half-shaft drag, the middle-knob resize behavior, arrow body move/hover-delete, every
palette flyout cold/warm/idle, hide-all-and-relaunch, and a plugin toolset window rendering its own
tools under its own title.

### What was still open at the time of shipping

Three items were carried into `PLANS.md` as open work. Two remain open; one has since been fixed —
see [Known open items](../../PLANS.md#known-open-items-not-in-flight) in `PLANS.md` for current
status:

1. Art inspector still styles only graphics and molecules (`ArtInspectorStyleObject`) — **still
   open**.
2. Electron-pushing arrows were art, not mechanism annotations, and `tool.mechanismArrow` was
   retired — **fixed** 2026-08-12 by PR #32; see "Movable charge marks, mechanism-arrow tools, and
   Copy As" above.
3. A stale comment in the CDXML importer claiming equilibrium/retrosynthesis "stay the legacy
   `reaction-arrow` object until migrated" — **still open** (one-line fix).

---

## Toolbar Wiring and Honesty (2026-07-25) — on `main` (PR #21, merge `a7c88a69`)

Status: all eight phases implemented and hardened across two review rounds, landed together with the
plugin-updates slice below. `TRANSITIONAL_STUB_COMMAND_IDS` is empty — shipped toolsets contain zero
permanently disabled buttons.

An external review plus three adversarial passes found roughly nineteen defects in the first cut of
this slice. All five P1s and the P2s are now fixed with regression tests: imported structures keep
an honest `structureFormat` when edited; CDXML arrows use the real `ArrowType` spellings both ways;
arrow resize transforms the endpoints, not just the frame; axis-aligned arrows get a frame that
contains their glyph; formula text distinguishes a charge magnitude from an atom count and keeps
span styling; Escape cancels an in-flight placement instead of arming it; brackets and arrows are
painted once; brackets and curved art warn when they degrade in foreign CDXML; chains stop at the
page edge and rebuild in one pass; stamps centre on the click and clear stale interaction state;
arrows and orbitals can start on top of an existing object; and the Customize gallery offers
neither transitional stubs nor the compat-only art variants.

A second max-effort review over the combined branch found fifteen more, all now fixed with
regression tests. The four that mattered most: the plugin-update capability scope listed the package
`.zip` but not the `.zip.sha256` fetched right after it, so trusted updates could never complete —
the guard test had only checked that the `.zip` pattern *existed* rather than matching real URLs
against the compiled patterns; rotating a reaction arrow applied the angle twice, because the
anchors were rotated and `rotation` incremented while both renderers apply that transform
themselves; flipping never touched arrow anchors at all, so a mirrored scheme kept every arrow's
original direction; and the formula body pattern backtracked exponentially — measured at 8.8 s for
26 digits, doubling per digit — so a pasted numeric label froze the UI thread. The rest covered
plugin-update failure paths that lost catalog records or deleted live payloads, a chain that could
seed a bond-less carbon at a page edge, CDXML inventing `FullHead` for an unrecognized arrow, and a
Customize gallery that keyed off the user's own layout and so deleted any art tool they removed.

Known remaining gap at the time of shipping: the Art inspector still styles only graphics and
molecules, so Color Controls and Object Settings route a bracket or arrow selection to a status
message rather than a working panel. Widening `ArtInspectorStyleObject` is its own slice. **Still
open** — tracked in `PLANS.md`.

### Objective

An audit found 32 non-functional toolbar buttons/commands: 8 drawing-tool stubs hardcoded to
"Requires an active structure editor" (`apps/desktop/src/drawingTools.ts`), 15 manifest-only stubs
with no live handler (`apps/desktop/src/toolsets/desktop-toolsets.json`), 4 orphaned
`view.toolset.*` customization commands and 4 unwired `style.*` commands
(`apps/desktop/src/commands.ts`), and the Customize gallery offering all of them for drag-out. Two
documented policies conflicted: the older contract tolerated disabled-with-reason placeholders,
while `docs/architecture/native-art-toolbar-chrome-plan.md` mandates hide-don't-disable.

This slice adopts the strict policy repo-wide and wires real functionality wherever existing
infrastructure supports it. After it, shipped toolsets contain zero permanently disabled buttons:
every visible button performs its action, and `disabledReason` is reserved for transient,
state-dependent unavailability (selection-dependent commands and similar).

Key mechanic: `apps/desktop/src/toolsets.ts` merges live `CommandSpec`s over manifest items, so a
live command's enabled state and `disabledReason` win. Un-stubbing means registering live behavior;
the JSON `disabledReason` strings are only fallbacks for commands with no live spec.

### Command retirements (the narrow, explained fix)

These command IDs were retired in this slice. Retirement is deliberate and documented here per the
AGENTS.md command-ID stability rule; each can return via git when its feature slice lands.

- `view.toolset.resetLayout`, `view.toolset.resetAllLayouts`, `view.toolset.createUserToolset`,
  `view.toolset.cloneToolset` — the Customize Toolbars dialog performs these actions directly
  through `layoutStateEdits.ts`; the standalone command entries were dead redirects.
- `style.bondStroke`, `style.textSize`, `style.preset.synthetic` — reasonless disabled stubs with
  zero references; superseded by the live style widgets and Molecule Inspector.
- `style.importStyleSheet` — redundant: the Molecule Inspector already imports `.cds` style sheets
  through the style compatibility boundary.
- `tool.mechanismArrow` — mechanism arrows need a real subsystem (atom/bond anchoring, curved
  geometry, half-head markers, renderers, CDXML mapping; `packages/mechanism-tools` is a type stub).
  Deferred to its own future slice; no decorative button meanwhile.
- `tool.templateGrid` — the template library (`packages/template-library`) is an empty stub; a
  template corpus plus grid-picker UI is its own future slice.
- `tool.arrows` — pure duplication of `tool.reactionArrow`'s command-grid submenu.
- `tool.toolOptions` — no defined behavior; lived only in the hidden `core.style` toolset.
- `tool.shape` — manifest items re-point to the live `tool.art.rect` command (shared `Art_Shapes`
  asset per the one-asset-per-command rule); the vague duplicate ID retires.
- `tool.shapeShadow` — retired outright: shadow art variants (`tool.art.rectShadow`,
  `tool.art.circleGloss`, …) are deliberately compat-only and stay out of shipped toolbars; shadow
  styling is applied through the Art inspector's effects.

`surface.canvas.addPageAfter` stays as disabled metadata: the surface registry does not drive
rendered UI (PLAN.md 6.15 sanctions it explicitly — "may exist only as disabled metadata until
`document.addPageAfter` is implemented and wired").

### Disposition of all audited items

| Disposition | Items | Phase |
| --- | --- | --- |
| Wire | tool.atom, tool.settings, style.color, tool.dagger, tool.symbol | 2 |
| Wire | tool.reactionArrow, tool.resonanceArrow, tool.equilibriumArrow, tool.retroArrow | 3 |
| Wire | tool.lobe, tool.shadedLobe, tool.pOrbital, tool.sOrbital | 4 |
| Wire | tool.bracket, tool.squareBracket | 5 |
| Wire | tool.chain, style.formulaText | 6 |
| Re-point | tool.shape → tool.art.rect | 2 |
| Retire | tool.shapeShadow (shadow variants are compat-only; Art inspector effects own shadows) | 2 |
| Retire | mechanismArrow, templateGrid, arrows, toolOptions, importStyleSheet, bondStroke, textSize, preset.synthetic, 4 × view.toolset.* | 1 |
| Keep | surface.canvas.addPageAfter (non-rendered metadata) | — |

### Design decisions

- **Arrows are semantic objects.** *(Reversed 2026-08-02 by the "Toolbar, palette, and arrow bug
  fixes" slice earlier in this file: the four families became art arrows tagged for CDXML
  interop.)* The four wired arrow tools create `reaction-arrow`
  document objects (`packages/chem-core`), not art graphics: the semantic type already has canvas
  rendering, selection/move/transform support, SVG export, and CDXML export+import. Art-route
  arrows would make tool-drawn and CDXML-imported arrows different object types. `arrowKind` gains
  `"resonance"` (additive; round-trips verbatim). Head geometry gets one shared plan in
  `packages/layout-engine` (`planReactionArrowGeometry`: forward filled head, equilibrium harpoon
  pair, retrosynthesis open double-shaft, resonance double-head) consumed by both the canvas
  renderer and SVG export.
- **Unwirable remainder is deleted, not hidden.** No new schema `hidden` field, no seeded layout
  state. Deletion is git-reversible and keeps exactly one honesty mechanism.
- **The Customize gallery excludes permanent stubs** using a static manifest-derived set (specs from
  `getToolsetCommandSpecs()` are availability-independent) — never live `enabled === false`, which
  would wrongly hide transiently disabled commands like Undo and the align/boolean family.
- **Chain uses press-drag rubber-band**: one gesture, one undo entry, no modal click-state machine.
  Segment count from drag length / `bondLengthPx`; zig-zag `±(180 − chainAngleDegrees)/2` about the
  drag axis, with `chainAngleDegrees` resolved from the target molecule's style.

### Delivery sequence

Each phase was one independently green commit (code + pinned-test updates together). The
"expected stub set" test introduced in Phase 1 asserts the exact remaining stub command IDs and
shrinks every phase, reaching empty in Phase 6 and locked by a policy test in Phase 7.

- **Phase 0 — Docs.** The PLANS.md section; AGENTS.md Toolbar Button Contract and §9 updates;
  PLAN.md §6.11/§6.13 updates; build stamp.
- **Phase 1 — Cleanup.** Delete the retired commands (`commands.ts`, `drawingTools.ts`,
  `desktop-toolsets.json` including the two retired IDs inside `tool.reactionArrow`'s submenu);
  gallery stub filter at the `MainWindow.tsx` call site; rewrite the placeholder-count test into the
  exact-stub-set test; update customize-command, chrome-cluster, and manifest-position tests; add a
  gallery-exclusion test.
- **Phase 2 — Quick wires.** `tool.atom` activates the existing atom-label editor on atom click;
  `tool.settings` toggles the Molecule Inspector toolset; `style.color` opens the existing
  object-color controls for the selection; shape/shapeShadow manifest re-points; `tool.dagger` and
  `tool.symbol` become glyph-stamp tools (one text object per click, command-grid submenu of common
  chemistry symbols).
- **Phase 3 — Arrows.** Enum + CDXML import case; shared geometry plan; canvas + SVG renderers on
  the plan; `insertNativeReactionArrow` with click-place and drag-place; enable the four tools.
- **Phase 4 — Orbitals.** Four parametric art-shape rows (teardrop lobe, gradient shaded lobe,
  mirrored two-lobe p orbital, radial-gradient s orbital) with their chemistry command IDs; the art
  pipeline provides pointer handling, transform chrome, and SVG export for free.
- **Phase 5 — Brackets.** Shared `bracketGlyphPathD` generator moves into `layout-engine`; real SVG
  export fragment replaces the labeled-box fallback; `insertNativeBracket` click placement; canvas
  glyph consumes the shared generator.
- **Phase 6 — Chain + formula text.** `planNativeChain`/`applyNativeChainPlan` press-drag tool with
  live preview, Esc cancel, single history entry; `style.formulaText` becomes a one-shot formatting
  command (element-trailing digits → subscript, trailing charge → superscript) over selected text
  objects.
- **Phase 7 — Closeout.** Policy lock test (zero permanently disabled specs in shipped toolsets;
  gallery exclusion holds); usage-hint invariant covers every definition; final stamps.

### Verification

Per phase:

```bash
pnpm vitest run \
  apps/desktop/src/App.test.ts \
  apps/desktop/src/drawingTools.test.ts \
  apps/desktop/src/toolsets.test.ts \
  apps/desktop/src/commands.test.ts \
  apps/desktop/src/documentWorkflow.test.ts \
  apps/desktop/src/toolbars/CustomizeMainToolbar/galleryModel.test.ts \
  packages/layout-engine/src/index.test.ts
```

plus `packages/chem-core` and `packages/cdx-compat` suites when touched. At closeout:

```bash
pnpm lint
pnpm build
git diff --check
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Manual stress pass in the running app after Phases 3, 5, and 6: draw each arrow kind and resize its
heads, place and resize both bracket kinds, drag a chain off an existing atom and off empty canvas,
apply formula text to a typed formula, and confirm SVG export matches the canvas for each.

Definition of done, as met:

- Shipped toolsets contain zero permanently disabled buttons; every visible button performs its
  action.
- The Customize gallery cannot produce a decorative disabled button.
- Reaction, resonance, equilibrium, and retrosynthesis arrows are semantic objects that round-trip
  CDXML. *(Reversed 2026-08-02, PR #26: art arrows that round-trip CDXML — see below.)*
- Orbitals, brackets, symbols, chain, and formula text create real document objects with undo/redo,
  save/reopen, and SVG export parity.
- AGENTS.md, PLAN.md, and the plans file describe the shipped state; build stamps updated.

---

## Host-managed plugin updates (2026-07-25) — on `main` (PR #21, merge `a7c88a69`)

A concurrent session's implementation was ported file-by-file rather than merged: its branch forked
before the toolbar slice, so taking its tree would have reverted eight commits of tool wiring. It
landed on `main` alongside the toolbar slice through PR #21. Only two things were carried forward
from an earlier parked snapshot, both reworked.

(Every branch involved — the concurrent session's, the parked snapshot's, and the shared feature
branch — has been deleted. PR numbers and commit SHAs are the durable references; branch names are
not, so this file names them only where one still exists.)

Ported forward from the parked snapshot:

- `pruneOrphanedPluginPackages`, which reclaims checksum-addressed directories left by a failed
  update or an incomplete cleanup. Its first version keyed off "no records", which
  `loadInstalledPluginRecords` also returns for an unreadable, truncated, or partially-invalid
  catalog — so a momentary IO problem would have deleted a healthy install's payload. The catalog
  now reports `absent` / `loaded` / `unreadable`, and the sweep acts only on the first two.
- The published `.sha256` is fetched and must agree with the digest GitHub recorded for the asset,
  which makes the existing sidecar-must-exist rule mean something. It reuses the same bounded,
  redirect-validating download path as the package, so it is size-capped while streaming rather
  than after buffering, and accepts the uppercase digests Windows publishers produce.

Fixed in the incoming implementation:

- `uninstallPlugin` validated the recorded staging path *after* unregistering the plugin, so a path
  the validator rejects left the plugin gone from the session but still in the catalog — an
  unremovable ghost. Validation now happens before any runtime state changes.
- Rollback re-activated the superseded descriptor even when it had never been deactivated, which
  could throw and abort the rollback, leaving the host registered against a candidate whose
  directory was about to be deleted.
- A disabled-plugin update tore down only the candidate, leaving the old worker running against
  files that were then removed.
- The trusted redirect host was spelled out in both TypeScript and the capability file with nothing
  keeping them in step; a test now pins them together, since GitHub has moved that host before.

### Objective

Add a separate, user-initiated plugin update path to the existing Plugin Manager. ChemDraft owns
the update source, download, package verification, worker handshake, replacement transaction, and
rollback. Plugins remain sandboxed and receive no new network, filesystem, or native-execution
capabilities. Sparkle continues to update only the ChemDraft application bundle.

The first trusted catalog entry is the standalone NMR Predictor plugin
(`org.chemdraft.nmr.predictor`). A check must distinguish update available, up to date, unsupported,
and failed states without silently installing anything. Applying an offered update requires an
explicit user action and must show the target version and package-integrity details.

### Safety and compatibility contract

- Update metadata is host-owned and allowlisted by plugin id; an installed plugin cannot choose its
  own download URL.
- Remote version and checksum metadata are treated as untrusted input and validated before use.
- The downloaded archive must pass the existing SHA-256, CRC/path, strict manifest, API-version,
  permission-review, and worker-handshake gates.
- The archive manifest id must match the installed plugin id, and its version must be strictly newer.
- Replacement is transactional: keep the current package and registration usable until the new
  package has passed staging and handshake, then commit the new package and record. Any failure
  restores the old package, record, registration, and enabled/disabled preference.
- Update checks and installs are user-initiated in this slice. No background polling, silent
  download, silent install, or restart-time mutation.
- A checksum proves integrity only, not publisher identity. The UI and documentation must not call
  an unsigned package cryptographically signed or fully automatic; publisher-signature support is
  a separate follow-up.

### Verification

- Focused tests cover catalog allowlisting, metadata parsing, semantic version comparison, download
  checksum enforcement, manifest-id/version enforcement, successful replacement, rollback, and
  disabled-plugin preservation.
- Plugin Manager DOM tests cover checking, up-to-date, available-update, progress, confirmation,
  success, and error states.
- Run `pnpm lint`, `pnpm test`, `pnpm build`, `git diff --check`, and the relevant Rust checks when
  native code changes.
- Launch this worktree through `./run-app` or `./run-app --dev` and verify the visible worktree
  label in the window title and build stamp matches the branch you meant to test.

---

## Sparkle macOS updates (2026-07-24)

The desktop app uses Sparkle 2 to check the signed macOS appcast automatically and offer newer
versions through Sparkle's native UI. File > Check for Updates… triggers a visible user-initiated
check. Sparkle replaces the application bundle only; installed plugin packages remain in the stable
Application Support `installed-plugins` directory and are revalidated by the normal runtime after
relaunch. Plugin/API incompatibility remains the plugin author's responsibility and must not block or
rewrite an app update.

Release and notarization procedure lives in `docs/releasing/macos-updates.md`.

---

## Runtime union merge (2026-07-16, merge commit `1232a444`)

The plugin program (M1–M36: plugin runtime, NMR/mass analyzers, worker isolation, packaging,
installer, manager) merged into the trunk per ADR-0030: trunk = `main`, plugin architecture = the
plugin program's, with main's four unique plugin pieces (stable command registry,
toolset-contribution stage, disk-backed plugin storage, patch-review tray) ported onto that runtime
and one unified panel renderer serving both the in-app surface and floating panel windows. That
program's full plan and milestone records live in the planning workspace
(`~/Documents/programming/Chemdraft-NMRplugin`) and in `docs/nmr-plugin-planning/`; they are not
duplicated here. Remaining plugin-separation work (publish the SDK, strip bundled NMR,
from-zero install test) is queued there as PLAN-plugin-separation Phases 2+.

The shipped rules this left behind are recorded in AGENTS.md §8a.

---

## Rings Toolbar and Molecule Inspector Tabs (completed 2026-07)

The Rings/Structure/Atom Labels slice shipped: ring appearance lives in its own compact
`core.ringInspector` toolbar, and the Molecule Inspector carries Structure and Atom Labels tabs with
multi-molecule targeting, mixed values, sparse per-atom overrides, `.cds` style-sheet import through
the style compatibility boundary, `.template` export, and a shared font catalog backed by the raster
export font database. Durable schema and architecture notes live in
`docs/architecture/toolbars-and-toolsets.md` and `packages/toolset-registry/README.md`.
