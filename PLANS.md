# ChemDraft Plans

This file describes **the slice currently in flight** — nothing else. Completed slices move to
`docs/shipped/README.md` when they land, so that an agent told to "follow PLANS.md" gets the work
in progress rather than a changelog.

Repo-wide scope lives in `PLAN.md`. One further scoped plan applies inside its area:
`PLAN-spin3d-forcefields.md` (Phase 3 blocked on owner decisions). The selection-architecture plan
finished and moved to `docs/shipped/selection-policy-refactor.md`.

---

# Active slice: toolbar, palette, and arrow bug fixes

> **NOT ON `main`.** Everything in this section lives on `codex/toolbar-bug-fixes` and has not been
> merged. On `main`, arrows are still semantic `reaction-arrow` objects and none of the palette or
> popover fixes below are present. This file describes work *in flight* — that is its job — so read
> it as "what is being built", not "what this checkout does". When the branch merges, delete this
> banner and move the section to `docs/shipped/README.md`.

Branch: `codex/toolbar-bug-fixes`, opened 2026-07-26, 26 commits as of 2026-07-30.

Two independent threads share the branch. Thread A hardens the native toolbar/palette window
system after a Claude + Codex review; Thread B rebuilds the arrow family on the art pipeline. They
touch different files and can be reviewed separately.

## Thread A — Native toolbars, palettes, and popover flyouts

### A1. Customization could break commands app-wide (`ad98d4f9`)

`toolCommandSpecs` is derived from the customizable registry, and its binding loop ran *after* the
domain-handler loops with last-wins semantics. Dragging Undo, Save, or a hovered-atom edit onto any
toolbar re-registered that id with the generic "command routed" no-op — and because the registry is
shared, it broke the command in menus and keyboard shortcuts too. The generic tool loop now skips
ids an earlier handler has claimed.

Landed alongside it: dead gallery commands removed (`view.toggleInspector`, `view.togglePlugins`
had no handler anywhere yet were offered in Customize); mojibake labels repaired repo-wide
("Preferences…", "Set Page Size: Custom…"); the Distribute button no longer invokes on Enter/Space
while disabled, matching its pointer path, while its mode menu stays reachable; and `toolbarAsset()`
is guarded at its three direct-render sites against an unknown or IPC-sourced value.

### A2. Plugin palette windows rendered as the Main toolbar (`17dcbde3`)

A native palette webview ships only the **core** toolset manifest. Plugin toolsets are contributed
at runtime in the main window, and nothing carried their definitions to the detached palette
webviews — so a window opened for a plugin toolset couldn't find its own toolset, fell back to
`core.main`, and rendered the Main toolbar under the plugin's title, with a close button that
targeted the real Main window.

A toolset-definitions IPC channel (broadcast / listen / request / respond) now mirrors the existing
command-specs channel. MainWindow broadcasts whenever the plugin runtime changes and answers a
late-joining palette from a cached ref; PaletteWindow subscribes, folds the definitions into all
three registry rebuild paths, and requests them on mount. The `core.main` fallback is replaced by an
empty placeholder carrying *this* window's real id, so title, close, and popover routing target the
correct window and no Main tools leak in.

### A3. Palette reconciliation was open-only (`3ff9a5de`)

The startup reconciler opened the toolsets that should be visible but never closed any, and
substituted the default set whenever the desired set was empty. A toolbar saved as hidden but
restored open by the OS stayed open, and "hide everything" was silently overridden with defaults.

`reconcileNativePaletteWindows` now converges toward the desired set: it closes **known** windows
that are open but not desired, and honors an empty desired set as hide-all (close everything, stay
native — never fall back to web palettes). It re-runs on every registry change so it settles as the
layout hydrates. Unknown/orphan windows — a plugin still loading, or one being uninstalled — are
deliberately left alone, since closing them here would fight a plugin about to claim its
OS-restored window. Success stays lenient (native as long as something opened) so one palette
missing its creating frame can't drop the whole session to in-window palettes.

### A4. Two data-loss traps in Rust persistence (`13067a1b`)

Reads swallowed **every** error as "file absent". A transient or permission read miss therefore
looked like "no saved state", so JS enabled saving and the next write overwrote the real file with
defaults. `read_optional_file` now returns `Ok(None)` only for `NotFound` and propagates anything
else, so the load path's catch leaves the file untouched until a launch reads it cleanly.

Writes used a plain `fs::write` (truncate-then-rewrite), so a crash or power loss mid-write could
leave a partial, unparseable file — which then fails to load and strands the user in the fallback
with customization gone. `write_file_atomic` writes a complete pid-namespaced sibling temp in the
same directory and `rename(2)`s it over the target.

Both helpers are `std::fs`, not the capability-gated plugin-fs, matching the existing Rust commands,
so no capability changes were needed. Rewired: toolset customization state, document session (the
user's autosave — highest stakes), internal toolset layout state, and plugin storage.

### A5. Flyouts that never appeared (`eb6612d9`, `f247e922`, `68e7d920`, `6239db8a`)

Four commits, and the last one is the actual root cause. Worth reading as a sequence, because the
first three are real fixes that could not possibly have made the flyout appear:

1. **Hold delay** cut from 420 ms to 150 ms, so options appear on a brief press while a genuine
   quick tap still selects the primary tool.
2. **Prewarm + content-acknowledged reveal.** Cold open was building the popover window at press
   time — a fresh webview loading the whole app bundle mid-interaction. Each palette now builds its
   popover hidden ~1 s after startup (`prewarm_toolset_popover`). Warm reuse had Rust `show()` the
   window immediately, flashing a stale grid before new content swapped in, so reveal now waits for
   painted content. Prewarmed windows carry `prewarm=1`, never reveal off their placeholder state,
   and get no show-anyway safety net — hidden is their correct resting state.
3. **Synchronous reveal.** The content-acknowledged reveal gated `show()` on a
   `requestAnimationFrame`, but rAF is *suspended in a hidden webview* and only resumes once the
   window is shown. Deadlock: the reveal waited for a frame that could not arrive until the reveal
   happened. Reveal now runs synchronously after the React commit; layout still runs while hidden
   and the ResizeObserver corrects the size once painting resumes.
4. **The capability was never granted.** The popover webview reveals itself with
   `getCurrentWindow().show()`, but the capability granted `core:window:allow-hide` and never
   `core:window:allow-show`. The reveal had been silently denied since the popover was built —
   every JS error path swallowed the rejection. That single denial explains the entire bug history:
   originally the *first* (cold) open never appeared and pressing again worked, because warm reuse
   was shown by Rust; the prewarm rework then removed the Rust warm-path show — the only show that
   was ever permitted — so no flyout could appear at all. `prewarm_toolset_popover` was
   invoke-denied for the same silent reason, so no popover was ever actually prewarmed; it is now
   registered in `build.rs`'s app-manifest command list and in the capability.

**Standing lesson for this codebase:** a missing Tauri capability fails silently through swallowed
JS rejections, and presents as intermittent UI rather than as an error. When a native-window
behavior is intermittent, read `capabilities/default.json` and the window server before rewriting
the JS.

## Thread B — Arrows become art objects

### B1. This supersedes a shipped design decision

The *Toolbar Wiring and Honesty* slice decided that the four tool-drawn arrows would be semantic
`reaction-arrow` objects and explicitly rejected the art route, on the grounds that "art-route
arrows would make tool-drawn and CDXML-imported arrows different object types"
(`docs/shipped/README.md`).

That decision is reversed, by agreement with the project owner (`49d4de52`: "per the design we
agreed on"). All four families — reaction, resonance, equilibrium, retrosynthesis — are now art
arrows. The rejected risk is real and has been answered rather than avoided; see B3.

**Why the reversal.** The semantic object was rigid. Art arrows carry the editing mechanics it
never had: draggable endpoints, arc, arrowhead sizing, hover dot handles, drag-to-move,
hover-delete, drag-to-draw. As `cf3c3569` puts it, retrosynthetic "was the last legacy
reaction-arrow object, so it missed everything arrow mode gained."

### B2. The architecture as it now stands

Arrows are `GraphicObject`s tagged with `artToolId` (`packages/chem-core/src/schemas.ts:182`), which
is the semantic marker the CDXML layer reads. `insertNativeReactionArrow` survives in
`documentWorkflow.ts` for older documents and for arrows that import as `unknown`; the
`reaction-arrow` type remains in the schema (`schemas.ts:407`) to carry them.

This section previously claimed `insertNativeReactionArrow` had **no live caller**. That was wrong:
`applyReactionArrowToolAtPoint` still reached it, and the four retired tool ids
(`tool.reactionArrow`, `tool.resonanceArrow`, `tool.equilibriumArrow`, `tool.retroArrow`) still
passed the Customize gallery's filter — so the tray offered two identically-titled "Reaction Arrow"
tiles, and the legacy one built the retired object type with none of the mechanics above. Those ids
are now aliases: `canonicalCommandId` (`apps/desktop/src/renamedCommands.ts`) redirects them to
their `tool.art.*` replacements at activation, and the gallery does not offer a renamed id as its
own tile.

### B3. CDXML interop contract

Export re-emits the standard spellings, so other programs still read these as reaction arrows:
`<graphic GraphicType="Line" ArrowType="FullHead" | "Resonance" | "Equilibrium" | "RetroSynthetic">`.
Exact ChemDraft geometry round-trips internally through the embedded native payload. Import turns a
foreign arrow of any of those four kinds back into an editable tagged art arrow
(`packages/cdx-compat/src/index.ts:1938`). Internal copy-paste uses the native payload and round-trips
exactly; external clipboard is CDXML. Bold and dashed reaction variants also export as `FullHead`;
fishhook stays a generic graphic with no `ArrowType` mapping.

So tool-drawn and imported arrows are now the *same* object type after import — the original
objection — at the cost of `unknown` arrows remaining legacy objects.

### B4. Geometry model

New `dualShaft` graphic data (`schemas.ts:247`):

- **Equilibrium** — two parallel half-shafts straddling the `lineStart`→`lineEnd` axis pointing
  opposite ways, `markerEnd` heading the forward shaft and `markerStart` the reverse, so arrowhead
  sizing rides the ordinary marker handles. Each shaft's length is an independent fraction of the
  axis with its own handle, since an equilibrium's two directions are rarely equal. Rendered as one
  two-subpath `d` with each shaft pre-trimmed for its head, so the generic terminal and
  visible-stroke passes — which walk a path as a single polyline — never straddle the gap.
- **Retrosynthetic** — `dualShaftParallel` (`schemas.ts:250`): both shafts run the same way under a
  single open head spanning them (the double-shafted "⇒"). Both halves are one arrow, so it offers
  no per-shaft length handles, just the ordinary endpoints. Its shafts stop where the head arms
  cross them, at every scale.
- **Gap** — `dualShaftGapPx` (`schemas.ts:251`). On dual-shaft arrows the middle knob resizes the
  whole arrow — gap, harpoons, and seats together — instead of bending the axis into a curve, so
  the arrow keeps its proportions rather than growing heads onto hairline shafts.

### B5. Interaction rules established by this slice

- **Nothing paints on the initial press**, for every arrow family. The arrow appears once the
  pointer moves (custom length and angle) or the press is released (default horizontal arrow).
  Bonds, templates, and chains keep their press-time preview.
- **Arrow mode doubles as an arrow-editing mode.** Hovering any arrow reveals small translucent dot
  handles (tail, arc-middle, arrowhead) that are grabbable without leaving the draw tool. The tool
  stays active after placing, so repeated clicks keep laying down arrows.
- **Select mode uses the same small translucent dots** for line-family arrows; other art shapes keep
  the full opaque handles.
- **Arrowhead size snaps to discrete 4 px steps**; default head is 16 px (was 10 px).
- **Head sizing follows what each family usually wants, with Shift asking for the other**: resonance
  scales both heads unless Shift; equilibrium sizes one head unless Shift.
- **Body drag moves the arrow; hover-delete removes the hovered one**, in arrow mode.

### B6. Per-tool arrow style defaults (`5b5c08a2`)

Right-clicking any arrow — all eleven families plus the plain art arrow — offers "Set as Default
Arrow Style" at the top of the object context menu. It captures the arrow's reusable look and
applies it to every subsequent arrow drawn with that tool: arrowhead sizes (only for heads the tool
already draws, so a default never adds or removes one), dual-shaft heft and half-lengths, an arc's
sweep, and explicit stroke color, width, and dash. A bent arrow's bow is stored as a signed fraction
of its length, so a curved default bends new arrows proportionally at any drawn length or angle.

Defaults are per-tool, held in a session registry consulted by both creation paths (drag-drawn line
arrows and click-placed arc arrows), and persisted through localStorage so they survive restarts.
Geometry the draw gesture itself decides — endpoints, length, angle — is deliberately not captured.

### B7. The curated flyout (`c2567d8e`, `12718cc5`)

An 11-item grid covering ChemDraw's arrow families rather than the full ~56-cell wall — every
variant is a preconfigured, fully editable arrow, so one of each geometry suffices. New
preconfigured tools are pure data over the existing art pipeline: bold (24 px head) and dashed
reaction arrows; `curvedArrow90`/`curvedArrow180` electron-pushing curves (existing arc geometry
plus an arrowhead — dragging an endpoint flips the sweep, so clockwise presets cover both
directions); `fishhookArrow`/`fishhookCurved` using a new `half-arrow` marker kind (single-sided
barb) for radical single-electron pushing; and `noReactionArrow` using a new `shaftMark: "cross"`
field that renders an X at the shaft midpoint, oriented to the local tangent so it tracks curves.
No per-open cost was added: the grid is pre-rendered and the new items use the procedural
`ArtToolIcon` SVG fallback rather than PNG assets.

## Thread C — Selection-aware Main Toolbar style widget

The Main Toolbar's style widget (`widget.core.mainStyleControls`) now swaps its layout by what is
selected: **text** (the old widget verbatim — also the fallback for empty/mixed selections and
customize mode), **molecule** (bond width, double-bond spacing, atom-label font/size, H/terminal-C
toggles), **shape** (fill/stroke target, paint type, width/dash/corners, swap), and **arrow**
(head kind/size, tail toggle, width/dash, set-as-default, flip). One widget id, one 12×2 grid
slot; every layout budgets exactly 11 cells per row and the CSS pins the footprint so variants
can never resize the toolbar. The classifier (`toolbars/toolbarSelectionKind.ts`) rides the
text-style broadcast to detached palette windows.

**Command ids introduced by this slice** (per the AGENTS.md command-id rule):

- `object.marker.end.kind.*` / `object.marker.start.kind.*` — 8 static presets per end
  (`none`/`filledArrow`/`openArrow`/`halfArrow`/`bar`/`dot`/`diamond`/`chevron`), setting one
  end's arrowhead kind on marker-capable graphics. `none` deletes the marker key; adding a head
  seeds its size from the opposite end.
- `object.marker.size:<n>` — dynamic head size, snapped to the same 4–96px steps as the canvas
  handle (`snapGraphicMarkerSizePx`, now the single source of truth in art-engine); sets every
  non-none head on the selection, matching the handle's symmetric default.
- `arrow.setDefaultStyle` — previously a context-menu-local string; now also handled inside
  `invoke` (`applyArrowStyleDefaultCommand`) so the arrow widget's button can capture the single
  selected arrow. The context menu still captures the right-clicked object, selected or not.

Retro arrows are excluded from marker commands (their "⇒" head is path geometry); anchor-point
add/remove stays with the Scissors/Eraser tools because splitting converts arrows to plain
polylines and destroys their arrow identity (`splitLinePathSegmentAtPoint`).

## Open items

1. **Art inspector still styles only graphics and molecules.** `ArtInspectorStyleObject` is
   `GraphicObject | MoleculeObject` (`apps/desktop/src/artInspectorModel.ts:128`), so Color Controls
   and Object Settings route a bracket or arrow selection to a status message rather than a working
   panel. Carried over from the toolbar-honesty slice and still open; widening it is its own slice.
   This is more visible now that arrows are art objects.
2. **Electron-pushing arrows are art, not mechanism annotations.** The curved and fishhook arrows
   from B7 are arcs with markers — they carry no atom/bond anchoring and are not semantic mechanism
   objects. `tool.mechanismArrow` remains retired and `packages/mechanism-tools` remains a type stub.
   Do not describe the mechanism subsystem as shipped; the real one still needs anchoring, curved
   geometry, half-head markers, renderers, and CDXML mapping.
3. **Stale comment in the CDXML importer.** `packages/cdx-compat/src/index.ts:1935-1937` says
   equilibrium and retrosynthesis "stay the legacy `reaction-arrow` object until they're migrated in
   a later pass" — they were migrated in `6ccb9086` and `cf3c3569`, and the condition on the line
   below already routes all four kinds to `importReactionArrowAsArtArrow`. Only `unknown` is legacy
   now. One-line comment fix.

## Verification

Suites this branch touches:

```bash
pnpm vitest run \
  apps/desktop/src/App.test.ts \
  apps/desktop/src/toolsets.test.ts \
  apps/desktop/src/documentWorkflow.test.ts \
  apps/desktop/src/graphicPathEdit.dom.test.ts \
  apps/desktop/src/PaletteWindow.pluginToolset.dom.test.ts \
  apps/desktop/src/toolbars/reconcileNativePalettes.test.ts \
  packages/art-engine/src/index.test.ts \
  packages/cdx-compat/src/index.test.ts
```

Native code changed (`build.rs`, `capabilities/default.json`,
`permissions/autogenerated/prewarm_toolset_popover.toml`, `src/lib.rs`), so also:

```bash
pnpm lint
pnpm test
pnpm build
git diff --check
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Manual stress in the running app, per AGENTS.md §21 launch verification: draw each of the four
arrow families by click and by drag; resize heads and confirm the 4 px stepping; drag equilibrium
half-shafts independently; use the middle knob on equilibrium and retrosynthetic and confirm it
resizes rather than bends; move an arrow by its body and hover-delete it in arrow mode; open every
palette flyout — cold, warm, and after a long idle — and confirm it appears promptly; hide all
toolbars and relaunch; confirm a plugin toolset window renders its own tools under its own title.

## Definition of done

- All four arrow families are art arrows with the full editing mechanics, and round-trip CDXML
  under their standard `ArrowType` spellings.
- No arrow paints on press; every family behaves identically at placement time.
- Palette flyouts open promptly on cold, warm, and idle paths.
- Plugin toolset windows render their own toolset, never the Main toolbar.
- Hidden-toolbar and hide-all states survive relaunch; a partial write can never strand the user in
  the fallback.
- The three open items above are either closed or explicitly deferred with a named successor slice.
