/**
 * Pure selection policy — the single decision point for additive selection.
 *
 * Selection is modelled as a flat set of *singular* items (one object / atom / bond / ring per
 * entry). "Is this gesture additive?" is decided in exactly one place (`selectionModeFromEvent`)
 * and applied by exactly one reducer (`applySelection`). The legacy two-store encoding
 * (`document.selection.objectIds` + a single `NativeMoleculePartSelection` slot) is bridged by
 * `toSelectionItems` / `fromSelectionItems`, so the renderer does not have to move yet.
 *
 * This module has no React and no DOM imports on purpose: every rule here is unit-tested in node,
 * not through a faked pointer event. The `parts`/`rings` aggregates that used to be hand-built in
 * pointer branches are now produced only by the re-encoder.
 *
 * Slice scope: `fromSelectionItems` is single-molecule for native parts (it reproduces today's
 * single-slot behaviour). Cross-molecule part/ring selection is a deliberate follow-up (it only
 * needs the storage to become `SelectionItem[]`); see PLANS-selection-policy.md, Phase 7.
 */

export type SelectionGesture = "click" | "region";
export type SelectionMode = "replace" | "toggle" | "add" | "subtract";

/** A single selectable thing. Ring items carry atomIds/bondIds so re-encoding stays lossless. */
export type SelectionItem =
  | { kind: "object"; objectId: string }
  | { kind: "atom"; objectId: string; atomId: string }
  | { kind: "bond"; objectId: string; bondId: string }
  | { kind: "ring"; objectId: string; ringKey: string; atomIds: readonly string[]; bondIds: readonly string[] };

/** Legacy ring entry, mirrored from MainWindow's `NativeMoleculeRingSelectionItem`. */
export type NativeMoleculeRingSelectionItem = {
  ringKey: string;
  atomIds: readonly string[];
  bondIds: readonly string[];
};

/**
 * Legacy single-slot molecule sub-selection, mirrored from MainWindow's
 * `NativeMoleculeSelectionPart`. Phase 3 will switch MainWindow to import this type; structural
 * typing keeps the two interchangeable until then.
 */
export type NativeMoleculePartSelection =
  | { objectId: string; kind: "atom"; atomId: string }
  | { objectId: string; kind: "bond"; bondId: string }
  | { objectId: string; kind: "ring"; ringKey: string; atomIds: readonly string[]; bondIds: readonly string[] }
  | { objectId: string; kind: "rings"; rings: readonly NativeMoleculeRingSelectionItem[] }
  | { objectId: string; kind: "parts"; atomIds: readonly string[]; bondIds: readonly string[] };

/** A resolved molecule-part hit (atom/bond/ring), as produced by `resolveSelectionHit`. */
export type SelectionPartHit = { objectId: string } & (
  | { kind: "atom"; atomId: string }
  | { kind: "bond"; bondId: string }
  | { kind: "ring"; ringKey: string; atomIds: readonly string[]; bondIds: readonly string[] }
);

/**
 * The ONLY place pointer modifiers are interpreted. Alt subtracts; Shift toggles a click but
 * unions a marquee/lasso region (toggling a region is surprising); no modifier replaces. The
 * keyboard-tracked `shiftFallback` is folded in here once, instead of being OR'd at every branch.
 */
export function selectionModeFromEvent(
  // Method-style `getModifierState` so a DOM/React event (whose key is the narrower `ModifierKey`)
  // is assignable here under strictFunctionTypes (method params are bivariant).
  event: { shiftKey?: boolean; altKey?: boolean; getModifierState?(key: string): boolean },
  options: { gesture: SelectionGesture; shiftFallback?: boolean }
): SelectionMode {
  if (event.altKey === true) {
    return "subtract";
  }
  const shift =
    event.shiftKey === true ||
    event.getModifierState?.("Shift") === true ||
    options.shiftFallback === true;
  if (!shift) {
    return "replace";
  }
  return options.gesture === "click" ? "toggle" : "add";
}

/** Identity for membership/dedupe. Ring identity is objectId+ringKey (atomIds/bondIds ignored). */
function itemKey(item: SelectionItem): string {
  switch (item.kind) {
    case "object":
      return `object:${item.objectId}`;
    case "atom":
      return `atom:${item.objectId}:${item.atomId}`;
    case "bond":
      return `bond:${item.objectId}:${item.bondId}`;
    case "ring":
      return `ring:${item.objectId}:${item.ringKey}`;
  }
}

export function selectionItemsEqual(a: SelectionItem, b: SelectionItem): boolean {
  return itemKey(a) === itemKey(b);
}

function dedupe(items: readonly SelectionItem[]): SelectionItem[] {
  const seen = new Set<string>();
  const result: SelectionItem[] = [];
  for (const item of items) {
    const key = itemKey(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

function asItems(hits: SelectionItem | readonly SelectionItem[]): readonly SelectionItem[] {
  return "kind" in hits ? [hits] : hits;
}

/** The one reducer every gesture funnels through. Pure; returns a new array. */
export function applySelection(
  current: readonly SelectionItem[],
  hits: SelectionItem | readonly SelectionItem[],
  mode: SelectionMode
): SelectionItem[] {
  const incoming = asItems(hits);
  switch (mode) {
    case "replace":
      return dedupe(incoming);
    case "add":
      return dedupe([...current, ...incoming]);
    case "subtract": {
      const remove = new Set(incoming.map(itemKey));
      return current.filter((item) => !remove.has(itemKey(item)));
    }
    case "toggle": {
      let next: SelectionItem[] = [...current];
      for (const item of incoming) {
        const key = itemKey(item);
        next = next.some((candidate) => itemKey(candidate) === key)
          ? next.filter((candidate) => itemKey(candidate) !== key)
          : [...next, item];
      }
      return next;
    }
  }
}

/** Build a selection item from a resolved molecule-part hit (Phase 3 click path). */
export function selectionItemFromHit(hit: SelectionPartHit): SelectionItem {
  switch (hit.kind) {
    case "atom":
      return { kind: "atom", objectId: hit.objectId, atomId: hit.atomId };
    case "bond":
      return { kind: "bond", objectId: hit.objectId, bondId: hit.bondId };
    case "ring":
      return { kind: "ring", objectId: hit.objectId, ringKey: hit.ringKey, atomIds: hit.atomIds, bondIds: hit.bondIds };
  }
}

// --- legacy two-store adapters ------------------------------------------------------------

function nativePartToItems(part: NativeMoleculePartSelection | undefined): SelectionItem[] {
  if (!part) {
    return [];
  }
  switch (part.kind) {
    case "atom":
      return [{ kind: "atom", objectId: part.objectId, atomId: part.atomId }];
    case "bond":
      return [{ kind: "bond", objectId: part.objectId, bondId: part.bondId }];
    case "ring":
      return [{ kind: "ring", objectId: part.objectId, ringKey: part.ringKey, atomIds: part.atomIds, bondIds: part.bondIds }];
    case "rings":
      return part.rings.map((ring) => ({
        kind: "ring" as const,
        objectId: part.objectId,
        ringKey: ring.ringKey,
        atomIds: ring.atomIds,
        bondIds: ring.bondIds
      }));
    case "parts":
      return [
        ...part.atomIds.map((atomId) => ({ kind: "atom" as const, objectId: part.objectId, atomId })),
        ...part.bondIds.map((bondId) => ({ kind: "bond" as const, objectId: part.objectId, bondId }))
      ];
  }
}

/** Flatten the legacy two-store encoding into a flat item set. */
export function toSelectionItems(
  objectIds: readonly string[],
  part: NativeMoleculePartSelection | undefined
): SelectionItem[] {
  // A molecule that only hosts the native part is represented by the part items, not a duplicate
  // whole-object item; other object ids become object items.
  const partHost = part?.objectId;
  const objectItems: SelectionItem[] = objectIds
    .filter((objectId) => objectId !== partHost)
    .map((objectId) => ({ kind: "object", objectId }));
  return [...objectItems, ...nativePartToItems(part)];
}

type NativeRingItem = Extract<SelectionItem, { kind: "ring" }>;

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function nativePartFromIds(
  objectId: string,
  atomIds: readonly string[],
  bondIds: readonly string[]
): NativeMoleculePartSelection | undefined {
  if (atomIds.length === 0 && bondIds.length === 0) {
    return undefined;
  }
  if (atomIds.length === 1 && bondIds.length === 0) {
    return { objectId, kind: "atom", atomId: atomIds[0]! };
  }
  if (atomIds.length === 0 && bondIds.length === 1) {
    return { objectId, kind: "bond", bondId: bondIds[0]! };
  }
  return { objectId, kind: "parts", atomIds: [...atomIds], bondIds: [...bondIds] };
}

function nativeRingPartFromItems(
  objectId: string,
  rings: readonly NativeRingItem[]
): NativeMoleculePartSelection | undefined {
  const seen = new Set<string>();
  const unique = rings.filter((ring) => {
    if (seen.has(ring.ringKey)) {
      return false;
    }
    seen.add(ring.ringKey);
    return true;
  });
  if (unique.length === 0) {
    return undefined;
  }
  if (unique.length === 1) {
    const ring = unique[0]!;
    return { objectId, kind: "ring", ringKey: ring.ringKey, atomIds: ring.atomIds, bondIds: ring.bondIds };
  }
  return {
    objectId,
    kind: "rings",
    rings: unique.map((ring) => ({ ringKey: ring.ringKey, atomIds: ring.atomIds, bondIds: ring.bondIds }))
  };
}

function encodeNativePart(
  partItems: readonly Exclude<SelectionItem, { kind: "object" }>[]
): NativeMoleculePartSelection | undefined {
  if (partItems.length === 0) {
    return undefined;
  }
  // Single-slot legacy encoding: keep the parts of one molecule — the most-recently-added item's
  // molecule — and, within it, the most-recently-added kind class (rings vs atom/bond). This
  // matches today's behaviour where selecting in a new molecule replaces the prior native part.
  const last = partItems[partItems.length - 1]!;
  const objectId = last.objectId;
  const mine = partItems.filter((item) => item.objectId === objectId);

  if (last.kind === "ring") {
    return nativeRingPartFromItems(objectId, mine.filter((item): item is NativeRingItem => item.kind === "ring"));
  }

  const atomIds = uniqueStrings(
    mine.filter((item): item is Extract<SelectionItem, { kind: "atom" }> => item.kind === "atom").map((item) => item.atomId)
  );
  const bondIds = uniqueStrings(
    mine.filter((item): item is Extract<SelectionItem, { kind: "bond" }> => item.kind === "bond").map((item) => item.bondId)
  );
  return nativePartFromIds(objectId, atomIds, bondIds);
}

/**
 * Re-encode a flat item set back into the legacy two-store shape (single-molecule native part).
 *
 * `includeNativePartHost` controls whether the molecule that hosts the native part is added to
 * `objectIds`. The click path keeps it true (selecting an atom also lists its molecule, matching
 * the existing renderer); the marquee/lasso path passes false (a lassoed fragment selects parts
 * with an empty `objectIds`, matching the existing region behaviour).
 */
export function fromSelectionItems(
  items: readonly SelectionItem[],
  options: { includeNativePartHost?: boolean } = {}
): { objectIds: string[]; nativeMoleculePart?: NativeMoleculePartSelection } {
  const includeNativePartHost = options.includeNativePartHost ?? true;
  const objectIds: string[] = [];
  const seen = new Set<string>();
  const pushObject = (objectId: string) => {
    if (!seen.has(objectId)) {
      seen.add(objectId);
      objectIds.push(objectId);
    }
  };

  for (const item of items) {
    if (item.kind === "object") {
      pushObject(item.objectId);
    }
  }

  const partItems = items.filter(
    (item): item is Exclude<SelectionItem, { kind: "object" }> => item.kind !== "object"
  );
  const nativeMoleculePart = encodeNativePart(partItems);
  if (nativeMoleculePart && includeNativePartHost) {
    pushObject(nativeMoleculePart.objectId);
  }

  return { objectIds, nativeMoleculePart };
}
