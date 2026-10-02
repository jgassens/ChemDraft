import { describe, expect, it } from "vitest";
import { createEmptyDocument, type ChemDraftDocument, type DocumentObject } from "@chemdraft/chem-core";
import {
  DOCUMENT_HISTORY_LIMIT,
  DOCUMENT_HISTORY_MIN_STEPS,
  boundedHistoryPast,
  documentHistoryWeight,
  exclusiveHistoryWeight
} from "./documentHistoryBudget";

function documentWithMolecules(count: number, atomsEach = 2): ChemDraftDocument {
  const document = createEmptyDocument({ title: "t", now: "2026-09-26T00:00:00.000Z" });
  const objects: DocumentObject[] = Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    type: "molecule",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    style: {},
    structure: "",
    atoms: Array.from({ length: atomsEach }, (_, atom) => ({ id: `a${atom}`, element: "C", x: atom * 14, y: 0, formalCharge: 0 })),
    bonds: atomsEach > 1 ? [{ id: "b1", fromAtomId: "a0", toAtomId: "a1", order: "single" }] : []
  }) as DocumentObject);
  return { ...document, pages: [{ ...document.pages[0]!, objects }] };
}

describe("undo history budget", () => {
  it("weighs a document by its objects, atoms, and bonds", () => {
    expect(documentHistoryWeight(documentWithMolecules(3))).toBe(3 * (1 + 2 + 1));
  });

  it("keeps the full step limit for ordinary drawings", () => {
    const small = documentWithMolecules(5);
    const past = Array.from({ length: 150 }, () => ({ ...small }));
    const kept = boundedHistoryPast(past);
    expect(kept).toHaveLength(DOCUMENT_HISTORY_LIMIT);
    expect(kept[kept.length - 1]).toBe(past[past.length - 1]);
  });

  it("drops the oldest steps of a huge drawing whose snapshots share nothing", () => {
    // Every step rewrote every object (a rotate of everything): nothing is shared.
    const past = Array.from({ length: 60 }, () => documentWithMolecules(5000));
    const kept = boundedHistoryPast(past);
    expect(kept.length).toBeLessThan(60);
    expect(kept.length).toBeGreaterThanOrEqual(DOCUMENT_HISTORY_MIN_STEPS);
    expect(kept[kept.length - 1]).toBe(past[past.length - 1]);
    const weight = kept.reduce((sum, entry) => sum + documentHistoryWeight(entry), 0);
    expect(weight).toBeLessThanOrEqual(450_000);
  });

  it("counts objects shared between snapshots once, so small edits to a huge drawing keep every step", () => {
    // What structural sharing produces: each step replaces one object and shares the rest.
    const first = documentWithMolecules(5000);
    const past: ChemDraftDocument[] = [first];
    for (let step = 1; step < 60; step += 1) {
      const previous = past[past.length - 1]!;
      const objects = [...previous.pages[0]!.objects];
      objects[step] = { ...objects[step]!, x: step };
      past.push({ ...previous, pages: [{ ...previous.pages[0]!, objects }] });
    }
    expect(exclusiveHistoryWeight(past[0]!, past[1]!)).toBe(documentHistoryWeight(documentWithMolecules(1)));
    expect(boundedHistoryPast(past)).toHaveLength(60);
  });

  it("keeps every small edit of a drawing heavier than the whole budget, given the present", () => {
    // 5,000 molecules of 100 atoms and one bond: 510,000 units, over the 450,000 budget on its own.
    const first = documentWithMolecules(5000, 100);
    expect(documentHistoryWeight(first)).toBeGreaterThan(450_000);
    const snapshots: ChemDraftDocument[] = [first];
    for (let step = 1; step <= 30; step += 1) {
      const previous = snapshots[snapshots.length - 1]!;
      const objects = [...previous.pages[0]!.objects];
      objects[step] = { ...objects[step]!, x: step };
      snapshots.push({ ...previous, pages: [{ ...previous.pages[0]!, objects }] });
    }
    const present = snapshots.pop()!;
    expect(boundedHistoryPast(snapshots, present)).toHaveLength(30);
    // Without the present, the newest entry is charged in full and only the floor survives.
    expect(boundedHistoryPast(snapshots)).toHaveLength(DOCUMENT_HISTORY_MIN_STEPS);
  });

  it("always keeps a few undo steps, however large the drawing", () => {
    // Two of these already exceed the budget; the floor still keeps five.
    const past = Array.from({ length: 7 }, () => documentWithMolecules(1, 200_000));
    expect(boundedHistoryPast(past)).toHaveLength(DOCUMENT_HISTORY_MIN_STEPS);
  });
});
