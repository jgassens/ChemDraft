# Over/Under Crossing Model (Shared Page Surface)

Status: **implemented through Phase D**. Slice 1 unified geometric input; slice 2
implemented the shared page-level SVG display surface, renderer-neutral planner, and
flat display fragment stream. Phase C added the native crossing schema, depth
comparator, local gaps, and flip/clear controls. Phase D added CDXML
`CrossingBonds` / `Z` import-export mapping in `cdx-compat`.
Pairs with `composited-page-editor-model.md`.

Northstar: **true rotaxane drawings** — a strand of one molecule passing *over* another
molecule at one crossing and *under* it at the next. Mechanically interlocked structures
(rotaxanes, catenanes, knots) are the acceptance case.

## 1. Why the current model cannot get there

Before slice 2, each molecule rendered as its own absolutely-positioned `<div>` + `<svg>`,
layered wholesale by per-object `zIndex`. Two structural consequences motivated the
refactor:

1. **Depth is per-object and total.** A `<div>` is either entirely above or entirely below
   another `<div>`. There is no element that is "above molecule B at this point and below
   it at that point." Alternating over/under between two molecules is therefore impossible
   by construction — not a tuning problem.
2. **Over/under is a paint-order side effect, not a model.** Within one molecule, bonds
   draw in `molecule.bonds` array order; each "over" bond paints a white
   `native-bond-knockout` underlay along *most of its own length*
   ([layout-engine/index.ts:926](../../packages/layout-engine/src/index.ts)) so later bonds
   appear on top. "Over" literally means "later in the array," and
   `reorderNativeMoleculeParts` changes depth by **rewriting `molecule.bonds`**
   ([documentWorkflow.ts:3429](../../apps/desktop/src/documentWorkflow.ts)) — coupling visual
   depth to the chemical connection table. That violates priority 1 in `AGENTS.md`
   (chemical identity must not be a function of display state) and still only works inside
   one molecule.

There is no document-level concept of a crossing: `MoleculeBondSchema` carries only
`order` and `display` ([schemas.ts:115](../../packages/chem-core/src/schemas.ts)).

## 2. Decisions

### D1 — One shared page-level drawing surface

All page display geometry paints into a single page-level SVG render layer via one
**globally ordered draw list**, instead of one display `<div><svg>` per molecule or one
object-level display wrapper per page object. The implemented slice-2 surface is
`PageSvgSurface` in the desktop renderer
([MainWindow.tsx:6089](../../apps/desktop/src/MainWindow.tsx)), fed by
`planPageSvgRender(page)` from `packages/layout-engine`
([index.ts:782](../../packages/layout-engine/src/index.ts)).

Object identity is carried on the emitted fragments with `data-object-id` for pointer hints
and renderer/export metadata; the display stream no longer depends on object wrapper
groups. Object wrappers, selection frames, handles, text editors, atom-label editors,
marquee, previews, and readouts remain app-local overlays; they are not display geometry and
are intentionally outside the planner.

This is the keystone. A shared render planner that only computes geometry is **not enough**
— the fragments must land on one surface, or the strict per-`<div>` stacking order still
forbids the weave. Slice 2 now lands those fragments in one surface for live display and
uses the same planner for SVG export.

### D2 — Crossings are derived geometry; only the decision is persisted

A crossing is the intersection of two bond segments belonging to different bonds. The
intersection **point is recomputed every render** from atom geometry — never stored, so it
can never go stale when a molecule moves.

What *is* persisted is the over/under **decision** per crossing, as an override keyed by the
**unordered pair of object-qualified bond refs**. Atom and bond ids are *molecule-local* —
every molecule has an `atom_001` / `bond_001` ([documentWorkflow.ts:711](../../apps/desktop/src/documentWorkflow.ts),
[documentWorkflow.ts:785](../../apps/desktop/src/documentWorkflow.ts)), and a crossing spans
two molecules by definition — so a bare `bondId` is ambiguous. Only the `mol_*` object id is
globally unique. Each side of a crossing must therefore be `{ objectId, bondId }`,
canonicalized as `objectId::bondId`. Two straight segments intersect at most once, so a bond
pair still identifies at most one crossing; the key is robust without coordinates.

```ts
// page-level, in chem-core
interface BondRef {
  objectId: string;             // mol_* — the only globally-unique handle
  bondId: string;               // molecule-local (bond_001, …)
}                               // canonical key: `${objectId}::${bondId}`

interface CrossingOverride {
  bonds: [BondRef, BondRef];    // unordered; canonicalize by sorted canonical keys
  front: BondRef;               // which of the two is drawn on top here (one of `bonds`)
  clearancePx?: number;         // optional per-crossing gap override
}
```

Absent an override, a **default policy** (D5) decides. So existing documents render exactly
as they do today and gain nothing stale.

### D2.1 — CDXML crossing interop target

ChemDraw stores over/under crossing intent as display metadata, not as chemistry.
The BactVue reference file combines wedges, dashed bonds, bold bonds, text,
reaction arrows, and crossing/occlusion marks. For over/under specifically, it
showed two relevant CDXML mechanisms:

1. Ordinary bond records can carry reciprocal `CrossingBonds` attributes. A front
   bond may also have higher `Z` and `Display="Bold"`, while the crossed bond lists
   the same partner ids.
2. Visible crossing marks are ordinary round bracket graphics attached with
   `bracketedgroup` -> `bracketattachment GraphicID="..."` -> `crossingbond
   BondID="..." InnerAtomID="..."`.

Phase D aligns ChemDraft's native model with both mechanisms while keeping CDXML
provenance out of the native schema:

- import `CrossingBonds` pairs into page-level `CrossingOverride` candidates rather
  than molecule-local bond metadata;
- resolve CDXML bond ids to object-qualified `{ objectId, bondId }` refs as soon as
  fragments are imported;
- use `Z` and reciprocal `CrossingBonds` to infer the default/front side when no
  explicit ChemDraft payload override exists;
- preserve attached `GraphicID`/`crossingbond` metadata through compatibility/unknown
  metadata until ChemDraft can edit those marks natively;
- export native crossing overrides back to CDXML `CrossingBonds` plus enough `Z` /
  bracket graphic metadata for ChemDraw to reopen the same weave.

The synthetic fixtures `packages/fixtures/cdxml/crossing-bonds.cdxml` and
`packages/fixtures/cdxml/bactvue-visible-subset.cdxml` are the legal test targets
for this; the real BactVue ChemDraw file is observational evidence only and must
not be committed.

### D3 — Crossing overrides live on the page, not on the molecule

Add `crossings: CrossingOverride[]` to `DocumentPageSchema`
([schemas.ts:289](../../packages/chem-core/src/schemas.ts)) and a patch op
`setCrossingOverride` / `clearCrossingOverride` in `patches.ts`
([patches.ts:15](../../packages/chem-core/src/patches.ts)). The schema is `.strict()` and
`crossings` defaults to `[]`; `DocumentSchemaVersion` remains
`"chemdraft.document.v1"` because the migration is structural/default-backed.

`molecule.bonds` ordering is **no longer touched for depth**. Layer commands mean
whole-object z-order only; same-object crossing edits use the same page-level
crossing override model as cross-object edits. Chemical graph order and visual depth
are fully decoupled.

### D4 — Local per-crossing gaps, not whole-segment erasers

The "under" segment is split around each crossing and a short clearance gap is left,
centered on the intersection point. The current `bondKnockoutLineSegment` whole-length
underlay is retired — it can only express "later bonds carry erasers," and on a shared
surface a molecule's eraser would punch holes in unrelated bonds.

### D5 — Default over/under policy preserves today's look

When no override exists for a crossing, the **higher-`layerIndex` object is the front**.
This reproduces the current whole-object stacking, so untouched and legacy documents are
visually identical. The user weaves a rotaxane by flipping individual crossings; the rest of
the page keeps the default.

Within-molecule crossings (two bonds of the same object) are just another case the planner
handles. Their default ordering follows `molecule.bonds` array order, preserving the
existing export tests ("later bonds over earlier crossing bonds inside one molecule").

### D6 — Page-level pointer capture

Pointer input resolves atom/bond/object purely from `hitTestDocument`
([hitTest.ts](../../apps/desktop/src/interaction/hitTest.ts)). One capture surface owns the
pointer; molecule wrappers stop being pointer targets (no more rectangular `<div>` swallowing
clicks for the molecule beneath it, and no drag refs keyed to the DOM wrapper's `objectId`).
Hover and click then go through the identical hit path and cannot disagree.

## 3. The shared render planner

The planner now lives in `packages/layout-engine`, which already owns pure page/object
geometry and can be consumed by both `apps/desktop` and `export-engine` without adding a
new package.

```ts
function planPageSvgRender(page: DocumentPage): PageSvgRenderPlan;
```

Current slice-2 contract:

- Input is a `DocumentPage`.
- Output is a stable, renderer-neutral flat SVG fragment stream in page coordinates.
- The stream preserves `page.objects` order globally and current `molecule.bonds` order
  within native molecules.
- The planner resolves object-local drawing/text style while building fragments; it does
  not assume one global drawing style.
- Fragments cover native molecule bonds, atom labels, native hit shapes, text, charge marks,
  plus signs, reaction arrows, graphics, and fallback object display. Top-level display
  fragments carry their owning `data-object-id`; nested children inherit through their
  parent fragment.
- Desktop emits JSX from the fragments; `export-engine` serializes the same fragments to
  XML and skips app-only hit-target classes/fragments.
- Local per-crossing gaps are rendered by splitting the under bond's visible fragments.
  Full-length invisible bond hit targets remain selectable, and crossing hit targets are
  context-only.

Phase-C crossing extension:

1. Build all native bond centerlines for every molecule on the page.
2. **Broad phase:** skip pairs whose axis-aligned bounding boxes do not overlap.
3. **Narrow phase:** finite segment-segment intersection. Exclude zero-length segments,
   shared-atom junctions, endpoint touches, parallel lines, collinear overlaps, and
   non-finite intersections.
4. Resolve front/back through `compareBondDepth(a, b, context)`: explicit override, then
   object layer, then same-object bond order. Future per-atom/per-bond 3D depth plugs into
   this comparator rather than rewriting the crossing model.
5. Emit visible sub-segments after subtracting each crossing's gap from under bonds, and
   emit over bonds without gaps.
6. Emit context-only invisible crossing hit targets for right-click flip/clear controls.

## 4. Edit commands

Replace array-order depth juggling with crossing-scoped commands operating on a pair of
object-qualified `BondRef`s:

- `flipCrossing(refA, refB)` — swap front/back.
- `setSelectedBondOverHere` / `setSelectedBondUnderHere` — at the crossing under the pointer,
  force the selected bond front/back.
- `clearCrossingOverride(refA, refB)` — revert to default policy.

Whole-object z-order (`reorderObject`) stays for actual layering of unrelated objects.

## 5. Invariants and acceptance tests

- **Chemical identity is display-independent.** No crossing edit ever changes atoms, bonds,
  orders, or `molecule.bonds` membership. (Guard: round-trip a document through any sequence
  of crossing edits; the chemical graph is byte-identical.)
- **Shared-atom junctions are never gapped.** (Existing test, ported to the planner.)
- **Planner is the single source for live render, export, and hit geometry.** (Snapshot
  parity test: live SVG fragment order == export fragment order.)
- **Legacy parity:** non-crossing documents with no `crossings` render identically to
  pre-crossing output. Overlapping molecules now render intentional local gaps.
- **click == hover:** the pointer resolves to the same target whether hovering or pressing.
- **Rotaxane weave (northstar):** a fixture with an axle crossing a macrocycle four times,
  overrides set to over/under/over/under, produces alternating gaps — the case that is
  impossible today.

## 6. Migration and compatibility

- `page.crossings` defaults to `[]` through the page schema when slice 3 lands. The repo's
  migration model is structural/default-backed, so old files load without an explicit
  document schema-version bump.
- SVG export: handled directly by the planner for slice-2 display geometry (D1), now
  including local crossing gaps while skipping app-only hit targets.
- CDXML/CDX: over/under crossings are display metadata. CDXML import/export maps the
  native pairwise override model to `CrossingBonds` plus coherent bond `Z` where refs
  resolve, and preserves or warns for richer `crossingbond` attachments. Emit a
  compatibility warning rather than silently dropping a weave or bracket mark.

## 7. Non-goals / known edges (first cut)

- **Curved/wavy bonds** can intersect a partner more than once. First cut assumes straight
  segments (one crossing per pair). Curved support extends the key to include a crossing
  index later.
- **3+ mutually crossing bonds at one knot** define a local z-chain; the override model
  expresses it as pairwise front/back, which can be inconsistent (A>B, B>C, C>A). Detect and
  warn; full cyclic resolution is out of scope for the first cut.
- **CDXML bracket attachments are richer than the first native override.** Preserve the
  referenced bracket graphics and `InnerAtomID` metadata even if the first editable UI
  only exposes the pairwise front/back decision.
- **Performance** at very large pages: broad-phase bucketing keeps this near-linear for
  typical documents; revisit only if profiling shows a hot path.

## 8. Sequencing

1. **Slice 1 — page-level input (D6).** Implemented with no schema change. Routes
   press/context-menu/shift-click through `hitTestDocument` and moves pointer capture off
   molecule wrappers. Closes the "can't select the lower atom" bug.
2. **Slice 2 — shared surface + planner + flat stream (D1, §3).** Implemented as a pure
   rendering refactor with **no schema change**. Output is validated against current SVG for
   visual parity.
3. **Phase C — native crossing model (D2, D3, D4, D5, §4).** Implemented:
   overrides, local gaps, `compareBondDepth`, flip/clear context controls, and no
   molecule-bond reorder for visual depth.
4. **Phase D — CDXML crossing interop (D2.1, §6).** Implemented in `cdx-compat`:
   reciprocal `CrossingBonds` import/export, `Z` inference/export, and warning-backed
   preservation of richer crossing attachments.
5. **Phase E — save/open proof.** Closeout acceptance: ChemDraft envelope round-trip,
   external visible-layer conflict detection, and manual ChemDraw/reader validation with
   over/under fixtures.

There is no dependency on `bright-spinning-panda.md`; no such design document exists.
3D remains a forward-compatibility constraint. The 2D page is the source of truth for
layout, migration, save/open, and over/under crossings; future depth semantics route
through `compareBondDepth`, and cyclic-depth warnings remain the canary for Escher-like
drawings that cannot be realized as a 3D weave.
