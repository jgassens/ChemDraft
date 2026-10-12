import { describe, expect, it } from "vitest";
import type { MoleculeAtom, MoleculeBond, MoleculeObject } from "@chemdraft/chem-core";

import { nativeAtomLabelContextInMolecule } from "../src/index";

function molecule(atoms: MoleculeAtom[], bonds: MoleculeBond[]): MoleculeObject {
  return {
    id: "m1", type: "molecule", x: 0, y: 0, width: 100, height: 100, rotation: 0, style: {},
    structureFormat: "smiles", structure: "", atoms, bonds, superatoms: [], rGroups: []
  };
}

function atom(id: string, element: string, x: number, labelLiteral = false): MoleculeAtom {
  return { id, element, x, y: 0, formalCharge: 0, ...(labelLiteral ? { labelLiteral: true } : {}) };
}

function bond(fromAtomId: string, toAtomId: string): MoleculeBond {
  return { id: "b1", fromAtomId, toAtomId, order: "single" };
}

describe("nativeAtomLabelContextInMolecule", () => {
  it("uses the element, typed and recorded-side rules shared by document readers", () => {
    const element = molecule([atom("o1", "O", 0), atom("c1", "C", 30)], [bond("o1", "c1")]);
    expect(nativeAtomLabelContextInMolecule(element.atoms[0]!, element, true))
      .toEqual({ bonded: true, typed: false });

    const typedTs = molecule([atom("ts1", "Ts", 0, true), atom("c1", "C", 30)], [bond("ts1", "c1")]);
    expect(nativeAtomLabelContextInMolecule(typedTs.atoms[0]!, typedTs, true))
      .toEqual({ bonded: true, typed: true });

    const scnOnLeft = molecule([atom("scn1", "SCN", 0), atom("c1", "C", 30)], [bond("scn1", "c1")]);
    expect(nativeAtomLabelContextInMolecule(scnOnLeft.atoms[0]!, scnOnLeft, true))
      .toEqual({ bonded: true, typed: false, bondSide: "right" });
  });
});
