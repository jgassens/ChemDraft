import { describe, expect, it } from "vitest";
import { createEmptyDocument, type ChemDraftDocument, type DocumentObject } from "@chemdraft/chem-core";
import {
  DOCUMENT_HISTORY_LIMIT,
  DOCUMENT_HISTORY_MIN_STEPS,
  boundedHistoryPast,
  documentHistoryWeight
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

  it("drops the oldest steps of a huge drawing to stay within the budget", () => {
    const huge = documentWithMolecules(5000);
    const past = Array.from({ length: 60 }, () => ({ ...huge }));
    const kept = boundedHistoryPast(past);
    expect(kept.length).toBeLessThan(60);
    expect(kept.length).toBeGreaterThanOrEqual(DOCUMENT_HISTORY_MIN_STEPS);
    expect(kept[kept.length - 1]).toBe(past[past.length - 1]);
    const weight = kept.reduce((sum, entry) => sum + documentHistoryWeight(entry), 0);
    expect(weight).toBeLessThanOrEqual(450_000);
  });

  it("always keeps a few undo steps, however large the drawing", () => {
    const giant = documentWithMolecules(1, 400_000);
    const past = Array.from({ length: 20 }, () => ({ ...giant }));
    expect(boundedHistoryPast(past)).toHaveLength(DOCUMENT_HISTORY_MIN_STEPS);
  });
});
