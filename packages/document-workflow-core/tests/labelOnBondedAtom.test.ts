import { describe, expect, it } from "vitest";
import type { MoleculeAtom, MoleculeObject } from "@chemdraft/chem-core";
import { labelOnBondedAtom, nativeAtomLabelReading, nativeLabelGroupVerdict } from "../src/index";

function graph(count = 2, charge = 0, radicals = 0): MoleculeObject {
  const atom: MoleculeAtom = { id: "a", element: "C", x: 100, y: 100, formalCharge: charge, markRadicals: radicals };
  return {
    id: "m", type: "molecule", x: 50, y: 50, width: 100, height: 100, rotation: 0, style: {},
    structure: "", structureFormat: "smiles", superatoms: [], rGroups: [],
    atoms: [atom, ...Array.from({ length: count }, (_, i) => ({ ...atom, id: `n${i}`, formalCharge: 0 }))],
    bonds: Array.from({ length: count }, (_, i) => ({ id: `b${i}`, fromAtomId: "a", toAtomId: `n${i}`, order: "single" }))
  };
}
describe("labelOnBondedAtom", () => {
  it.each(["OMe", "OH", "Me", "Ph", "Et", "CF3", "NO2", "D", "T", "R", "X", "?", "Ar", "NMe2"])("attaches %s on a two-bond carbon", label => {
    const m = graph();
    expect(labelOnBondedAtom(label, m.atoms[0]!, m)).toMatchObject({ kind: "substituent", external: 2, bondCount: 2 });
  });
  it.each(["NMe", "CMe2", "NMe3", "N", "O", "Cl", "Ome", "CONH2"])("relabels %s on a two-bond carbon", label => {
    const m = graph();
    expect(labelOnBondedAtom(label, m.atoms[0]!, m).kind).toBe("relabel");
  });
  it("relabels mismatched two-bond NMe on a three-bond atom, keeping its validation warning", () => {
    const m = graph(3);
    expect(labelOnBondedAtom("NMe", m.atoms[0]!, m)).toMatchObject({ kind: "relabel", freeValence: 2, external: 3 });
    const reading = nativeAtomLabelReading("NMe", { bonded: true });
    expect(reading.kind).toBe("group");
    if (reading.kind === "group") expect(nativeLabelGroupVerdict(reading.group, 3, 0).valid).toBe(false);
  });
  it.each([0, 1])("leaves the existing label behavior on %i bonds", count => {
    const m = graph(count);
    for (const label of ["OMe", "NMe", "D", "R", "Ar", "Ome", "N"]) expect(labelOnBondedAtom(label, m.atoms[0]!, m).kind).toBe("unchanged");
  });
  it("falls back to relabel for a full-valence carbon", () => {
    const m = graph(4);
    expect(labelOnBondedAtom("OMe", m.atoms[0]!, m)).toMatchObject({ kind: "relabel", reason: "source-valence" });
  });
  it("uses radicals in external usage and in the source guard", () => {
    const m = graph(2, 0, 2);
    expect(labelOnBondedAtom("OMe", m.atoms[0]!, m)).toMatchObject({ kind: "relabel", external: 4, reason: "source-valence" });
  });
  it("keeps the source charge when checking capacity; the new label is neutral", () => {
    const m = graph(2, 1);
    expect(labelOnBondedAtom("OMe", m.atoms[0]!, m).kind).toBe("substituent");
    const full = graph(3, 1);
    expect(labelOnBondedAtom("OMe", full.atoms[0]!, full)).toMatchObject({ kind: "relabel", reason: "source-valence" });
  });
  it("uses Kekulé bond orders rather than counting aromatic bonds as singles", () => {
    const m = graph(); m.bonds[0]!.order = "double";
    expect(labelOnBondedAtom("NMe", m.atoms[0]!, m)).toMatchObject({ kind: "relabel", external: 3 });
  });

  it.each(["Ac", "Pr", "Ts"])("a newly typed %s is still a one-bond group", label => {
    const m = graph();
    expect(labelOnBondedAtom(label, m.atoms[0]!, m)).toMatchObject({ kind: "substituent", reading: "group", freeValence: 1 });
  });

  it.each(["Ac", "Pr", "Ts"])("checks source %s as an imported element or a typed group", label => {
    const m = graph(); m.atoms[0]!.element = label;
    expect(labelOnBondedAtom("OMe", m.atoms[0]!, m).kind).toBe("substituent");
    m.atoms[0]!.labelLiteral = true;
    expect(labelOnBondedAtom("OMe", m.atoms[0]!, m)).toMatchObject({ kind: "relabel", reason: "source-valence" });
  });

});
