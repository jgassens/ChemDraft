import { createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";

/** Deliberately invalid authored graph: five ordinary single bonds on carbon C1. */
export function invalidCarbonMolecule(suppressed = false): MoleculeObject {
  return {
    id: "invalid_carbon", type: "molecule", x: 100, y: 100, width: 100, height: 100,
    rotation: 0, style: {}, structureFormat: "molfile-v2000", structure: "",
    superatoms: [], rGroups: [],
    atoms: Array.from({ length: 6 }, (_, index) => ({
      id: `a${index + 1}`, element: "C", formalCharge: 0,
      x: index === 0 ? 150 : 150 + 40 * Math.cos(index * Math.PI * 2 / 5),
      y: index === 0 ? 150 : 150 + 40 * Math.sin(index * Math.PI * 2 / 5),
      ...(index === 0 && suppressed ? { warningSuppressed: true } : {})
    })),
    bonds: Array.from({ length: 5 }, (_, index) => ({
      id: `b${index + 1}`, fromAtomId: "a1", toAtomId: `a${index + 2}`, order: "single"
    }))
  };
}

export function invalidCarbonDocument(suppressed = false) {
  const document = createEmptyDocument({ title: "Invalid carbon", now: "2026-11-02T00:00:00Z" });
  document.pages[0]!.objects = [invalidCarbonMolecule(suppressed)];
  return document;
}

export const invalidCarbonWarning = "C1 has unsupported valence 5.";
