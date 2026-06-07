# Pointer Picking Hardening

Status: **In progress** — steps 1–4 done (manual-verification milestone). Branch:
`codex/chemdraft-worktree-cleanup`.

> **Ready to test in the Tauri app.** Steps 2–4 together make bond/atom picking
> self-consistent: screen-stable tolerance, no marquee fall-through, and a hover highlight
> that matches what a click selects. See "Manual verification" below.

Tracking doc for hardening atom/bond hover, left-click, and right-click picking.
Reviewed three ways (Claude investigation, Codex narrowing, ChatGPT Pro green-light).
Plan is frozen; this file tracks execution and decisions.

---

## Problem (diagnosis)

Picking feels brittle because "what is under the pointer" is answered by **three
independent systems with different geometry**, and they only agree by coincidence at
~1.75× zoom:

1. **Browser DOM hit-testing** decides *which handler fires* (object vs. empty/marquee),
   driven by invisible SVG shapes: atom `<circle r=8>` (page-space) and a bond `<line>`
   with `stroke-width: 14` + `vector-effect: non-scaling-stroke` (constant ±7px screen).
2. **CSS `:hover`** lights the highlight purely from those same DOM shapes — a second
   opinion that uses different geometry than the click.
3. **JS model geometry** runs every click/select/right-click via
   `findNativeMoleculeDeleteHit` with fixed **page-space** radii: atom `8`, bond `4`.

The bond mismatch is the live bug: the DOM catcher is screen-constant (±7px) while the
model bond radius is page-space (`4·scale` px). So:

| Zoom | CSS hover lights within | Click actually selects within | Result |
|------|-------------------------|-------------------------------|--------|
| 0.5× | ±7px | ±2px | bond **highlights but click does nothing** (2–7px dead band) |
| 1.0× | ±7px | ±4px | smaller dead band |
| ~1.75× | ±7px | ±7px | the one zoom that feels right |
| 8.5× | ±7px | ±34px | click *should* hit, but DOM catcher too thin → routes to **page marquee** instead of selecting the bond |

Atoms are internally aligned (DOM `r=8` ≈ model `8` page-space), so they are **out of
scope** for the first pass.

### Already fixed on this branch (do not redo)

- The main-branch footgun where a DOM-hinted bond returned `distanceToPointer: 0` and
  could override the model is **gone**. `hitTest.ts` makes the geometric model hit the
  source of truth; bonds rely entirely on the model hit; DOM hints are atom-only near-tie
  tiebreakers bounded by `HOVER_DOM_TIEBREAK_PX = 2`.
- Overlapping-molecule (rotaxane) ordering is geometry-first with a sub-pixel layer
  tiebreak (`LAYER_TIE_EPSILON_PX = 0.5`), with tests.
- Zoom range on this branch is genuinely `minZoom 0.5 / maxZoom 8.5`
  (`createViewportState`, not overridden by `MainWindow`).

### Still split (the work)

- Bond tolerance is fixed page-space (`bondHitRadius = 4`) while the DOM catcher is
  non-scaling 14px — zoom-dependent divergence.
- CSS `:hover` is an independent highlight source for atom and bond hover.
- `hoveredNativeDeleteTarget` is overloaded: it is the hovered-part identity **and** the
  fallback operand for delete / bond-order / atom-element / charge keyboard commands, and
  it renders in destructive red (`--cd-danger`).

---

## Invariants (the contract these changes must hold)

- **#0 — DOM routes, resolver decides.** The DOM hit shapes exist only to get the pointer
  event to the right molecule. The shared resolver is the sole authority on *which*
  atom/bond. Near-miss rescue is allowed only if explicit, tested, and using the same
  tolerance policy as click/hover/context-menu.
- **#1 — Routing superset.** Anything the model accepts, the DOM catcher also catches, so
  no model-accepted hit ever falls through to the page/marquee path.
- **#2 — One highlight = the click target.** The thing that visually highlights on hover
  is exactly what a click will act on (same id, same kind).
- **#3 — One resolver.** Hover, left-click, and right-click resolve through the same call.
- **#4 — Zoom-stable tolerance.** Effective bond click tolerance has a sane floor/ceiling
  in **screen pixels** across 0.5×–8.5×.
- **#5 — Bonds are always model-derived.** Every bond hit has `source === "model"`; the
  DOM never assigns bond identity.

---

## Resolver API changes (step 5 detail)

Extend the **existing** entry point, do not invent a new one.

- Tolerance flows **in** (desktop layer computes it, keeps `layout-engine` pure):
  `hitTestDocument` → `nativeMoleculeCanvasHoverTarget` → `nativeMoleculeHitFromPointerTarget`
  → options wrapper around `findNativeMoleculeDeleteHit`.
- Provenance flows **out**, originating in `nativeMoleculeHitFromPointerTarget` (model hit
  vs. the `HOVER_DOM_TIEBREAK_PX` atom path) and propagated up unchanged.
- Provenance enum (locked, narrow): `source: "model" | "atom-dom-tiebreak"`.
  - **Decision:** a miss stays `undefined` (absence = "none"); we do **not** widen every
    return to `{ source: "none" }`. Revisit only if a test needs to assert "none"
    explicitly.
- Bond tolerance policy (desktop layer): `bondHitRadiusPage = clamp(BOND_HIT_SCREEN_PX /
  scale, floorPage, ~0.45 · nativeBondLengthPx)`. The max cap prevents zoomed-out clicks
  from grabbing the wrong bond. `BOND_HIT_SCREEN_PX` is a single shared constant; the DOM
  catcher stroke is **derived from it**, not a re-typed magic number.

---

## Steps & progress

Legend: `[ ]` todo · `[~]` in progress · `[x]` done

### 1. Characterization tests (no behavior change) — DONE
- [x] Zoom-parameterized cases @ 0.5× / 1× / 4× / 8.5× for bond + atom tolerance, pinning
      today's page-space (zoom-dependent) behavior. The bond cases are the ones that will
      legitimately flip in step 2/3; atom cases are the preserve-as-is guard.
- [x] Determinism: same page point → identical target.
- [x] Behavioral pin of invariant #5: a bond DOM hint cannot manufacture or shift a bond
      hit (`bonds are never DOM-derived`). The literal `source === "model"` assertion lands
      with the provenance field in **step 5**.
- [x] Overlapping-molecule ordering — covered by the existing rotaxane/layer-vs-distance
      tests; ordering is zoom-invariant in page space, so no per-zoom variant is needed.
- [~] Hover vs. left-click vs. context-menu agreement — deferred to **step 5**: the three
      already share one resolver at the unit level; a meaningful cross-handler test needs the
      MainWindow harness and the extracted resolver.
- [~] Routing-superset assertion (invariant #1) — deferred to **step 3**: it needs the
      `BOND_HIT_SCREEN_PX` catcher constant, which is introduced in step 2.
- Files: `apps/desktop/src/interaction/hitTest.test.ts`,
  `apps/desktop/src/interaction/hitTest.dom.test.ts`.

### 2. Screen-px bond tolerance (desktop layer only) — DONE
- [x] Added `BOND_HIT_SCREEN_PX` (=8) + `bondHitRadiusForScale` / `hitToleranceForScale`
      in `hitTest.ts`. Clamp: floor `1` page-px, ceiling `0.45 × bondLength` (9.9 at the
      22px default). Effective screen tolerance lands in a flat ~5–8.5px band across
      0.5×–8.5× (vs legacy 2–34px).
- [x] Added `NativeMoleculeHitTolerance` options param to `findNativeMoleculeDeleteHit`;
      both radii default to the legacy fixed values, so keyboard/programmatic/test callers
      are unaffected.
- [x] Threaded `tolerance` through `nativeMoleculeHitFromPointerTarget` →
      `nativeMoleculeCanvasHoverTarget` → `hitTestDocument`, and wired
      `hitToleranceForScale(viewportRef.current.scale)` into all five **pointer** call sites
      in `MainWindow.tsx` (hover, pointer-down re-resolve + per-object hit, context-menu
      re-resolve + per-object hit).
- [x] `layout-engine` untouched; atom tolerance untouched.
- [x] Tests: pointer path is screen-stable (4px-off bond hits at every zoom; rescues the
      0.5× bond the default path misses); clamp band asserted. 28 hit-test + 215
      documentWorkflow/App assertions green; tsc clean.
- NOTE: only the model tolerance is screen-stable so far. The DOM **catcher** is still the
  legacy non-scaling 14px stroke, so at high zoom an accepted hit can still out-reach the
  catcher and route to the marquee path — **step 3** closes that.
- Files: `apps/desktop/src/documentWorkflow.ts` (`findNativeMoleculeDeleteHit` ~2716),
  `apps/desktop/src/interaction/hitTest.ts`, `apps/desktop/src/MainWindow.tsx`.

### 3. Bond DOM catcher = routing superset — DONE
- [x] Single source of truth `BOND_HIT_CATCHER_STROKE_PX` (=20, half-width 10) in
      `hitTest.ts`, injected as the `--bond-hit-stroke-px` CSS var via `pageCssVars`, and
      consumed by `.native-bond-hit-target { stroke-width: var(--bond-hit-stroke-px, 20) }`.
      Replaces the re-typed magic `14`.
- [x] Routing-superset assertion (invariant #1): `maxModelBondScreenTolerancePx(0.5, 8.5)`
      = 8.5px ≤ catcher half-width 10px; resolver still decides identity. Tested.
- NOTE: catcher widening means the CSS `:hover` bond decorator now lights over a slightly
  WIDER band than the model selects — a temporary highlight/click mismatch that **step 4**
  removes by driving hover from the resolver result and retiring CSS `:hover`.
- Files: `apps/desktop/src/interaction/hitTest.ts`, `apps/desktop/src/MainWindow.tsx`
  (`pageCssVars`), `apps/desktop/src/App.css` (`.native-bond-hit-target`).

### 4. One highlight from the resolver; split hover semantics — DONE
- [x] Bond hover is now drawn from the resolver result (`deleteTarget.kind === "bond"`) as a
      `.native-bond-hover` line in the molecule overlay, matching the click target
      (invariant #2). Replaces the CSS `:hover` decorator.
- [x] Retired both CSS `:hover` highlights (`.native-atom-hit-target:hover` and
      `g[data-bond-layer-id]:hover .native-bond-hover-decorator`). The catcher/decorator
      elements remain (inert) so routing and the layout-engine render plan are unchanged.
- [x] Split hover styling: neutral by default (`.native-atom-hover` / `.native-bond-hover`),
      destructive red (`.native-*-delete-hover`) only when `hoverDestructive` — wired to
      `activeCommandId === "tool.eraser"`. (Eraser is currently disabled, so hover is neutral
      in practice; the danger path is wired and ready.) Fixes the old "atoms always render
      danger-red on hover" overload.
- [x] Updated `App.test.ts` CSS assertions: no `g[data-bond-layer-id]:hover` rule;
      `.native-bond-hover` exists; no atom/bond hit-target `:hover`.
- Files: `apps/desktop/src/App.css`, `apps/desktop/src/MainWindow.tsx`
  (`DocumentObjectView` hover rendering + `hoverDestructive` prop), `apps/desktop/src/App.test.ts`.

### 5. Extend resolver: tolerance in / provenance out
- [ ] Add `source` to the hit type; populate in `nativeMoleculeHitFromPointerTarget`.
- [ ] Make hover, left-click, right-click consume the same result consistently.
- [ ] Delete any remaining divergent fallback paths.
- Files: `apps/desktop/src/interaction/hitTest.ts`, `MainWindow.tsx`
  (`handleObjectPointerDown` ~3535, `handleObjectContextMenu` ~4007,
  `updateNativeCanvasHover` ~2474).

### 6. Narrow cleanup (only after behavior is pinned)
- [ ] Extract `clearTransientInteractionChrome()` for the repeated editor/hover/preview
      reset block. **Not** a broad `applySelection()` god function.
- [ ] Defer: interaction state-machine completion, single full-page pointer surface.

---

## Acceptance criteria

- At each supported zoom (0.5× / 1× / 4× / 8.5×), the same pixel resolves to the same
  atom / bond / no-hit for hover, left-click, and right-click.
- Any model-accepted bond hit reaches the molecule handler, never the page marquee path.
- DOM-only routing cannot select a bond the resolver would reject (invariant #5 test).
- Atom picking behavior is unchanged except where a test explicitly documents an edge case.

## Verification

- Targeted `pnpm vitest run` slices for the hit-test + interaction files.
- `pnpm lint`.

### Manual verification (steps 2–4) — do this in the Tauri app

Run the app and draw a few bonds / a small ring. At **0.5×, 1×, 4×, and 8.5×** zoom:

1. **Bond click is zoom-stable.** Hover a hair off a bond and click. It should select the
   bond consistently at every zoom — not "works at 1× but dead when zoomed out," and not
   "starts a marquee when zoomed in."
2. **Highlight matches the click.** Wherever a bond/atom lights up on hover, a click there
   selects it. No band where it highlights but clicking does nothing (and vice-versa).
3. **Hover is neutral, not red.** Hovering atoms/bonds in the select tool shows a neutral
   accent highlight, not the old danger-red.
4. **No wrong-bond grabs when zoomed out.** At 0.5×, clicking between two close bonds should
   not jump to a far one (the bond-length ceiling guards this).
5. **Overlapping molecules.** With two overlapping structures, hover/click/right-click should
   target the part nearest the pointer, and right-click should act on that same part.

Known intentional edge: at 0.5× the tolerance is slightly tighter (~5px) than at 1×–8.5×
(~8px) to avoid wrong-bond grabs — expected, not a bug.

## Out of scope (this pass)

- Screen-basing **atom** tolerance (ripples into label editing, bond growth, charge
  placement, atom keyboard ops — prove it's the failure source first).
- Broad selection-state transaction (`applySelection`).
- Finishing the interaction state-machine migration.
- Single full-page pointer surface.
