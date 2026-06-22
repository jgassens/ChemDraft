# Selection Policy Refactor — Implementation Plan

Status: planning only. Do not start coding until the user explicitly asks (AGENTS.md).
Companion to: `PLANS.md` (Rings-First Slice 1). This plan corrects the *selection
architecture* that slice exposed; it does not change ring geometry, chemistry, or UI surface.

## Problem recap (from the investigation)

- Two disjoint selection stores: `document.selection.objectIds` (real array) and
  `selectedNativeMoleculePart` (single slot, one molecule), `MainWindow.tsx:1270`,
  union at `MainWindow.tsx:841-850`.
- "Is this click additive?" is re-decided in ~5 pointer branches from raw event flags
  (`MainWindow.tsx:9099, 9118, 9149, 9269`); the shift signal is OR'd from three sources
  inline (`MainWindow.tsx:8803`).
- Rings are a separate universe: multi-ring is a `kind:"rings"` aggregate stuffed into the
  single slot (`MainWindow.tsx:15749-15784`), with two ring-only workarounds —
  keyboard-tracked shift (`shiftKeyPressedRef`, `MainWindow.tsx:1323/5762-5771/8803`) and a
  no-shift "continuation" (`ringSelectionActiveOnObject`, `MainWindow.tsx:9076-9078/9149`).
- Marquee replaces (`MainWindow.tsx:8553-8557`); lasso replaces or alt-subtracts
  (`MainWindow.tsx:8486-8503`); neither shift-adds; neither ever selects rings.
- Ring hit-target is rendered ad-hoc in the overlay (`MainWindow.tsx:17198-17206/17274`)
  while atom/bond/crossing targets come from the layout render plan
  (`packages/layout-engine/src/index.ts:1373/1435/1145`).
- jsdom tests dispatch on the exact `data-ring-hit-key` element with explicit `shiftKey`
  (`toolsetBridge.dom.test.ts:99-127, 297-543`), so they never exercise the real
  topmost-target / modifier-flag / double-press perturbations that break the packaged app.

## Goals / non-goals

Goals (the durable fix):
1. One **pure selection policy** as the single decision point for additive behavior.
2. One **hit resolver** with precedence atom → bond → ring (ring gated on inspector open).
3. **Uniform additive** across click, marquee, and lasso (shift = add/toggle, alt = subtract).
4. Delete the ring-only workarounds and the per-branch shift derivation.
5. Selection logic **unit-testable in node**, not dependent on faking the DOM target.

Non-goals / guardrails (AGENTS.md):
- Do not mutate chemical identity. Ring keys stay topology-derived from sorted bond IDs.
- Ring geometry/keys remain in `packages/layout-engine`; app code imports helpers.
- Ring interiors selectable only when Molecule Inspector is open.
- No new broad UI; no CDXML/clipboard/OCSR scope.
- Update the build stamp (`AGENTS.md:4`) and the `Build` string in `MainWindow.tsx` at closeout
  (`[month].[day].[hour].[minute]-[agent]`).

## Design: the policy as the unit

A selection is conceptually a flat set of **singular** items. Aggregates (`parts`, `rings`)
become an *encoding detail* of the legacy store, produced only by the re-encoder — never by
hand in a pointer branch.

```ts
// apps/desktop/src/selection/selectionPolicy.ts  (NEW, pure, no React/DOM)
export type SelectionItem =
  | { kind: "object"; objectId: string }
  | { kind: "atom";   objectId: string; atomId: string }
  | { kind: "bond";   objectId: string; bondId: string }
  | { kind: "ring";   objectId: string; ringKey: string };

export type SelectionMode = "replace" | "toggle" | "add" | "subtract";
export type SelectionGesture = "click" | "region";

// The ONLY place modifiers are interpreted. shiftFallback folds in the keyboard-tracked ref.
export function selectionModeFromEvent(
  e: { shiftKey: boolean; altKey: boolean; getModifierState?: (k: string) => boolean },
  opts: { gesture: SelectionGesture; shiftFallback?: boolean }
): SelectionMode {
  const shift = e.shiftKey || e.getModifierState?.("Shift") === true || opts.shiftFallback === true;
  if (e.altKey) return "subtract";
  if (!shift) return "replace";
  return opts.gesture === "click" ? "toggle" : "add"; // click toggles, marquee/lasso unions
}

export function selectionItemsEqual(a: SelectionItem, b: SelectionItem): boolean { /* by kind+ids */ }

// Pure reducer. `hits` is one item (click) or many (region).
export function applySelection(
  current: readonly SelectionItem[],
  hits: SelectionItem | readonly SelectionItem[],
  mode: SelectionMode
): SelectionItem[] {
  const incoming = Array.isArray(hits) ? hits : [hits];
  switch (mode) {
    case "replace":  return dedupe(incoming);
    case "add":      return dedupe([...current, ...incoming]);
    case "subtract": return current.filter(c => !incoming.some(i => selectionItemsEqual(c, i)));
    case "toggle": { // click semantics: present -> remove, absent -> add
      let next = [...current];
      for (const i of incoming) {
        next = next.some(c => selectionItemsEqual(c, i))
          ? next.filter(c => !selectionItemsEqual(c, i))
          : [...next, i];
      }
      return dedupe(next);
    }
  }
}
```

Adapters bridge the policy to the *current* two-store encoding so the renderer doesn't move
in this slice:

```ts
// same module
export function toSelectionItems(
  objectIds: readonly string[],
  part: NativeMoleculeSelectionPart | undefined
): SelectionItem[];   // flatten parts/rings aggregates into singular atom/bond/ring items

export function fromSelectionItems(
  items: readonly SelectionItem[],
  opts?: { nativeMoleculeScope?: "single" | "multi" }
): { objectIds: string[]; nativeMoleculePart?: NativeMoleculeSelectionPart };
//  - object items        -> objectIds
//  - atom/bond/ring items grouped by objectId -> single | parts | rings encoding
//  - scope:"single" (slice default) keeps native parts for ONE molecule (the legacy slot);
//    scope:"multi" is the Phase 7 unlock (cross-molecule), behind the same function.
```

Net effect: every gesture becomes
`fromSelectionItems(applySelection(toSelectionItems(cur…), hit, mode))`.

## Hit resolution (precedence + inspector gate in one place)

Centralize the atom→bond→ring precedence and the `!nativeMoleculeHit` gate inside the resolver
instead of the pointer branch. Ring identity is resolved **geometrically** (like bonds), with
the DOM `data-ring-hit-key` demoted to a near-tie hint (mirrors the atom DOM tiebreak at
`hitTest.ts:138-149`). This removes the dependency on `event.target` being the ring path.

```ts
// packages/layout-engine/src/index.ts  (NEW geometry helper; owns ring math)
export function nativeMoleculeRingAtPoint(
  object: MoleculeObject, point: { x: number; y: number }
): NativeMoleculeRing | undefined; // smallest-area ring whose polygon contains point, ringKey tiebreak

// apps/desktop/src/interaction/hitTest.ts  (extend)
export type SelectionHit =
  | NativeMoleculeDeleteTarget                                   // atom | bond (existing)
  | { objectId: string; kind: "ring"; ringKey: string };
export function resolveSelectionHit(
  document: ChemDraftDocument, point: Point,
  opts: { eventTarget?: EventTarget | null; tolerance?: NativeMoleculeHitTolerance; includeRings: boolean }
): SelectionHit | undefined; // atom -> bond -> (includeRings ? ring : none)
```

`includeRings` is passed `moleculeInspectorOpen` by the caller. The existing
`nativeMoleculeRingSelectionFromPoint` / `…FromPointerTarget`
(`MainWindow.tsx:15689-15735`) collapse into thin callers of these, or are deleted.

## Phases

Each phase ships green and is independently revertible.

### Phase 0 — Characterization tests (no behavior change)
- Add node tests asserting today's helper behavior we intend to preserve:
  `nativeRingSelectionWithRingToggled`, `nativeSelectionWithHitToggled`,
  `nativeMoleculeSelectionInRect`. Lock current ring-key/precedence outputs.
- Capture the manual repro (below) as the acceptance oracle for the packaged app.

### Phase 1 — Policy module (pure, unwired)
- New `apps/desktop/src/selection/selectionPolicy.ts` + `selectionPolicy.test.ts`.
- Implement `SelectionItem`, `selectionModeFromEvent`, `applySelection`, `selectionItemsEqual`,
  `toSelectionItems`, `fromSelectionItems`.
- Tests: replace/toggle/add/subtract; toggle removes a present item; region add unions;
  alt subtract; round-trip `from(to(x)) === x` for atom/bond/parts/ring/rings encodings;
  scope:"single" collapses to one molecule, scope:"multi" preserves all.
- Acceptance: 100% of policy logic covered in node; nothing imports it yet.

### Phase 2 — Ring geometry + resolver (pure, unwired)
- Add `nativeMoleculeRingAtPoint` to layout-engine (move point-in-polygon ring pick out of
  MainWindow `:15689`). Tests in `packages/layout-engine/src/index.test.ts`: benzene center hits
  the ring; a point outside hits nothing; fused naphthalene returns the smaller containing ring.
- Add `resolveSelectionHit` to `hitTest.ts` (+ `hitTest.test.ts`): atom beats bond beats ring at
  the same point; `includeRings:false` never returns a ring; geometric ring hit works with no DOM
  target; `data-ring-hit-key` only breaks a near-tie.
- Acceptance: resolver unit-tested in node; not wired.

### Phase 3 — Route click selection through the policy
- In `handleObjectPointerDown` (`MainWindow.tsx:8752`), for `object.type === "molecule"`:
  - compute `hit = resolveSelectionHit(doc, point, { eventTarget: event.target, tolerance, includeRings: moleculeInspectorOpen })`.
  - compute `mode = selectionModeFromEvent(event, { gesture: "click", shiftFallback: shiftKeyPressedRef.current })`.
  - `next = fromSelectionItems(applySelection(toSelectionItems(doc.selection.objectIds, selectedNativeMoleculePart), hitToItem(hit), mode), { nativeMoleculeScope: "single" })`.
  - apply `next.objectIds` to the doc and `setSelectedNativeMoleculePart(next.nativeMoleculePart)`.
- Collapse the four toggle branches (`:9099, 9118, 9149, 9269`) into this one path.
- **Double-press fix:** only consider double-press when `mode === "replace"` (drill-in). Delete
  the `ringSelectionContinuationPress` carve-out (`:9078-9081`).
- Keep drag-intent handling (`nativeMoleculeSelectionDragIntent`, `:9175`) after the policy
  decides selection, unchanged, so press-on-selected-part still drags.
- Acceptance: shift-click multiple rings (same molecule), shift-click atoms/bonds, shift-click
  multiple objects, and normal-click-replaces all pass; the ring-only continuation is gone.

### Phase 4 — Additive marquee + lasso
- Marquee (`:8553-8557`) and lasso (`:8486-8503`): build `SelectionItem[]` for the region
  (objects + the existing per-molecule atom/bond items; rings optional — see decision D3), then
  `applySelection(current, regionItems, selectionModeFromEvent(event, { gesture: "region", … }))`.
- Removes the bespoke alt-only subtract; shift-add now works for both.
- Acceptance: shift-marquee unions with prior selection; alt-lasso subtracts; plain replaces.

### Phase 5 — Remove workarounds + dead code
- Delete `ringSelectionActiveOnObject` (`:9076`), the inline shift OR at the branch sites (now
  only inside `selectionModeFromEvent`), `nativeRingSelectionWithRingToggled` /
  `nativeRingSelectionFromItems` / `nativeSelectionWithHitToggled` if fully subsumed.
- Keep `shiftKeyPressedRef` ONLY as `shiftFallback` input to the policy (single use site).
- Keep the inspector-open gate (`:1575`) and inspector-close cleanup (`:1881`).

### Phase 6 — (Optional, recommended) Ring hit-target into the render plan
- Emit the ring interior catcher from the layout render plan next to bond/atom catchers
  (`packages/layout-engine/src/index.ts:~1373`) so it shares one stacking layer; filter it from
  export in `packages/export-engine/src/svg.ts:124` (`isHitTargetClass`).
- Remove the ad-hoc overlay catcher (`MainWindow.tsx:17198-17206/17274`).
- Acceptance: `App.test.ts` ordering (`:3915-3918`) still holds; export excludes the catcher;
  geometric resolver still selects rings (the catcher is now only a router/tiebreak).

### Phase 7 — (Follow-up slice, not slice 1) Single-set storage / cross-molecule
- Replace the single-slot `selectedNativeMoleculePart` with `SelectionItem[]` as React state;
  switch `fromSelectionItems` callers to `nativeMoleculeScope: "multi"`.
- Update the renderer (`~80` reads of `selectedNativeMoleculePart`) to map over items; derive
  the inspector model from the item set.
- Unlocks shift-selecting atoms/bonds/rings across different molecules.
- Gate behind explicit user sign-off; larger renderer churn.

## Files touched

New:
- `apps/desktop/src/selection/selectionPolicy.ts` + `.test.ts`
- (Phase 2) layout-engine `nativeMoleculeRingAtPoint`; hitTest `resolveSelectionHit`

Changed:
- `apps/desktop/src/MainWindow.tsx` — Phases 3-6 (press handler, marquee/lasso, dead code,
  optional render-plan catcher).
- `apps/desktop/src/interaction/hitTest.ts` (+ `hitTest.test.ts`) — Phase 2.
- `packages/layout-engine/src/index.ts` (+ `index.test.ts`) — Phases 2, 6.
- `packages/export-engine/src/svg.ts` (+ `svg.test.ts`) — Phase 6.
- `apps/desktop/src/toolsetBridge.dom.test.ts` — drive by coordinates/resolver, not by
  hand-picked element; repurpose the keyboard-shift / modifier-dropped tests; add additive
  marquee/lasso and double-press-near-bond regressions.
- `AGENTS.md` + `MainWindow.tsx` Build string — closeout stamp.

## Test plan (mapped to phases)

Node (policy, P1): mode mapping (shift→toggle/add, alt→subtract); reducer for all modes;
round-trip adapters; single vs multi scope.
Node (geometry/resolver, P2): ring-at-point; atom>bond>ring precedence; inspector gate;
geometric ring hit without DOM; DOM hint as tiebreak only.
DOM (P3-P5): normal ring click replaces; shift-click 2nd/3rd ring adds (count grows);
shift-click selected ring removes; ring ignored when inspector closed; shift-click 2 molecules;
shift-click 2 atoms; double-press near a fused bond with shift does NOT collapse a multi-ring
selection. **Drive via page coordinates / the resolver, not `dispatchPointer(ringHitTarget,…)`.**
DOM (P4): shift-marquee unions; alt-lasso subtracts.
Render/export (P6): ordering test holds; export omits the ring catcher.

Manual (packaged app — the gap jsdom can't close):
1. `./run-app` (real WKWebView; not `dev:web`/Chrome).
2. benzene → fuse to anthracene (3 rings); open Molecule Inspector.
3. ring1 click = 1; shift ring2, shift ring3 = 3 ("Selected 3 rings").
4. repeat off-center, near shared bonds, at double-click cadence — must stay 3.
5. shift-marquee across two molecules; alt-lasso subtract.
6. ring interiors inert when inspector closed.

## Verification (AGENTS.md)

```bash
pnpm vitest run packages/layout-engine/src/index.test.ts packages/export-engine/src/svg.test.ts \
  apps/desktop/src/documentWorkflow.test.ts apps/desktop/src/App.test.ts \
  apps/desktop/src/toolsetBridge.dom.test.ts apps/desktop/src/selection/selectionPolicy.test.ts \
  apps/desktop/src/interaction/hitTest.test.ts
pnpm vitest run apps/desktop/src/agentBridge.test.ts apps/desktop/src/drawingTools.test.ts
cargo test agent_bridge        # only if the agent bridge / pointer plumbing changed
pnpm lint
git diff --check
```

## Risks & rollback

- Biggest risk is the press-handler rewrite (P3). Mitigate: land P1/P2 first (pure, no behavior
  change), keep each phase a separate commit, and keep `documentWorkflow`/ring helpers untouched.
- If P3 regresses drag/double-click, revert P3 only; P1/P2 remain as dormant, tested modules.
- P6 touches export — keep it last and optional; selection correctness does not depend on it.

## Open decisions (need user input before P3/P7)

- D1 (scope): stop after P5/P6 (robust within-molecule fix + uniform additive, recommended for
  this slice) or also do P7 (cross-molecule single-set storage)?
- D2 (continuation UX): drop the no-shift "click another ring to add" behavior (recommended,
  matches atoms/objects), or keep it explicitly as documented behavior?
- D3 (region rings): should shift-marquee/lasso also select ring interiors when the inspector is
  open, or keep regions object/atom/bond-only (PLANS.md slice-1 default)?
