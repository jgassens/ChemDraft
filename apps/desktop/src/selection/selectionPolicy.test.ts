import { describe, expect, it } from "vitest";

import {
  applySelection,
  fromSelectionItems,
  selectionItemFromHit,
  selectionItemsEqual,
  selectionModeFromEvent,
  toSelectionItems,
  type NativeMoleculePartSelection,
  type SelectionItem
} from "./selectionPolicy";

const obj = (objectId: string): SelectionItem => ({ kind: "object", objectId });
const atom = (objectId: string, atomId: string): SelectionItem => ({ kind: "atom", objectId, atomId });
const bond = (objectId: string, bondId: string): SelectionItem => ({ kind: "bond", objectId, bondId });
const ring = (objectId: string, ringKey: string, atomIds: string[] = [], bondIds: string[] = []): SelectionItem => ({
  kind: "ring",
  objectId,
  ringKey,
  atomIds,
  bondIds
});

function keysOf(items: readonly SelectionItem[]): string[] {
  return items.map((item) => {
    switch (item.kind) {
      case "object":
        return `object:${item.objectId}`;
      case "atom":
        return `atom:${item.atomId}`;
      case "bond":
        return `bond:${item.bondId}`;
      case "ring":
        return `ring:${item.ringKey}`;
    }
  });
}

describe("selectionModeFromEvent", () => {
  it("maps no modifier to replace", () => {
    expect(selectionModeFromEvent({}, { gesture: "click" })).toBe("replace");
    expect(selectionModeFromEvent({}, { gesture: "region" })).toBe("replace");
  });

  it("maps shift to toggle on click and add on region", () => {
    expect(selectionModeFromEvent({ shiftKey: true }, { gesture: "click" })).toBe("toggle");
    expect(selectionModeFromEvent({ shiftKey: true }, { gesture: "region" })).toBe("add");
  });

  it("maps alt to subtract regardless of gesture or shift", () => {
    expect(selectionModeFromEvent({ altKey: true }, { gesture: "click" })).toBe("subtract");
    expect(selectionModeFromEvent({ altKey: true, shiftKey: true }, { gesture: "region" })).toBe("subtract");
  });

  it("honours getModifierState and the keyboard-tracked fallback for shift", () => {
    expect(selectionModeFromEvent({ getModifierState: (key) => key === "Shift" }, { gesture: "click" })).toBe("toggle");
    expect(selectionModeFromEvent({}, { gesture: "click", shiftFallback: true })).toBe("toggle");
  });
});

describe("selectionItemsEqual", () => {
  it("compares ring identity by ringKey, ignoring cached atom/bond ids", () => {
    expect(selectionItemsEqual(ring("m", "r1", ["a1"]), ring("m", "r1", ["a9"], ["b9"]))).toBe(true);
    expect(selectionItemsEqual(ring("m", "r1"), ring("m", "r2"))).toBe(false);
    expect(selectionItemsEqual(ring("m", "r1"), ring("n", "r1"))).toBe(false);
  });

  it("distinguishes atoms and bonds by id and owner", () => {
    expect(selectionItemsEqual(atom("m", "a1"), atom("m", "a1"))).toBe(true);
    expect(selectionItemsEqual(atom("m", "a1"), atom("m", "a2"))).toBe(false);
    expect(selectionItemsEqual(atom("m", "a1"), bond("m", "a1"))).toBe(false);
  });
});

describe("applySelection", () => {
  it("replace keeps only the incoming items (deduped)", () => {
    expect(keysOf(applySelection([obj("o1")], [ring("m", "r1"), ring("m", "r1")], "replace"))).toEqual(["ring:r1"]);
  });

  it("add unions and dedupes", () => {
    const next = applySelection([ring("m", "r1")], ring("m", "r2"), "add");
    expect(keysOf(next)).toEqual(["ring:r1", "ring:r2"]);
    expect(keysOf(applySelection(next, ring("m", "r1"), "add"))).toEqual(["ring:r1", "ring:r2"]);
  });

  it("toggle adds an absent item and removes a present one", () => {
    const withTwo = applySelection([ring("m", "r1")], ring("m", "r2"), "toggle");
    expect(keysOf(withTwo)).toEqual(["ring:r1", "ring:r2"]);
    expect(keysOf(applySelection(withTwo, ring("m", "r1"), "toggle"))).toEqual(["ring:r2"]);
  });

  it("subtract removes matching items", () => {
    expect(keysOf(applySelection([ring("m", "r1"), ring("m", "r2")], ring("m", "r1"), "subtract"))).toEqual(["ring:r2"]);
  });
});

describe("legacy adapters round-trip", () => {
  const cases: { name: string; objectIds: string[]; part?: NativeMoleculePartSelection }[] = [
    { name: "objects only", objectIds: ["o1", "o2"] },
    { name: "single atom", objectIds: ["m"], part: { objectId: "m", kind: "atom", atomId: "a1" } },
    { name: "single bond", objectIds: ["m"], part: { objectId: "m", kind: "bond", bondId: "b1" } },
    { name: "parts", objectIds: ["m"], part: { objectId: "m", kind: "parts", atomIds: ["a1", "a2"], bondIds: ["b1"] } },
    {
      name: "single ring",
      objectIds: ["m"],
      part: { objectId: "m", kind: "ring", ringKey: "r1", atomIds: ["a1"], bondIds: ["b1"] }
    },
    {
      name: "multiple rings",
      objectIds: ["m"],
      part: {
        objectId: "m",
        kind: "rings",
        rings: [
          { ringKey: "r1", atomIds: ["a1"], bondIds: ["b1"] },
          { ringKey: "r2", atomIds: ["a2"], bondIds: ["b2"] }
        ]
      }
    },
    {
      name: "object + native part host",
      objectIds: ["o2", "m"],
      part: { objectId: "m", kind: "atom", atomId: "a1" }
    }
  ];

  cases.forEach(({ name, objectIds, part }) => {
    it(`preserves ${name}`, () => {
      const round = fromSelectionItems(toSelectionItems(objectIds, part));
      expect([...round.objectIds].sort()).toEqual([...objectIds].sort());
      expect(round.nativeMoleculePart).toEqual(part);
    });
  });

  it("does not emit a whole-object item for a molecule that only hosts the native part", () => {
    const items = toSelectionItems(["m"], { objectId: "m", kind: "ring", ringKey: "r1", atomIds: [], bondIds: [] });
    expect(items.some((item) => item.kind === "object")).toBe(false);
  });

  it("omits the native-part host from objectIds for the region path", () => {
    const items = applySelection([], [atom("m", "a1"), bond("m", "b1")], "replace");
    const clickShape = fromSelectionItems(items);
    expect(clickShape.objectIds).toEqual(["m"]);
    const regionShape = fromSelectionItems(items, { includeNativePartHost: false });
    expect(regionShape.objectIds).toEqual([]);
    expect(regionShape.nativeMoleculePart).toEqual({ objectId: "m", kind: "parts", atomIds: ["a1"], bondIds: ["b1"] });
  });
});

describe("single-molecule encoding (slice-1 scope)", () => {
  it("keeps the most-recent molecule's ring when items span two molecules", () => {
    const items = applySelection([ring("molA", "rA")], ring("molB", "rB"), "add");
    const encoded = fromSelectionItems(items);
    expect(encoded.nativeMoleculePart).toEqual({
      objectId: "molB",
      kind: "ring",
      ringKey: "rB",
      atomIds: [],
      bondIds: []
    });
    // molA is dropped from the native part rather than promoted to a whole-object selection.
    expect(encoded.objectIds).toEqual(["molB"]);
  });

  it("lets the most-recent kind class win when a molecule mixes rings and atoms", () => {
    const items = applySelection([ring("m", "r1")], atom("m", "a1"), "add");
    expect(fromSelectionItems(items).nativeMoleculePart).toEqual({ objectId: "m", kind: "atom", atomId: "a1" });
  });
});

describe("selectionItemFromHit", () => {
  it("maps resolved hits (with extra fields) to items", () => {
    expect(selectionItemFromHit({ objectId: "m", kind: "atom", atomId: "a1", distanceToPointer: 3 } as never)).toEqual(
      atom("m", "a1")
    );
    expect(selectionItemFromHit({ objectId: "m", kind: "ring", ringKey: "r1", atomIds: ["a1"], bondIds: ["b1"] })).toEqual(
      ring("m", "r1", ["a1"], ["b1"])
    );
  });
});
