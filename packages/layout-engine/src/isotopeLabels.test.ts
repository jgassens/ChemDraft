import { describe, expect, it } from "vitest";
import { type MoleculeObject } from "@chemdraft/chem-core";
import { nativeAtomLabelReading, planMoleculeAtomLabels } from "./index";

function molecule(element: string, isotope?: number): MoleculeObject {
  return {
    id: "mol", type: "molecule", x: 0, y: 0, width: 44, height: 22, rotation: 0, style: {},
    structureFormat: "smiles", structure: "", superatoms: [], rGroups: [],
    atoms: [
      { id: "a", element, ...(isotope === undefined ? {} : { isotope }), x: 0, y: 0, formalCharge: 0 },
      { id: "b", element: "C", x: 22, y: 0, formalCharge: 0 },
      { id: "c", element: "C", x: 44, y: 22, formalCharge: 0 }
    ],
    bonds: [
      { id: "ab", fromAtomId: "a", toAtomId: "b", order: "single" },
      { id: "bc", fromAtomId: "b", toAtomId: "c", order: "single" }
    ]
  };
}

describe("isotope atom labels", () => {
  it.each(["D", "T"])("reads and draws %s without implicit hydrogens", (element) => {
    expect(nativeAtomLabelReading(element)).toEqual({ kind: "heavy-hydrogen", element });
    for (const bonded of [true, false]) {
      const object = molecule(element);
      if (!bonded) object.bonds = [];
      const plan = planMoleculeAtomLabels(object).find(({ atom }) => atom.id === "a")!;
      expect(plan.label).toBe(element);
      expect(plan.layout.runs).toMatchObject([{ text: element, script: "normal" }]);
    }
    const bonded = molecule(element);
    bonded.atoms.pop();
    bonded.bonds.pop();
    bonded.atoms[1]!.labelVisible = true;
    expect(planMoleculeAtomLabels(bonded).map(({ label }) => label)).toEqual([element, "CH3"]);
  });

  it("labels isotopic carbon even when ordinary skeletal carbon is hidden", () => {
    expect(planMoleculeAtomLabels(molecule("C"))).toEqual([]);
    const object = molecule("C", 13);
    object.atoms[0]!.labelVisible = false;
    const plan = planMoleculeAtomLabels(object)[0]!;
    expect(plan.label).toBe("13CH3");
    expect(plan.layout.runs).toMatchObject([
      { text: "13", script: "superscript" },
      { text: "CH", script: "normal" },
      { text: "3", script: "subscript" }
    ]);
    expect(plan.layout.runs[0]!.x).toBeLessThan(plan.layout.runs[1]!.x);
    expect(plan.layout.runs[0]!.y).toBeLessThan(plan.layout.runs[1]!.y);
    object.style.atomLabelHideImplicitHydrogens = true;
    expect(planMoleculeAtomLabels(object)[0]!.layout.runs).toMatchObject([
      { text: "13", script: "superscript" }, { text: "C", script: "normal" }
    ]);
  });

  it("keeps the mass before nitrogen, followed by its hydrogen and charge", () => {
    const object = molecule("N", 15);
    object.bonds[0]!.order = "double";
    expect(planMoleculeAtomLabels(object)[0]!.label).toBe("15NH");
    object.atoms[0]!.formalCharge = 1;
    const plan = planMoleculeAtomLabels(object)[0]!;
    expect(plan.label).toBe("15NH2+");
    expect(plan.layout.runs).toMatchObject([
      { text: "15", script: "superscript" }, { text: "NH", script: "normal" },
      { text: "2", script: "subscript" }, { text: "+", script: "superscript" }
    ]);
  });
});
