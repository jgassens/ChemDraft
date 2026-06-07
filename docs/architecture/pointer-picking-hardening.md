# Pointer Picking Hardening

Status: **Planned** — not started. Branch: `codex/chemdraft-worktree-cleanup`.

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

### 1. Characterization tests (no behavior change)
- [ ] Zoom-parameterized cases @ 0.5× / 1× / 4× / 8.5× for atom hit, bond hit, near-miss.
- [ ] Hover vs. left-click vs. context-menu resolve the same pixel to the same target.
- [ ] Overlapping-molecule ordering (extend existing rotaxane case across zooms).
- [ ] Hard assertion: every bond result has `source === "model"` (invariant #5).
- [ ] Routing assertion: a synthetic catcher of the proposed size contains every
      model-accepted point (invariant #1).
- Files: `apps/desktop/src/interaction/hitTest.test.ts`,
  `apps/desktop/src/interaction/hitTest.dom.test.ts`.

### 2. Screen-px bond tolerance (desktop layer only)
- [ ] Add `BOND_HIT_SCREEN_PX` + clamp helper in the interaction/desktop layer.
- [ ] Add options param to `findNativeMoleculeDeleteHit` for `bondHitRadius`.
- [ ] Thread resolved tolerance through the resolver chain.
- [ ] `layout-engine` untouched; atom tolerance untouched.
- Files: `apps/desktop/src/documentWorkflow.ts` (`findNativeMoleculeDeleteHit`, ~line 2716),
  `apps/desktop/src/interaction/hitTest.ts`, call sites in `MainWindow.tsx`.

### 3. Bond DOM catcher = routing superset
- [ ] Derive the non-scaling bond hit stroke width from `BOND_HIT_SCREEN_PX` (+ margin).
- [ ] Confirm catcher ≥ model tolerance at all zooms; resolver still decides identity.
- Files: `apps/desktop/src/App.css` (`.native-bond-hit-target`, ~line 1425),
  bond hit-target emission in `packages/layout-engine/src/index.ts` (~line 1308).

### 4. One highlight from the resolver; split hover semantics
- [ ] Render bond hover from the resolver result (not CSS `:hover`).
- [ ] Retire CSS `:hover` highlight styling (keep transparent catchers).
- [ ] Neutral selection hover renders neutral; destructive red reserved for active
      delete/erase operations.
- Files: `apps/desktop/src/App.css` (`.native-atom-hit-target:hover` ~1484,
  `g[data-bond-layer-id]:hover ...` ~1501, `.native-*-delete-hover` ~1513/1750),
  `apps/desktop/src/MainWindow.tsx` (hover rendering ~6868).

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
- Manual `./run-app` pass: hover/select atoms and bonds at 0.5×, 1×, 4×, 8.5×, plus an
  overlapping-molecule (rotaxane) right-click check.

## Out of scope (this pass)

- Screen-basing **atom** tolerance (ripples into label editing, bond growth, charge
  placement, atom keyboard ops — prove it's the failure source first).
- Broad selection-state transaction (`applySelection`).
- Finishing the interaction state-machine migration.
- Single full-page pointer surface.
