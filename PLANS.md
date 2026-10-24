# ChemDraft Plans

This file describes **the slice currently in flight** — nothing else. Completed slices move to
`docs/shipped/README.md` when they land, so that an agent told to "follow PLANS.md" gets the work
in progress rather than a changelog.

---

# In flight

# ChemDraft Assistant plugin (active, branches claude/assistant-*)

## Objective

Add a document-aware Assistant plugin harness for local Claude Code and Codex. It can read the
current document and selection and place results directly on the page through typed host tools.

## Design decisions

- The host owns CLI discovery, pinning, install, sign-in, consent, command rendering, process
  lifetime, and local MCP; the plugin owns provider choice, prompt, transcript, and UI.
- Results land directly, with no approval window. Send fixes the write scope: selected objects and
  objects inserted by that request. Each request is one labelled undo entry, selects what changed,
  and redo never calls AI.
- A canvas overlay is allowed alongside the floating assistant panel. Consent names the receiving
  company and says document/page content leaves the computer.
- PRs B/C update AGENTS.md §4.4 and §12 with their corresponding behaviour.

## Delivery sequence

1. **PR A — runner (merged, #186):** external-tool catalog, pins, probe/install/sign-in, consent,
   supervised runs, plugin API tools, dialog/controller, and documentation.
2. **PR B — assistant tools + local tool server (current):** batch/write scope, direct assistant
   writes and request transaction, document tools, shared reaction/grid layout, API 0.1.9
   `assistant`, run-to-session binding, and the hardened loopback MCP server. Owner decisions are
   applied: writes need no approval window; scope is the Send selection plus request insertions;
   each request is one undo entry; provider web access is open.
3. **PR C — panel input + canvas overlay:** plugin input sections, panel action routing, and the
   viewport prompt overlay.
4. **Plugin repository:** `org.chemdraft.assistant`, providers, system prompt, transcript, tests,
   and release.
5. **PR D — catalog + docs:** official catalog entry, release URLs, agent documentation, and slice
   closeout.

## Verification

- macOS and Windows probe/install/sign-in/cancel paths; no batch shims or console flash.
- Pinned download checksum, archive-entry, signature, and rollback tests; release pin check.
- Consent is per plugin/tool and revocable; the host accepts no plugin argv, environment, or paths.
- Cancel/quit kills process trees (including the Windows Job Object); output limits and typed errors
  are reported. Assistant writes obey scope, group into one undo, and select touched objects.

Fresh-thread checkpoint: [reaction arrows handoff](docs/reaction-arrows-handoff.md).

Latest validation (2026-10-24): [reaction-arrow stress results](docs/reaction-arrows-stress-results.md).
216 distinct tests passed, including nine new independent adversarial cases; no confirmed new bug.
Native UI service startup remains blocked, so macOS hands-on and native Windows gates remain open.
No new build or launch in this validation-only continuation.

## Reaction arrows and optional arrangement connections

Owner follow-up (2026-10-24, uncommitted): add three independent, default-off child settings under
Compound layout tools: Arrangement Arrows, Offshoot Arrows and Formatted Reaction Conditions.
The parent gates all three while retaining their choices. Hide unavailable authoring commands from
context menus, custom toolbars and native palettes; refuse direct calls and late dialog Saves.
Keep existing saved arrows/labels rendering and following their parents with authoring options off.
Arrangement Arrows gates one Arrange with options window combining layout, arrows and spacing.
The separate Adjust spacing menu entry is folded into it while opted in; its saved command still
opens the same retained window. Layout-then-spacing previews and Save use one atomic operation.
Base layouts and standalone Adjust spacing need only the parent.
Conditions now offer Top / inside and Bottom / outside: curve-relative inside/outside for curved
shafts, page top/bottom for straight LTR/RTL (left/right for exactly vertical shafts). This supersedes
the earlier Above/outside wording below. Preserve manual label placement until the user changes side.

Follow-up validation (2026-10-24): 466 distinct tests passed across 28 affected suites, including
160 rerun for the final unified-window addition. Root TypeScript, whitespace and production web
build passed. Source stamp `10.24.11.35-codex`; no new native packaged build/launch. Native visual,
focus and Windows checks plus clean full CI remain open. See the handoff for the retained work.

Owner-found quick-layout regression (2026-10-24): Circle → Grid from the direct layout menu moved
only compounds. Explicit quick layouts now rebuild selected generated connections through the same
routing workflow as the options dialog, preserving matching arrow styles/attachments and atomic
fit refusal. 144 focused tests passed, including a failing-before-fix Grid left/center/right repro
and actual menu-click/Undo/Redo coverage. Root TypeScript and whitespace checks also passed.
Source stamp `10.24.11.55-codex`; no new build or launch.

Branch: `codex/reaction-arrows`, based on upstream main `2dec5d8`.
Requested 2026-10-21, with context-menu and conditions-editor screenshots supplied by the user.

Implementation is present, including optional arrangement connections and the owner's screenshot
refinements from 2026-10-22. macOS types, the final web/native production build, Rust formatting/
Clippy, whitespace checks and worktree dev launch passed. Rust: 364 passed, two intentionally ignored.
The concurrent full JavaScript run became unreliable under host load and was stopped after timeout
cascades. All affected suites plus focused geometry/export regressions then passed serially:
28 suites, 1029 tests passed, one intentional skip. The exact SVG/PNG/chemistry artwork golden also
passed after limiting the formatted-text whitespace fix to formatted native text. The agent-bridge
and drawing-tool suites passed in the broad run. A clean full CI run remains a merge gate; run heavy
checks serially on this host. Do not describe the interrupted full run as green.
Rendered offshoots at original/doubled size and a five-molecule cycle with conditions were visually
checked. Launched with `./run-app --dev`: Vite port 5173, `target/debug/chemdraft`, worktree label
`ChemDraft [codex/reaction-arrows]`, stamp `10.22.09.40-codex`.
Windows CI/build and the shared macOS/Windows hands-on checklist remain gates before merge.
Native visual inspection was unavailable because the computer-use service could not start;
keep this slice in flight until platform verification is complete. Generated arrangement arrows
are editable objects after Save; later ordinary compound movement does not reroute them. Adjust spacing
uses saved endpoint/bend metadata to recompute connections while retaining their IDs, styles and
offshoot/conditions attachments. Connections created before that metadata was introduced remain
ordinary independent arrows; recreate those connections to enable spacing reroutes. Existing
saved connecting arrows retain their geometry; regenerate them to use the refined molecule outlines.

- Right-click an arrow to attach a curved offshoot from its midpoint, choosing top/outside or
  bottom/inside. Keep it an editable native arrow and retain its attachment when the parent moves
  or changes shape. The supplied curve leaves the parent tangentially in its forward direction,
  then bends upward or downward to a filled head. Its head matches the parent's head size,
  including later parent head-size edits (owner clarification, 2026-10-21).
- Owner sketch follow-up (2026-10-23): group the two existing choices under one Attach offshoot
  submenu and add full-curve sides. The editable native curve extends on both sides of the
  attachment, initially passing through the parent midpoint with a forward tangent. Its tail/head are editable
  while its junction stays attached; retain transforms, style/head inheritance, conditions, clipboard,
  save/reopen and one Undo. Optional mode/tail metadata preserves legacy half curves.
- Latest testing follow-up: Full curve — top / inside and Full curve — bottom / outside replace
  the single full-curve command (saved `fullCurve` metadata remains supported). A diamond tether
  slides along the actual shaft and stores normalized arclength. Two smooth native segments keep
  the junction fixed during endpoint edits; Shift edits both ends with equal reach/rise. Clamp
  forward reach to avoid loops. New straight RTL Top starts above using saved normal polarity,
  while curved outside geometry and subsequent parent transforms retain their semantics.
- Offer Reaction conditions from the arrow context menu. The shared movable native dialog host
  owns the desktop editor; its browser fallback shares the form. Support normal/subscript/
  superscript spans, useful symbols, a formatted preview, and a choice of label side.
- Conditions remain editable native text, follow their arrow, can be repositioned, and reopen for
  editing on double-click. Clearing the conditions removes the label.
- All actions use registered commands and patches, retain the changed selection, and make one
  labelled undo entry. Preserve chemistry and existing arrow tools, save/reopen and export parity.
- Scope: native schemas, art-engine attachment geometry, document workflows, arrow context menus,
  conditions form and native dialog adapters, focused regression tests, and the shared manual
  checklist. No chemical reaction inference.
- Verify types, tests, web/native builds and Rust checks; launch from this worktree. Record macOS
  and Windows verification separately, with any unavailable native checks explicitly outstanding.

### Optional arrangement connections (owner request, 2026-10-22)

- Preserve immediate layout commands; add registered **Arrange with options…** to their menus.
- Preview the arrangement before Save. Connecting arrows start off. Row/Column connect neighbors;
  Circle/Oval offer clockwise/counterclockwise and an optional closing connection. Grid explicitly
  chooses independent rows or a snake sequence. Direction can be reversed.
- Reserve clearance around visible compounds and grouped captions; refuse obstructed or off-page
  connections without changing the drawing. Generated arrows are ordinary editable native art,
  support the offshoot/conditions tools, and carry no inferred chemistry or reaction roles.
- Save layout and arrows together in one labelled Undo step. Use the existing movable native
  arrangement dialog and its authenticated preview transport, with the shared browser form.

### Arrow geometry refinements (owner screenshots, 2026-10-22)

- Scale attached offshoot geometry with the parent, preserving the separation and proportions of
  its two matching heads through group, individual, typed and nonuniform resizing.
- Route arrangement arrows against molecule outlines derived from rendered bond strokes, stereo
  geometry and atom labels, including rotation, rather than empty corners of rectangular frames.
- Fit formatted conditions to their rendered text and place them on their chosen side with clearance
  from shafts, heads, branches, compounds and other text. Preserve intentional manual repositioning.
- Add screenshot-shaped regressions and inspect exported before/after examples. Keep platform gates.
- Follow-up screenshot fixes: constrain the Arrange with options flyout icon, use a compact 64 px
  arrow-enabled gap, keep generated connections through spacing previews/Save, mirror inward
  offshoots across the curved shaft, resolve context targets by shaft ink, and preserve manual label
  positions. Mixed compound/arrow color changes style arrow strokes and their branch subtree.
- Arrangement dialog settlement restores the active document window and webview responder after
  native close; DOM regressions cover drawing after Save and after removing generated arrows.
  Verify that native focus recovery with actual macOS and Windows pointer input before merge.
- Offshoot condition labels use a conditions-only frame facing away from their parent shaft:
  Above/outside selects the free exterior, Below selects the opposite side. Branch drawing geometry
  stays unchanged. Preserve saved manual positions when correcting the old bow-facing normal;
  screenshot-shaped regressions cover toggles, movement, rotation, scaling and repeated normalization.
- Evening refinement: shared explicit script baselines and per-line ascent/descent prevent
  formatted multiline conditions collisions in the preview, canvas, SVG and PDF. Keep ordinary
  unformatted SVG and atom-label layout unchanged.
- Reopening selected generated connections restores options. Save edits matching IDs/styles,
  and unchecking removes only those connections and their owned attachment trees in one Undo.
  Add a live Arrow length control (30–100% of clear route), with molecule positions/sizes fixed
  on length-only changes. Store settings/ordered item IDs; accept legacy endpoint/bend metadata.
- Independent audit follow-up (2026-10-23): resolve nested conditions against resolved ancestor
  shafts; require exact selected membership/order and directed neighbor topology before preserving
  an arrangement in place; compare length against each connection's own saved value when editing
  multiple complete arrangements. Preserve legacy spatial ordering and unrelated arrows.
- Stress-audit follow-up: length-only edits retain each complete arrangement's own layout/direction;
  persist recovered legacy order across consecutive edits; use explicit baselines for enlarged normal
  spans too; release spacing sources immediately but restore focus only after native close, without
  clearing or focusing over a replacement dialog. The separately reported 66-level attachment-tree
  limit is deferred by the owner; recursion behavior is unchanged in this pass.

Evening refinement verification (2026-10-22): 970 focused JavaScript tests passed across 14 suites;
the artwork/chemistry golden and ring-style regressions passed, with seven local CLI cases rerun
outside the sandbox solely for tsx IPC pipes. Rust dialog tests: 30 passed. Types, Rust fmt/Clippy,
web production build and whitespace checks passed. This is a scoped pass, not a new full gauntlet.
`pnpm running-build` confirms the existing `./run-app --dev` session at `10.22.20.25-codex`, label
`ChemDraft [codex/reaction-arrows]`; the native dev binary is newer than the changed Rust validator.
Rendered 16 px/24 px formatted conditions were inspected. Native hands-on checks of the new
controls and Windows execution remain outstanding. Endpoint/bend-only legacy metadata can recover
the checkbox and topology conservatively; newly saved settings reconstruct options exactly.

Independent audit follow-up verification (2026-10-23): all 48 focused tests passed across the
unchanged five-case independent audit, arrangement connections and arrow refinements suites.
Additional cases cover missing/reduced membership, mixed saved lengths, nested manual/automatic
labels, nonuniform transforms, reversed stacking and SVG normalization parity. Root TypeScript and
whitespace checks passed. The existing dev session reports `10.23.07.22-codex` with the same worktree label via HMR.
This narrow TypeScript follow-up does not replace the prior gauntlet or outstanding native manual
checks on macOS and Windows.

Stress-audit follow-up verification (2026-10-23): 147 focused tests passed across arrangement
connections, arrow refinements, the unchanged independent audit, dialog coordination, SVG and PDF.
Root TypeScript and whitespace checks passed. Inspected centered 16/48 px normal spans, enlarged
blank lines and H₂O/Zn²⁺ rendering. HMR reports `10.23.08.01-codex` under the existing worktree label.
No Rust/protocol changes or repeated full gauntlet in this narrow pass. Native close/reopen with
actual pointer input on macOS and Windows, and Windows execution, remain outstanding.

Full-curve follow-up verification (2026-10-23): 330 unique focused tests passed across 12 suites,
including context-menu keyboard/target/Undo behavior, real parent resize/Undo, legacy schema and
native round trips, clipboard trees, conditions, color, bridge/drawing controls and SVG/PDF.
Root TypeScript, web production build and whitespace checks passed. Inspected the rendered sketch-shaped full U and
conditions label. Dev HMR reports `10.23.08.16-codex`, label `ChemDraft [codex/reaction-arrows]`.
No native window/protocol/Rust changes; actual macOS and Windows pointer/keyboard checks remain
outstanding, and the previously deferred deep attachment-tree limit is unchanged.

Sliding-tether follow-up verification (2026-10-23): 62 unique focused tests passed across the
attachment/refinement/context suites, unchanged independent audit, new 11-case tether suite and
the targeted real-pointer handle test. Coverage includes exact junctions during previews/commits,
Shift keydown/up without resize conflicts, tether Undo/Redo, RTL side choices, clipped visible-shaft
sampling, rotated/nonuniform parents, saved legacy full curves and manual-label clipboard trees.
The strict clipboard check caught and fixed a subpixel generic-path tolerance without relaxing
the junction assertions. Independently audited 96 editing steps also passed. Inspected edited
asymmetric and paired curves after sliding the tether. HMR reports `10.23.09.35-codex` under the
same worktree label. Final root TypeScript, web production build and whitespace checks passed.
Native pointer checks on macOS/Windows and Windows execution remain gates;
the deferred deep-tree limitation is unchanged.

Shift-frame paired-endpoint follow-up (2026-10-23): full curved offshoots now show a third green
drag handle beside the two rotation controls while Shift is held over the arrow. It moves both
endpoints to equal reach and rise around the fixed tether, using one Undo entry; existing context
choices and independent endpoint edits remain unchanged. Root TypeScript and the two affected
editing suites passed (86 tests). No packaged preview was launched by the agent. Native pointer
confirmation on macOS and Windows, Windows execution, and the full closeout gauntlet remain open.
The three Shift-frame controls were subsequently centered at −34/0/+34 px over the curve frame
after the owner's native preview; the owner subsequently confirmed the centered controls look good.
Mixed molecule-and-arrow group resizing now scales arrow stroke/head visual weight by the square
root of the geometry's proportional factor. Molecule bond weight stays fixed, arrow paths/positions
still scale fully, and arrow-only resizing retains its previous proportional behavior. An attached
full curve is covered by the focused regression. Windows execution remains open.
The owner subsequently confirmed that the softer mixed-resize weight looks good in the packaged
worktree preview. Its build stamp was not captured here. Windows execution, the full closeout
gauntlet and shared hands-on platform checks remain open before merge.

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
