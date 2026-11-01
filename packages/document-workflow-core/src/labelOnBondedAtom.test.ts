import { describe, expect, it } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";
import { labelOnBondedAtom } from "./labelOnBondedAtom";
import { nativeAtomValidationState } from "./atoms";

function graph(element: string, doubleBond = false): MoleculeObject {
  return {
    id: "m", type: "molecule", x: 0, y: 0, width: 100, height: 100, rotation: 0, style: {},
    structure: "", structureFormat: "smiles", superatoms: [], rGroups: [],
    atoms: [
      { id: "a", element, formalCharge: 0, x: 50, y: 50 },
      { id: "b", element: "C", formalCharge: 0, x: 25, y: 50 },
      { id: "c", element: doubleBond ? "O" : "Fe", formalCharge: 0, x: 75, y: 25 }
    ],
    bonds: [
      { id: "ab", fromAtomId: "a", toAtomId: "b", order: "single" },
      { id: "ac", fromAtomId: "a", toAtomId: "c", order: doubleBond ? "double" : "single" }
    ]
  };
}

describe("same-head label decisions", () => {
  it("explains literal-label valence with bond orders, stated hydrogens, and charge", () => {
    const over = graph("S");
    over.atoms.push({ id: "d", element: "C", formalCharge: 0, x: 80, y: 80 });
    over.bonds[1]!.order = "double";
    over.bonds.push({ id: "ad", fromAtomId: "a", toAtomId: "d", order: "single" });
    expect(nativeAtomValidationState({ ...over.atoms[0]!, element: "SH", labelLiteral: true }, over.bonds, 0, over.atoms))
      .toMatchObject({
        invalidReason: "SH puts 5 bonds on S (4 from bonds to other atoms + 1 H); neutral S normally makes 2.",
        invalidDetail: "SH atom a: SH puts 5 bonds on S (4 from bonds to other atoms + 1 H); neutral S normally makes 2."
      });

    const under = graph("C");
    under.atoms = [under.atoms[0]!];
    under.bonds = [];
    expect(nativeAtomValidationState({ ...under.atoms[0]!, element: "CH3", labelLiteral: true }, [], 0, under.atoms))
      .toMatchObject({ invalidReason: "CH3 puts 3 bonds on C (0 from bonds to other atoms + 3 H); neutral C normally makes 4." });

    const charged = graph("C");
    charged.atoms[0]!.formalCharge = 1;
    expect(nativeAtomValidationState({ ...charged.atoms[0]!, element: "CH3", labelLiteral: true }, charged.bonds, 1, charged.atoms))
      .toMatchObject({ invalidReason: "CH3 puts 5 bonds on C (2 from bonds to other atoms + 3 H); C with charge +1 normally makes 3." });
  });

  it.each(["P", "PH"])("relabels %s as PPh2 without hiding the solid-bond valence warning", element => {
    const m = graph(element), source = m.atoms[0]!;
    expect(labelOnBondedAtom("PPh2", source, m)).toMatchObject({ kind: "relabel", external: 2 });
    expect(nativeAtomValidationState({ ...source, element: "PPh2", labelLiteral: true }, m.bonds, 0, m.atoms).valid).toBe(false);
  });

  it("uses actual bond orders plus stated H to admit SH at sulfur(IV)", () => {
    const m = graph("S", true);
    expect(labelOnBondedAtom("SH", m.atoms[0]!, m)).toMatchObject({ kind: "relabel", freeValence: 1, external: 3 });
  });

  it("retains the dashed metal-contact PPh2 relabel", () => {
    const m = graph("P");
    m.bonds[1]!.display = { bondStyle: "dashed" };
    expect(labelOnBondedAtom("PPh2", m.atoms[0]!, m)).toMatchObject({ kind: "relabel", external: 1 });
  });

  it("admits SH only when its stated hydrogen and actual bonds complete sulfur(IV)", () => {
    const m = graph("S");
    expect(labelOnBondedAtom("SH", m.atoms[0]!, m)).toMatchObject({ kind: "relabel", reason: "source-valence" });
    expect(nativeAtomValidationState({ ...m.atoms[0]!, element: "SH", labelLiteral: true }, m.bonds, 0, m.atoms).valid).toBe(false);
    m.atoms[2]!.element = "O";
    m.bonds[1]!.order = "double";
    expect(labelOnBondedAtom("SH", m.atoms[0]!, m)).toMatchObject({ kind: "relabel", external: 3 });
    expect(labelOnBondedAtom("SH", m.atoms[0]!, m).reason).toBeUndefined();
    expect(nativeAtomValidationState({ ...m.atoms[0]!, element: "SH", labelLiteral: true }, m.bonds, 0, m.atoms).valid).toBe(true);
  });

  it.each(["NH2", "NO2", "CF3", "COOH", "CN", "NMe2", "OH", "OMe", "Ph", "CH2CN"])("retains %s attachment on carbon", label => {
    const m = graph("C");
    expect(labelOnBondedAtom(label, m.atoms[0]!, m).kind).toBe("substituent");
  });

  it.each(["NMe2", "NHMe"])("relabels neutral two-bond N as %s even when over-valent", label => {
    const m = graph("N"), source = m.atoms[0]!;
    expect(labelOnBondedAtom(label, source, m).kind).toBe("relabel");
    expect(nativeAtomValidationState({ ...source, element: label, labelLiteral: true }, m.bonds, 0, m.atoms).valid).toBe(false);
  });

  it("relabels S(=O) as SMe", () => {
    const m = graph("S", true);
    expect(labelOnBondedAtom("SMe", m.atoms[0]!, m).kind).toBe("relabel");
  });

  it.each([["O", "OMe", 1], ["O", "OEt", 1], ["N", "NO2", 0]] as const)(
    "keeps table abbreviation %s → %s as an attachment", (element, label, charge) => {
      const m = graph(element);
      m.atoms[0]!.formalCharge = charge;
      expect(labelOnBondedAtom(label, m.atoms[0]!, m).kind).toBe("substituent");
    }
  );
});
