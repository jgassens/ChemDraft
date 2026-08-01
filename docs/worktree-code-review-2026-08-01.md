# ChemDraft Whole-Worktree Code Review

**Review date:** 2026-08-01
**Branch reviewed:** `codex/toolbar-bug-fixes`
**Reviewed head:** `6c9d4ee7`
**Scope:** the entire worktree — all 24 packages, `apps/desktop` (TypeScript + Rust),
`examples/plugins`, `tools`, `scripts` — not just the branch diff. Companion to
`docs/toolbar-bug-fixes-code-review-2026-07-31.md`, which covered the diff only.

## Method

Nineteen parallel reviewers, each assigned a coherent subsystem (per-package for
`packages/*`, line-range splits for the two monoliths `MainWindow.tsx` and
`documentWorkflow.ts`, one reviewer for the Rust side, one cross-cutting test-quality
audit). Every reviewer read `AGENTS.md` and `PLANS.md` first and reviewed against those
contracts. All P1 claims and the load-bearing P2 claims were then **independently
re-verified against the source by the coordinating reviewer**, including the external
CDXML spec citation. Repo health during the review: `git diff --check` clean,
`pnpm lint` (tsc) clean, `pnpm test` green — 131 files, 1942 passed, 10 skipped
(3 files skipped deliberately: oracle suites gated on a local RDKit venv).

## Executive summary

| Priority | Count | Meaning |
|---|---:|---|
| P1 | 5 | Release-blocking: chemistry corruption, data loss, crash, or silently dead user-facing feature. |
| P2 | 22 | Significant defects or contract violations. |
| P3 | ~50 | Minor, latent, misleading-but-harmless. Collected in the appendix. |

Two findings are **branch-introduced regressions**: the autosave gate (P1-3) and the
stale-shortcut/gallery residue class (several P2/P3). Two P1s (CDXML coordinates,
`take_pending_open_document`) **predate the branch and live on `main`** — a
whole-worktree review is what surfaced them; both sit squarely in the branch's own
headline areas (CDXML interop, native file handling).

The 2026-07-31 diff review's two P1s (fishhook/no-reaction SVG export loss, transposed
arrow frames relative to their own endpoints) and its art-engine findings (F-05, F-09)
were **verified fixed** in this checkout, with regression tests.

No reviewer found any path where this branch mutates atom identity, bond order, charge,
or stereochemistry through normal editing. The chemistry risks that do exist are at the
interop seams: CDXML import/export (P1-1), the plugin patch channel (P1-2, P2-1), and
silent degradation in paste paths (P2-16).

---

## P1 findings

### P1-1. CDXML 2D coordinates are parsed/written transposed against the spec; the ChemDraw "rotation" compensation composes into a stereo-inverting mirror

**Confidence: high — independently verified against the official spec, the code, and the
repo's own test numbers. Predates the branch (introduced `f92907fc`, June); present on `main`.**

- Locations: `packages/cdx-compat/src/index.ts:2786` (`parseCdxmlPoint`), `:2764`
  (`formatPoint`), `:2831` (`parseBoundingBox`), `:2823`/`:2827` (formatters),
  `:2706-2712` (`importTransformForTree`), `:1349-1352` (rotation + graphic exemption),
  `:2123-2162` (branch's YX-aware arrow-frame path).
- The [official CDX/CDXML spec (CDXCoordinates data types)](https://chemapps.stolaf.edu/iupac/cdx/sdk/DataType/CDXCoordinates.htm)
  states, with worked examples: in **CDXML**, `CDXPoint2D` is "**x coordinate followed by
  y coordinate** … Note that this ordering is different than in CDX files!" (1″ right, 2″
  down → `"72 144"`), and `CDXRectangle` is "**left, top, right, and bottom**"
  (→ `"144 72 288 216"`). The y-first order exists **only in binary CDX**.
- ChemDraft's parser reads every 2D CDXML attribute as "vertical horizontal" (y x) — the
  binary-CDX order applied to XML. Verified: `parseCdxmlPoint` binds
  `[vertical, horizontal]`, `formatPoint` writes `y x`, `parseBoundingBox` binds
  `[top, left, bottom, right]`.
- To compensate, `importTransformForTree` rotates all page objects CCW-90 when
  `CreationProgram` matches `/\bChemDraw\b/i`. Transpose (reflection across the diagonal)
  ∘ rotation (det +1) = **reflection** (det −1): the net import of a real ChemDraw file is
  a mirror, not a rotation. Wedge/hash geometry inverts; `AS` R/S strings import verbatim
  (`index.ts:1524-1536` builds `chemistry.stereochemistry` from the raw assignments with
  no geometric re-derivation). The document ends up claiming `R` over a depiction that now
  shows `S` — silent stereochemistry corruption (AGENTS §10, §11 Tier A) on the flagship
  interop path. E/Z is mirror-invariant and survives.
- **Corroboration from the repo's own test:** `index.test.ts:618-640` ("ChemDraw 26")
  feeds `p="100 120"` with label `p="96 118"` — spec-correct label offset is
  (−2.67, −2.67) (label left of atom); the test asserts **(+2.67, −2.67)** — the x-sign
  flip is the mirror, baked into expectations. The test's single vertical bond is
  mirror-invariant, so it passes either way. Its `BoundingBox="0 0 540 720"` is a portrait
  7.5″×10″ ChemDraw page only under the spec reading.
- **Second corroboration:** RDKit's CDXML parser reads `p` x-first
  ([CDXMLParser.cpp](https://raw.githubusercontent.com/rdkit/rdkit/master/Code/GraphMol/FileParsers/CDXMLParser.cpp))
  and passes stereo tests against real ChemDraw files.
- **Molecules and graphics are transformed differently:** graphics marked
  `cdxmlCoordinateSpace: "xy"` skip the rotation (`:1350-1352`) and take only the raw
  transpose (diagonal mirror), while molecules mirror vertically — a horizontal reaction
  arrow on a ChemDraw page imports **vertical**, diverging from the molecules beside it.
- **Export side:** `formatPoint`/`formatBoundingBox` write y-first, so the *visible* layer
  ChemDraft exports is transposed for every spec-conforming reader (ChemDraw, RDKit,
  ChemAxon). ChemDraft↔ChemDraft round-trips stay exact via the embedded native payload,
  which is what makes the defect invisible to the entire synthetic-fixture suite.
- **Fix direction:** parse/write 2D attributes per spec (x-first points,
  left-top-right-bottom boxes), delete the CCW-90 rotation, and add real-ChemDraw-captured
  fixtures including an asymmetric chiral molecule with wedges and a horizontal arrow on
  the same page. A migration shim is needed for files ChemDraft already wrote in the
  transposed convention (detect via `CreationProgram` + codec version). This predates the
  branch but the branch extends the convention (new YX arrow-frame path) and PLANS.md B3
  makes CDXML interop a headline contract — it must be fixed, or B3's "other programs
  still read these as reaction arrows" is false.

### P1-2. A cyclic proposed patch crashes the whole desktop app through a non-cycle-safe `deepFreeze`

**Confidence: high — empirically reproduced against the real host by the reviewer.**

- Location: `packages/plugin-host/src/index.ts:665-673` (`deepFreeze`, no visited-set),
  via `snapshotProposal` (`:661-663`), reachable from `proposePatch` (`:428-430`),
  `listProposedPatches` (`:433-437`), `rejectProposedPatch` (`:453-459`).
- The patch interior is deliberately `passthrough()` (`plugin-api/src/index.ts:530-550`),
  and `structuredClone`/`postMessage` preserve cycles, so any plugin with
  `document.proposePatch` can queue a cyclic object. Reproduced: `proposePatch`,
  `listProposedPatches`, and `rejectProposedPatch` all throw
  `RangeError: Maximum call stack size exceeded`.
- The poisoned entry lands in the queue *before* the throw, `PatchReviewTray` calls
  `listProposedPatches` during render, and there is **no error boundary anywhere in
  `apps/desktop/src`** — the React tree unmounts, the tray can never render to dismiss the
  entry, and a hostile plugin can re-trigger after every restart. Untrusted plugin input
  crashing the trusted main thread is the class the prototype-pollution guard (which *is*
  cycle-safe) was added for (§16).
- **Fix direction:** give `deepFreeze` a `seen: Set<object>`; snapshot before
  `proposedPatches.set` so an unsnapshotable proposal never enters the queue; add a
  hostile-cyclic-payload test.

### P1-3. Autosave gate never opens on clean "nothing to restore" reads — autosave permanently dead for new users (branch regression)

**Confidence: high — verified line-by-line. Introduced by this branch's A4 (`13067a1b`).**

- Location: `apps/desktop/src/MainWindow.tsx:6606-6615`, `:6624-6629`; ref initialized at
  `:1765`.
- `documentSessionSaveEnabledRef` starts `false` and line 6629 is the **only** place it is
  ever set `true` (grep-verified) — but the restore effect `return`s before reaching it
  when (a) there is no session file (`parseDocumentSessionEnvelope(null)` → falsy), (b)
  the envelope says don't restore, or (c) the canvas isn't pristine. A first-run user hits
  (a): the gate never opens, `saveDocumentSession` (`:6657`) never fires, no session file
  is ever written, and every subsequent launch also finds nothing — autosave is
  permanently, silently disabled for that user. Case (c) disables it for any session where
  an OS "open with" beats the restore.
- A4's intent (and the comment at `:6625`) was to gate only on *failed* reads; a `NotFound`
  read is a clean read of "no session" and should un-gate. Pre-A4 code autosaved
  unconditionally in these cases. The existing test (`App.test.ts:366-379`) is a
  source-text regex guard and cannot see the unreachable assignment (see P2-21).
- **Fix direction:** set the ref immediately after `loadDocumentSession()` resolves
  (before the envelope/pristine early returns), keeping it `false` only in the `.catch`;
  add a behavioral test for the first-run path.

### P1-4. Anchored chain drag commits the preview-only molecule — stale SMILES/chemistry persisted

**Confidence: high — verified against the code and the feature's own documented contract.**

- Location: `apps/desktop/src/MainWindow.tsx:9381` (chain branch of
  `nativePlacementDocumentFromDrag`) consumed by `commitNativePlacementDrag`
  (`:9396-9407`); `documentWorkflow.ts:14162-14164`.
- The same function produces per-move preview frames **and** the final commit, and the
  chain branch always passes `{ preview: true }`. With `preview`,
  `appendNativeCarbonVertices` returns `normalizeNativeMoleculeGeometry(...)` and skips
  `refreshNativeSingleBondGraph` — the only place `structure` (SMILES) and `chemistry`
  metadata are re-derived. The committed molecule has the new atoms/bonds but the
  pre-drag `structure`/`chemistry`.
- The feature's own doc contract says the opposite: *"The commit at the end of the gesture
  runs without this flag and derives once, so what lands in the document is always fully
  derived"* (`documentWorkflow.ts:1057-1058`), and `documentWorkflow.test.ts:1363-1367`
  asserts it. Only **dragged** chains off an existing atom are affected (the click path
  and the unanchored path commit without the flag). Visually invisible; the Ketcher
  adapter and plugin selection snapshots parse `structure`, so an editor round-trip or
  SMILES export after the drag silently drops the appended chain (§10, §5.7). AGENTS §20
  manual stress explicitly lists "chains dragged off an existing atom".
- **Fix direction:** for the final commit, call `applyNativeChainTool` without
  `{ preview: true }`; add a MainWindow-level test asserting the committed `structure`
  reflects the grown graph.

### P1-5. `take_pending_open_document` is registered but never capability-granted — cold-start "Open With" silently opens nothing

**Confidence: high — verified: registered (`lib.rs:471`), defined (`lib.rs:1983`), invoked
(`MainWindow.tsx:25095`), absent from `capabilities/default.json`, `build.rs`, and
`permissions/autogenerated/`. Broken on `main` since introduction (`f92907fc`).**

- Tauri v2 ACL is deny-by-default, so every invoke rejects; the JS swallows it
  (`MainWindow.tsx:6580` `.catch(() => undefined)`). `handle_opened_document_urls`
  (`lib.rs:2020-2044`) explicitly relies on this drain for the cold-start path because the
  Tauri event emit is lost before the JS listener attaches. So: double-click a
  `.chemdraft`/`.cdxml` file with the app not running → app launches, payload stashed,
  emit lost, drain denied and swallowed → empty document, no error. `tauri.conf.json`
  `fileAssociations` advertises exactly this workflow.
- This is the branch's own A5 "standing lesson" recurring: *a missing Tauri capability
  fails silently through swallowed JS rejections.* Nothing guards the class (see P2-21).
- **Fix direction:** add the command to `build.rs`'s app-manifest list and grant
  `allow-take-pending-open-document` in `capabilities/default.json`; clear the pending
  payload after a successful warm emit (a stale payload would re-open on webview remount);
  add a cross-check test of `generate_handler!` ↔ capability grants ↔ build.rs.

---

## P2 findings

### Plugin channel and document core

**P2-1. `updateObject` treats explicit `undefined` in `changes` as "reset to default", silently erasing atoms/bonds/style.**
`packages/chem-core/src/patches.ts:198` spreads `changes` over the object and re-parses;
explicit `undefined` keys survive the spread and zod applies `.default([])` (verified:
`schemas.ts:387-388`). `applyPatch(doc, { op:"updateObject", changes:{atoms:undefined} })`
wipes a molecule's graph with no error. Reachable via plugin proposed patches: the
proposal schema is `{ op: string }.passthrough()`, and `PatchReviewTray` shows only
plugin name + reason — the user approves blind (§10, §5.7). *Fix:* drop undefined-valued
keys before merging; validate `changes` against the object's partial schema in plugin-api.

**P2-2. `documents.getActiveDocument()` hands in-process plugins the live, mutable document.**
`packages/plugin-host/src/index.ts:390-394` returns the provider value with no clone or
freeze — ten lines after the selection API deep-copies and freezes with the comment
"never a live document reference". In-process plugins are a supported path (the MolScribe
canary deliberately stays in-process). No shipped in-process plugin declares
`document.read` today, so latent — but §6.5/§16 enforcement belongs in the host, not in a
transport accident. *Fix:* `structuredClone` + freeze, mirroring the selection path.

**P2-3. Plugin storage JS layer re-swallows the exact read/write errors A4 made loud.**
`apps/desktop/src/plugins/pluginStorage.ts:24` (`.catch(() => null)` flattens read
failures into "absent", arming a clobbering write) and `:48-53` (write failures swallowed;
the plugin's `set()` resolves successfully even when the write was rejected). This
re-introduces the A4 data-loss trap one layer up for `storage.json`. *Fix:* distinguish
absent (`null`) from failed (rejection); disable saving or surface a diagnostic on
failure. The file has no test at all.

**P2-4. "Open as window" detaches the panel before the native open, then swallows failure.**
`apps/desktop/src/MainWindow.tsx:7464-7479`: `detachPanel(...)` removes the panel from the
in-app surface, then `openPluginPanelWindow(...).catch(() => undefined)` — if the invoke
rejects, the panel is stranded: not visible anywhere, unreachable, cleared only by plugin
disable/reload. *Fix:* re-attach on failure and surface a status.

**P2-5. KetcherAdapter records the loaded object before the engine load succeeds.**
`packages/ketcher-adapter/src/index.ts:170-172` assigns `loadedObject` then awaits; on
rejection the stale `loadedObject` lets a later `saveObject()` attribute the *previous*
molecule's structure to the new object's id/metadata. Reachable via `KetcherEditorHost`'s
Apply button after a failed load (§10 silent mis-attribution). *Fix:* assign after the
await resolves; add a save-after-failed-load test.

### Arrows, art geometry, and flip (the branch's flagship surfaces)

**P2-6. `svgPathSamplePoints` appends bbox corners; polyline/bezier marker plans and hit-testing walk phantom segments.**
`packages/art-engine/src/index.ts:3337`: default `includeBounds: true` appends four bbox
corners to the ordered sample list. Reviewer reproduced live: an L-polyline with
`markerEnd` yields a `visiblePathD` that scribbles a rectangle and places the arrowhead at
the bbox corner; marquee/lasso reports hits in empty bbox-edge regions. Reachable in-app
because `graphicObjectSupportsMarkers` accepts any open stroke. *Fix:* exclude corners by
default; opt in only from the two frame-bounds call sites.

**P2-7. `splitLinePathSegmentAtPoint` keeps arrow identity — contradicts the branch contract and produces the corrupt objects above.**
`packages/art-engine/src/index.ts:2216-2231` deletes only line/arc fields; scissors-split
arrows keep `markerEnd`, `artToolId`, `dualShaft*`, `shaftMark` (reproduced). PLANS.md
Thread C says splitting "converts arrows to plain polylines and destroys their arrow
identity" — nothing does that, and the tagged polyline still exports as
`ArrowType="FullHead"`, losing the bend with no warning (§5.7/§14). *Fix:* strip
`artToolId`, markers, `shaftMark*`, `dualShaft*` in the split; add the contract test.

**P2-8. Click-placed wavy lines render one curve but sample another — adding a head swaps the visible geometry.**
Render fallback (`index.ts:3627-3636`) draws a horizontal 3-hump wave; the sampler
(`:3237-3244`) walks a diagonal multi-sine between inset corners. Reproduced: adding a
marker via the inspector visibly flips the wave from horizontal to diagonal; hit-testing
follows the wrong path. *Fix:* one generator for both paths.

**P2-9. Flip of a rotated graphic keeps its rotation — the mirror renders 2θ off.**
`apps/desktop/src/documentWorkflow.ts:11710-11714`: `rotation: object.type === "graphic" ?
object.rotation : …`. The code's own comment says negating the angle is exact — then
carves graphics out. True mirror is `R(−θ)·M(data)`; the code produces `R(θ)·M(data)`. A
30°-rotated arrow flipped horizontally should render at 150°; it renders at 210°. The
legacy `reaction-arrow` branch right below negates correctly — the two arrow kinds
disagree, and this branch made *all* arrows graphics. *Fix:* negate for graphics too; add
a rotated-graphic flip test.

**P2-10. Flip does not mirror parametric arc angles — curved arrows keep their sweep direction.**
`resizeGraphicObjectDataForFrame` (`documentWorkflow.ts:9711-9765`) mirrors `arcCenter`
and scales radii but never touches `arcStartRadians`/`arcSweepRadians` (verified). For a
horizontal flip the correct map is `start' = π − (start + sweep)`, `sweep' = −sweep`. The
curated flyout's `curvedArrow90/180` and `fishhookCurved` are parametric arcs whose sweep
direction is the chemistry; flipping one silently keeps the original curve direction.
*Fix:* remap angles on negative scale; extend the arc-flip test to assert mirrored
start/sweep.

**P2-11. Legacy semantic-arrow commands are still offered in Customize and create deprecated `reaction-arrow` objects — PLANS.md B2's "no live caller" claim is wrong.**
`applyReactionArrowToolAtPoint` calls `insertNativeReactionArrow` and MainWindow invokes
it at three sites; the four legacy ids (`tool.reactionArrow` etc.) pass the
Customize-gallery filter (which only excludes `tool.art.*` compat variants), so the
gallery shows two identically-titled "Reaction Arrow" entries and the legacy one creates
the retired object type with none of the branch's editing mechanics. *Fix:* redirect the
legacy ids to `tool.art.*` at activation, or exclude them from the gallery; correct the
PLANS.md wording at closeout.

### Clipboard and paste

**P2-12. Molfile paste throws uncaught on malformed input; lenient detection makes ordinary prose reachable.**
`packages/clipboard-adapter/src/index.ts:294-299` detects `/\bV3000\b/` with no structural
requirement; `apps/desktop/src/documentWorkflow.ts:4642-4655` calls the throwing
`parseMolfileGraph` with no try/catch (the rxnfile branch right below has one).
Reviewer executed it: `"Bruker V3000 spectrometer manual"` classifies as molfile and
**throws** across the paste handler — paste silently does nothing (§16 "malformed imports
should fail safely"). *Fix:* same catch-and-warn as the rxnfile branch; tighten detection.

**P2-13. SMILES paste silently collapses `aromatic`/`unknown` bond orders to `single`.**
`apps/desktop/src/documentWorkflow.ts:4469` (duplicated at `MainWindow.tsx:4970`, mirrored
by the test helper `smilesPaste.test.ts:54`). The OCL adapter explicitly refuses this
exact collapse, citing §5.7; the schema and insert path accept `"aromatic"`. Latent today
(reviewer verified the RDKit depiction path currently kekulizes everything) but the
adapter documents order-4 bonds from un-kekulized rings, and the `unknown`→`single` arm is
precisely the cited violation. *Fix:* carry the orders through, or warn when collapsing.

### Toolbar/palette system (Thread A surfaces)

**P2-14. Reconcile: one *rejecting* palette open still drops the session to web palettes and clobbers saved visibility.**
`apps/desktop/src/toolbars/reconcileNativePalettes.ts:112-123` awaits `openToolsetWindow`
unguarded; a rejection (not the handled `open:false` miss) jumps to the attempt catch and,
after retries, yields `fallback` even when other palettes opened. MainWindow's fallback
handler (`:8587-8588`) then sets the default visible set, which the hydrated persistence
effect writes over the user's saved visibility. A3's leniency covers resolves, not
rejections. *Fix:* per-palette try/catch treating rejection like `open:false`.

**P2-15. `view.zoomIn`'s `Cmd++` shortcut is unresolvable from any real key event.**
`apps/desktop/src/commands.ts:76` binds `"Cmd++"` → stored chord `"Meta++"`; a real
keyboard produces `"Meta+="` (Cmd+=) or `"Shift+Meta++"` (Cmd+Shift+=) and `resolve()`
requires an exact match (`packages/shortcut-engine/src/index.ts:124-132,228-254`). The
keydown path is the only keyboard route to zoom-in; zoom-out works, so users hit an
asymmetric dead shortcut. *Fix:* bind `Cmd+=` or teach the engine the `=`/`+` equivalence.

**P2-16. `deleteHoveredNativeTarget` closes over stale `selectedNativeMoleculeParts` — Delete can destroy an unselected bond.**
`MainWindow.tsx:2846` reads the array but the callback deps (`:2925`) track only the last
element's identity; the array can shrink while the last element keeps identity (part
pruning at `:2496-2510`, double-click drop at `:12415-12417`). The stale callback deletes
the just-unselected bond. *Fix:* read via the already-mirrored ref, or fix the deps.
(Medium confidence on the trigger sequence; the mechanism is verified.)

**P2-17. `handlePagePointerCancel` omits the object-resize and corner-radius drags.**
Both capture on the page (`MainWindow.tsx:13609`, `:13249`) but the cancel handler
(`:11770-11884`) has no branch for them; a mid-drag pointer cancel leaves the preview
document in place, un-restored and with no undo entry — breaking the cancel-restores-start
invariant every sibling drag family keeps. *Fix:* add the two families mirroring the
object-rotate branch.

### Persistence and Rust

**P2-18. `load_toolset_layout_state` still swallows every read/parse error as defaults — and the load→mutate→save cycle then persists them.**
`apps/desktop/src-tauri/src/lib.rs:3183-3192`: `let Ok(contents) = fs::read_to_string(path)
else { return default() }; serde_json::from_str(&contents).unwrap_or_default()`. The write
side was rewired with `write_file_atomic` in A4; the read side is the exact trap shape A4
killed. A transient read error during a window `Moved` event loads defaults and writes
them over `toolbar-state.json`. *Fix:* reuse `read_optional_file` (same file); propagate
non-NotFound errors so the mutation skips the write.

### §5.26/§5.27 rendering-math contracts

**P2-19. Duplicated atom-label/valence stack in `documentWorkflow.ts` (§5.26 violation, already drifted).**
`documentWorkflow.ts:734-761,806-824,15463-15491` carries its own
`nativeAtomValence`/`nativeAtomDisplayLabel`/`implicitHydrogenLabelSuffix` etc. vs
layout-engine's `atomDisplayLabel` stack (`index.ts:4685-4842`). The copies have drifted:
layout-engine's honors `atomLabelShowTerminalCarbons`, `atomLabelHideImplicitHydrogens`,
`labelVisible === false`, and the H-before-element flip; the app copy honors none.
Currently latent (the app copy is called only from tests; `MainWindow.tsx:398` imports but
never calls it) — but this is exactly the divergence incident §5.26 was written for.
*Fix:* delete the app copies; move what the app needs into layout-engine and import.

**P2-20. Spin-3D overlay double-bond geometry diverges from the committed drawing (§5.26/§5.27).**
Three parts, all verified: (a) the overlay's `symmetric` flag
(`MainWindow.tsx:3461-3471`) is `isTerminalHeteroatomDoubleBond` alone, but
`bondLineSegments` renders symmetric only when no ring-interior/derivable/overridden side
exists — every aldehyde/amide/exocyclic C=O renders one-sided on canvas but
symmetric-straddle in the live overlay; (b) `flattenSpunMolecule`
(`documentWorkflow.ts:12847-12848`) then bakes `doubleBondSide` unconditionally, so a C=O
that rendered symmetric flips to one-sided on release — breaking "releasing changes
nothing visually"; (c) the overlay copies the inset formula with a duplicated constant
(`DOUBLE_BOND_MIN_VISIBLE_SEGMENT_PX = 13`, `MainWindow.tsx:1273`) and misses the
terminal-methylene flush exception (`layout-engine/index.ts:4219-4221`). §5.26 names this
exact overlay as forbidden to carry its own copy. *Fix:* export the effective-side
derivation and the constant from layout-engine; don't bake `doubleBondSide` when the
symmetric condition holds.

### Test-quality (from the cross-cutting audit)

**P2-21. No positive test for the popover `core:window:allow-show` capability — the branch's own "standing lesson" is unguarded; and `App.test.ts`'s ~197 source-text regex assertions substitute for behavior in places that matter.**
The capabilities JSON is loaded in tests but only for *absence* assertions; deleting the
`allow-show` grant (or the `take_pending_open_document` grant P1-5 needs) fails no test,
and per A5 it would present as intermittent UI. Separately, 19 tests in `App.test.ts`
assert *only* source text — including the A4 autosave gate (P1-3), which is pinned by
regexes that cannot see the unreachable assignment. *Fix:* positive capability
cross-checks (handler ↔ capability ↔ build.rs); behavioral tests for the autosave gate
and cancel-restore paths; demote source greps to secondary.

**P2-22. Foreign `ArrowType="HalfHead"` imports as a full-headed arrow with no warning.**
`packages/cdx-compat/src/index.ts:2967,2032-2034` maps HalfHead → `filled-arrow`;
re-export launders it to `FullHead`. One-electron vs two-electron arrows are different
chemistry (§10, §6.6), and the branch just added the honest mapping (`half-arrow`
markers). *Fix:* map to `fishhookArrow` or emit a specific approximation warning.

---

## Verified clean (the other half of a comprehensive review)

These areas were specifically probed and held up:

- **Prior review's P1s fixed:** fishhook/no-reaction SVG export parity (layout-engine
  `:3628-3817` with substantive tests), arrow-frame-vs-endpoints transposition (regression
  test `cdx-compat/index.test.ts:1026-1053`), art-engine F-05/F-09 with regression tests.
- **chem-core patch application:** atomic per patch (clone → mutate → re-parse), addObject
  duplicate guard, crossing pruning granular and correct; molfile writer refuses >999
  loudly; identity/perspective stack refuse-first and honest.
- **CDXML envelope machinery:** native payload, tamper hashes, visible-layer conflict
  detection, base64url codec, from-scratch SHA-256 — sound and well tested. Warning
  coverage on export is genuinely §14-honest.
- **Plugin subsystem:** single persistent runtime; all registration through the runtime
  with whole-plugin rollback; install/update pipeline fail-closed at every probed step
  (CRC + SHA-256 + apiVersion + handshake + traversal guards in TS and Rust);
  `PluginReportRenderer` single renderer with host-side schema validation; worker bridge
  handshake/whitelist/teardown; storage scoping with Rust-side traversal tests.
- **Chemistry adapters:** OCL preserves aromatic/unknown honestly (§5.7); stereo
  perception excludes π-centers correctly; RDKit WASM handles deleted in `finally`;
  force-field budgets sum exactly; `relayoutMolfile2D` identity guard verified sound.
- **§5.26 outside the two findings:** spin overlay imports projection/scale helpers from
  `interaction/` (no duplicate projectors); canvas/export share one art plan; marker
  recipes mirror with identical constants.
- **§5.27 spin parity:** overlay↔flatten depth-cue recipes match line-by-line;
  stereo read-back refuses honestly instead of degrading.
- **Toolbars:** §2 button contract holds in `ToolbarPaletteItem` (invoke-once,
  disabled/submenu gating, ARIA); Thread A transports correct; shipped manifest has no
  permanently disabled placeholders; customize stack sound.
- **Rust:** `read_optional_file`/`write_file_atomic` correct with concurrency tests;
  installed-plugins serving (percent-decode before traversal check, symlink containment,
  worker CSP) solid; no JS-reachable panics.
- **Test suite overall:** no skipped tests (outside deliberate oracle gating), no
  tautologies, no mocking of the unit under test; chemistry tests assert real invariants
  (CIP re-perception, bond-order conservation, no-op identity).

## Consolidated test gaps (highest value first)

1. **Real-ChemDraw CDXML fixture** with an asymmetric chiral molecule + horizontal arrow
   on one page — the single fixture that would have caught P1-1. Every current fixture is
   synthetic and written in ChemDraft's own transposed convention.
2. **Capability cross-check test**: `generate_handler!` set ↔ `capabilities/*.json` ↔
   build.rs manifest — guards P1-5 and the A5 class.
3. **Behavioral autosave-gate tests** (first-run, open-beats-restore) for P1-3;
   MainWindow-level chain-drag commit test for P1-4.
4. **Rotated-graphic flip test** (P2-9) and **mirrored arc start/sweep assertion**
   (P2-10); existing flip tests use unrotated objects only.
5. **Marker-on-polyline/bezier tests** and **split-destroys-arrow-identity test** for
   P2-6/P2-7; no current polyline test carries markers.
6. **Plugin-channel hostile-input tests**: cyclic proposal (P1-2), explicit-undefined
   changes (P2-1), frozen document snapshot (P2-2), pluginStorage error paths (P2-3 —
   file has zero tests).
7. **Definition-of-done coverage gaps**: art-arrow CDXML export tested for only 2 of 4
   families; "no arrow paints on press" has zero coverage; late-join toolset-definitions
   request path untested.
8. **Reconcile rejection path** (P2-14) and **malformed-molfile paste** (P2-12) —
   currently only resolves and the happy path are tested.

## Appendix: P3 findings (deduplicated, by area)

**chem-core:** dead duplicate `artToolId` in `GraphicObjectStyleSchema` (live one is
`data.artToolId`; PLANS.md B2 cites the dead one); no object-id uniqueness invariant at
parse time; legacy graphic migration silently strips unknown keys even for *newer*
documents (forward-compat loss, no warning); `removeObject` leaves dangling
group/reaction/bracket references; `degradingEnum` `.catch` also degrades *missing*
required classifiers; molfile writer silently encodes `unknown` bond order as single.

**art-engine:** wrong-sign comment in `graphicEquilibriumGeometry`; dual-shaft arrows
hit-test only along their invisible axis at large scales; inspector offers markers on
freehand strokes that can never render them; null-drag on a sizeless marker writes a
spurious snapped default.

**layout-engine:** implicit-H label count blind to formal charge (alkoxide labels "OH-",
carbocation "CH+"); dead `LayoutCommandId`/`LayoutOperationRequest` exports + README
overclaims operations the package doesn't have; silent bracket-glyph and charge-mark
export approximations without warnings; numeric-only custom label renders its text twice.

**cdx-compat:** dead fallback for missing `Start`/`End` on unknown-kind arrows; foreign
equilibrium/retro shaft proportions silently defaulted (ignores
`ArrowShaftSpacing`/`ArrowEquilibriumRatio`); bonds referencing missing nodes import with
dangling refs and no warning. (Known open item: stale migrated-comment at
`index.ts:1980-1982`, already in PLANS.md.)

**clipboard-adapter:** V3000 line continuations never joined (wrapped `CHG` silently
lost); "vector artwork only" warning mislabels raster clipboard payloads.

**adapters:** RDKit embed payload trusted blindly while optimize payloads are strictly
validated (NaN coordinates possible); no atom-count-mismatch warning (OCL parity gap);
**AGENTS §6.19 is stale** — the package ships a real RDKit-WASM engine and a 7.5 MB
vendored WASM binary while the rulebook still says "placeholder" and forbids vendoring
(decision was deliberate per `81711038`; reconcile the rulebook).

**plugin system:** `document.write` permission declared but enforced nowhere (misleading);
`pluginFacingStructure` silently degrades to the known-lossy structure string on writer
failure; `LinkedFigureView` carries its own double-bond offset math (§5.26 tension, no
canvas parity needed — document the exemption).

**shortcut/viewport/style:** `normalizeKey` trims first so a Space binding can never
resolve; override `itemAdditions` never validate submenu command ids; .cds fixed-point
fields decode unsigned with no bounds (corrupt values applied as huge positives); .cds
header sniffing duplicated in the app instead of exported by style-compat.

**toolbars/palettes:** popover 600 ms cold-open safety net ignores dismissal;
`usePaletteButtonInvoke` eats the next keyboard activation after an aborted press;
Distribute button never exposes `aria-disabled`; gallery "Arrows & Reactions" section rule
is dead after the `tool.art.*` rename; MainStyleWidget latch can still freeze on a
release-outside-window; ~40 lines of dead drag-positioning code + stale 420 ms comment;
`ArtToolIcon` fallback missing equilibrium/retro glyphs.

**MainWindow / documentWorkflow:** dead 15 s sidecar-session timeout effect (unreachable
status string); autosave write failure swallowed at two levels; typed X/Y rotation stereo
refusal is silent and the readout still shows the refused values;
`reconcileFlattenedStereo` over-reports unresolved centers on cycle exit; dead reorder
helpers + stale doc citation; selection-page inconsistency latent until multi-page ships;
native SMILES/metadata internally inconsistent for charged atoms and aromatic orders;
group non-uniform scale treats rotated graphics in local axes vs molecules in page axes;
~145-line dead shape-projection geometry cluster (pre-art-engine path).

**misc app:** literal NUL bytes embedded in `moleculeInspectorModel.ts:842,847`
(branch-introduced, makes the file non-text to tooling — use the `` escape);
conformer worker restart budget never engages (counter pins at max, guard unreachable);
`resolveSelectionHit` is tested, exported, and never called in production (the shipped
ring-press path is a different function — tests give false confidence);
`moleculeStrokeToolbarPaintType` is a tautological ternary.

**Rust:** build.rs app-manifest list stale in both directions (8 dead commands listed, 15
live ones unlisted — currently harmless because the tomls are committed);
`rasterize_svg` and engine3d session commands run synchronously on the main thread (UI
stalls on big exports and during 3D sessions); palette `Moved` arm lacks the
`APP_QUITTING` guard the comment claims; multi-file OS open silently drops all but the
first document; `write_file_atomic` orphans its temp file on the write-error path.

**tooling/tests:** `plugin:extract` lacks the staging-inside-plugin guard `plugin:package`
has; `Engine3DProtocolVersion` not bumped when `"initial-relax"` was added to the wire
enum (discipline precedent, benign today); molscribe-ocsr mock V3000 molfile is
unparseable (no ATOM/BOND blocks); two committed zero-assertion scratch "tests"
(`test-resize.test.ts`, `test-resize2.test.ts`) plus an unrunnable root `test-resize.ts`;
oracle suites `describe.skip` without a local RDKit venv (deliberate, but CI never runs
the stereo cross-checks).

## Suggested fix order

1. **P1-3 + P1-4** (branch-introduced, small diffs, behavioral tests exist to write).
2. **P1-5 + P2-21** (one capability grant + the cross-check test that guards the class).
3. **P1-2 + P2-1..P2-3** (plugin-channel hardening: cycle-safe freeze, undefined-key
   filter, frozen document snapshot, storage error distinction).
4. **P2-9/P2-10/P2-7/P2-6** (arrow correctness on this branch's flagship surface).
5. **P1-1** (CDXML coordinate convention — the largest piece of work: parser/writer flip,
   rotation removal, own-export migration shim, real fixtures; deserves its own slice and
   an owner decision on backwards compatibility with ChemDraft-written files).
6. The P2 remainder and P3 sweeps as cleanup batches per area.
