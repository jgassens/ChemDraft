// Labels that used to fold into the wrong element ("NH" → nihonium, "CO" → cobalt) read as the
// atoms they spell. The folding rule is tested in layout-engine; this checks the chemistry it feeds.

import { describe, expect, it } from "vitest";
import type { MoleculeAtom, MoleculeBond } from "@chemdraft/chem-core";

import { aromaticFixtures } from "../../layout-engine/src/testing";
import {
  nativeAtomValidationState,
  nativeSingleBondGraphMetadata,
  nativeSingleBondGraphSmiles,
  normalizeNativeAtomElementLabel
} from "../src/index";

/** The fixture with its N relabelled the way the label editor does: folded, and literal (typed). */
function withTypedLabel(name: string, label: string, variant: "kekule" | "aromatic") {
  const fixture = aromaticFixtures.find((candidate) => candidate.name === name)!;
  const atoms: MoleculeAtom[] = fixture.atoms.map((atom) =>
    atom.id === "a0" ? { ...atom, element: normalizeNativeAtomElementLabel(label), labelLiteral: true } : atom
  );
  return { fixture, atoms, bonds: [...fixture[variant]] as MoleculeBond[] };
}

describe("NH typed on a ring nitrogen", () => {
  it.each([
    ["pyrrole", "kekule"], ["pyrrole", "aromatic"], ["indole", "kekule"], ["indole", "aromatic"]
  ] as const)("keeps %s (%s bonds) an N–H, never nihonium", (name, variant) => {
    const { fixture, atoms, bonds } = withTypedLabel(name, "NH", variant);
    expect(atoms[0]!.element).toBe("NH");
    const metadata = nativeSingleBondGraphMetadata(atoms, bonds);
    expect(metadata.formula).toBe(fixture.formula);
    expect(metadata.formula).not.toContain("Nh");
    const state = nativeAtomValidationState(atoms[0]!, bonds, 0, atoms);
    expect(state.valid).toBe(true);
    expect(nativeSingleBondGraphSmiles(atoms, bonds)).not.toContain("Nh");
  });
});

describe("two-element labels on a chain end", () => {
  const chainEnd = (label: string) => ({
    atoms: [
      { id: "c1", element: "C", x: 0, y: 0, formalCharge: 0 },
      { id: "c2", element: normalizeNativeAtomElementLabel(label), x: 30, y: 0, formalCharge: 0, labelLiteral: true }
    ] as MoleculeAtom[],
    bonds: [{ id: "b1", fromAtomId: "c1", toAtomId: "c2", order: "single" }] as MoleculeBond[]
  });

  it("reads CO as carbon and oxygen, not cobalt", () => {
    const { atoms, bonds } = chainEnd("CO");
    expect(atoms[1]!.element).toBe("CO");
    expect(nativeSingleBondGraphMetadata(atoms, bonds).formula).toBe("C2H3O");
  });

  it("reads CN as carbon and nitrogen, not copernicium", () => {
    const { atoms, bonds } = chainEnd("CN");
    expect(atoms[1]!.element).toBe("CN");
    expect(nativeSingleBondGraphMetadata(atoms, bonds).formula).toBe("C2H3N");
  });

  it("reads HS as a thiol S–H, not hassium", () => {
    const { atoms, bonds } = chainEnd("HS");
    const metadata = nativeSingleBondGraphMetadata(atoms, bonds);
    expect(metadata.formula).toBe("CH4S");
    expect(nativeAtomValidationState(atoms[1]!, bonds, 0, atoms).valid).toBe(true);
  });
});
