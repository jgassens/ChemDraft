import { createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
export function problemMolecule(element: string, neighbours = ["C"], orders: ("single" | "double")[] = []): MoleculeObject {
  return { id: "problem_molecule", type: "molecule", x: 100, y: 100, width: 120, height: 120, rotation: 0,
    style: { drawingPrimitive: "single-bond" }, structureFormat: "smiles", structure: "", superatoms: [], rGroups: [],
    atoms: [element, ...neighbours].map((element, i) => ({ id: `a${i}`, element, formalCharge: 0, ...(element === "OH2" ? { labelLiteral: true } : {}),
      x: i ? 160 + 40 * Math.cos(i * 1.3) : 160, y: i ? 160 + 40 * Math.sin(i * 1.3) : 160 })),
    bonds: neighbours.map((_, i) => ({ id: `b${i}`, fromAtomId: "a0", toAtomId: `a${i + 1}`, order: orders[i] ?? "single" })) };
}
export function problemDocument(molecule = problemMolecule("C", ["C", "C", "C", "C", "C"])) {
  const document = createEmptyDocument({ title: "Atom problems", now: "2026-11-02T00:00:00Z" });
  document.pages[0]!.objects = [molecule]; return document;
}
