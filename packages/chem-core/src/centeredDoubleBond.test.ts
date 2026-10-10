import { describe, expect, it } from "vitest";
import {
  MoleculeBondDisplaySchema,
  createEmptyDocument,
  deserializeDocument,
  serializeDocument,
  type MoleculeObject
} from "./index";

describe("centered double bond display data", () => {
  it.each(["left", "right", "center", "automatic", undefined] as const)("round-trips %s without changing chemistry", (side) => {
    const display = side === undefined ? undefined : { doubleBondSide: side };
    if (display) {
      expect(MoleculeBondDisplaySchema.parse(display)).toEqual(display);
    }
    const molecule: MoleculeObject = {
      id: "m", type: "molecule", x: 0, y: 0, width: 60, height: 40, rotation: 0,
      style: {}, structureFormat: "smiles", structure: "C/C=C/C",
      atoms: [
        { id: "a", element: "C", x: 0, y: 0, formalCharge: 0 },
        { id: "b", element: "C", x: 20, y: 10, formalCharge: 0 },
        { id: "c", element: "C", x: 40, y: 10, formalCharge: 0 },
        { id: "d", element: "C", x: 60, y: 20, formalCharge: 0 }
      ],
      bonds: [
        { id: "ab", fromAtomId: "a", toAtomId: "b", order: "single" },
        { id: "bc", fromAtomId: "b", toAtomId: "c", order: "double", ...(display ? { display } : {}) },
        { id: "cd", fromAtomId: "c", toAtomId: "d", order: "single" }
      ],
      superatoms: [], rGroups: []
    };
    const document = createEmptyDocument({ now: "2026-10-09T00:00:00.000Z" });
    document.pages[0].objects = [molecule];
    const saved = serializeDocument(document);
    const restored = deserializeDocument(saved);
    expect(restored.pages[0].objects[0]).toEqual(molecule);
    expect(serializeDocument(restored)).toBe(saved);
    if (side === undefined) {
      expect(saved).not.toContain("doubleBondSide");
      expect(saved).not.toContain('"display"');
    }
  });

  it("rejects unsupported double bond positions", () => {
    expect(MoleculeBondDisplaySchema.safeParse({ doubleBondSide: "middle" }).success).toBe(false);
  });
});
