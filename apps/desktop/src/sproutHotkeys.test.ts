import { describe, expect, it } from "vitest";
import { Molecule } from "openchemlib";
import { applyPatches, type ChemDraftDocument, type MoleculeObject, type MoleculeAtom, type MoleculeBond } from "@chemdraft/chem-core";
import { nativeAtomValidationState, nativeBondLengthPx } from "@chemdraft/document-workflow-core";
import { createPhase4Document, insertNativeSingleBondMolecule, insertNativeTemplateMolecule, nativeSingleBondHotkeyAtAtomTarget, type NativeMoleculeDeleteTarget } from "./documentWorkflow";
import { nativeBranchedHotkeyTarget, nativeFragmentSproutTarget, nativeOxoHotkeyTarget, nativeDieneFuseTarget } from "./sproutHotkeys";

// Fixture and numeric regression cases promoted from the chemist's reproduction harness.
function molecule(document: ChemDraftDocument): MoleculeObject {
  return document.pages[0].objects[0] as MoleculeObject;
}

function fixture(element: string, neighbors: string[], orders?: MoleculeBond["order"][]) {
  const seed = insertNativeSingleBondMolecule(createPhase4Document("Atom label triage"), { x: 300, y: 300 });
  const original = molecule(seed);
  const source: MoleculeAtom = { id: "atom_001", element, formalCharge: 0, x: 300, y: 300 };
  // Clear, bond-length-spaced geometry, away from every page edge.
  const directions = neighbors.length === 3 ? [Math.PI, -Math.PI / 3, Math.PI / 3] : [Math.PI, -Math.PI / 3];
  const atoms: MoleculeAtom[] = [source, ...neighbors.map((neighbor, i) => ({
    id: `atom_00${i + 2}`, element: neighbor, formalCharge: 0,
    x: source.x + nativeBondLengthPx * Math.cos(directions[i]!),
    y: source.y + nativeBondLengthPx * Math.sin(directions[i]!)
  }))];
  const bonds: MoleculeBond[] = neighbors.map((_neighbor, i) => ({
    id: `bond_00${i + 1}`, fromAtomId: source.id, toAtomId: atoms[i + 1]!.id,
    order: orders?.[i] ?? "single"
  }));
  const document = applyPatches(seed, [{ op: "updateObject", objectId: original.id, changes: { atoms, bonds } }]);
  const target: NativeMoleculeDeleteTarget = {
    objectId: original.id, kind: "atom", atomId: source.id, distanceToPointer: 0
  };
  return { document, target, source, before: molecule(document) };
}

function sourceAtom(graph: MoleculeObject): MoleculeAtom {
  return graph.atoms.find(atom => atom.id === "atom_001")!;
}

function incident(graph: MoleculeObject, atomId = "atom_001") {
  return graph.bonds.filter(bond => bond.fromAtomId === atomId || bond.toAtomId === atomId);
}

function canonicalSmiles(smiles: string): string {
  // Canonicalize atom order first: the SMILES writer alone can choose different
  // ring starts for equivalent fused graphs.
  return Molecule.fromIDCode(Molecule.fromSmiles(smiles).getIDCode()).toIsomericSmiles();
}

function expectNoCumulatedDoubleBonds(graph: MoleculeObject) {
  for (const atom of graph.atoms) {
    expect(incident(graph, atom.id).filter(bond => bond.order === "double").length).toBeLessThanOrEqual(1);
  }
}


describe("atom-aware numeric sprouts", () => {
  it.each([["P", ["C", "C", "C"]], ["S", ["C", "C"]], ["C", ["C", "C"]]] as const)("adds only oxygen directly to %s", (element, neighbors) => {
    const { document, target, before } = fixture(element, [...neighbors]);
    const result = nativeOxoHotkeyTarget(document, target);
    expect(result.refusal).toBeUndefined();
    const after = molecule(result.document);
    expect(after.atoms).toHaveLength(before.atoms.length + 1);
    expect(after.atoms.filter(atom => atom.element === "C")).toHaveLength(before.atoms.filter(atom => atom.element === "C").length);
    const oxygen = after.atoms.find(atom => atom.element === "O")!;
    expect(incident(after).some(bond => bond.order === "double" && [bond.fromAtomId, bond.toAtomId].includes(oxygen.id))).toBe(true);
    expect(nativeAtomValidationState(sourceAtom(after), after.bonds, 0, after.atoms).valid).toBe(true);
    expect(after.atoms.slice(0, before.atoms.length)).toEqual(before.atoms);
  });

  it("retains today's gate for methanethiol instead of silently attaching formyl", () => {
    const { document, target } = fixture("S", ["C"]);
    expect(nativeOxoHotkeyTarget(document, target)).toEqual({ document, refusal: "atom-no-free-valence" });
  });

  it("preserves literal SH and its explicit hydrogen when adding oxygen", () => {
    const { document, target, before } = fixture("SH", ["C"]);
    const edited = applyPatches(document, [{ op: "updateObject", objectId: before.id, changes: {
      atoms: before.atoms.map(atom => atom.id === target.atomId ? { ...atom, labelLiteral: true } : atom)
    } }]);
    const result = nativeOxoHotkeyTarget(edited, target);
    expect(result.refusal).toBeUndefined();
    expect(sourceAtom(molecule(result.document))).toEqual(sourceAtom(molecule(edited)));
    expect(molecule(result.document).chemistry?.formula).toBe("CH4OS");
  });

  it.each([2, 3])("key 9 on carbon with %s bonds has the requested branching", count => {
    const { document, target, before } = fixture("C", Array(count).fill("C"));
    const result = nativeBranchedHotkeyTarget(document, target);
    expect(result.refusal).toBeUndefined();
    const after = molecule(result.document);
    expect(after.atoms).toHaveLength(before.atoms.length + (count === 3 ? 3 : 2));
    expect(incident(after)).toHaveLength(4);
    expect(after.atoms.slice(0, before.atoms.length)).toEqual(before.atoms);
    expect(after.bonds.slice(0, before.bonds.length)).toEqual(before.bonds);
    for (const atom of after.atoms) expect(nativeAtomValidationState(atom, after.bonds, atom.formalCharge, after.atoms).valid).toBe(true);
    if (count === 3) expect(after.atoms.slice(before.atoms.length).some(atom => incident(after, atom.id).length === 3)).toBe(true);
  });

  it("key 9 on a quaternary carbon is refused by today's gate without a partial sprout", () => {
    const { document, target, before } = fixture("C", ["C", "C", "C"]);
    const filled = nativeBranchedHotkeyTarget(document, target).document;
    const result = nativeBranchedHotkeyTarget(filled, target);
    expect(result.document).toBe(filled);
    expect(result.refusal).toBe("atom-no-free-valence");
    expect(molecule(filled).atoms.length).toBe(before.atoms.length + 3);
  });
});

describe("fragment graph builders", () => {
  it("refuses an alkyne that would extend beyond the page without changing the document", () => {
    const { document, target, before } = fixture("C", ["C"]);
    const edgeDocument = applyPatches(document, [{ op: "updateObject", objectId: before.id, changes: {
      atoms: before.atoms.map(atom => ({ ...atom, x: atom.x + 499.5 }))
    } }]);
    expect(edgeDocument.pages[0].width).toBe(816);
    const first = nativeSingleBondHotkeyAtAtomTarget(edgeDocument, target);
    expect(molecule(first.document).atoms.at(-1)?.x).toBeCloseTo(810.5);
    const result = nativeFragmentSproutTarget(edgeDocument, target, "alkyne");
    expect(result.document).toBe(edgeDocument);
    expect(result.refusal).toBe("sprout-page-edge");
  });

  it.each([
    ["cyclopropyl", 3, 4, 0], ["cyclobutyl", 4, 5, 0],
    ["alkyne", 2, 2, 0], ["cyclopentadienyl", 5, 6, 2], ["phenyl", 6, 7, 3]
  ] as const)("builds %s atom and bond topology", (kind, atoms, bonds, doubles) => {
    const { document, target, before } = fixture("C", ["C"]);
    const result = nativeFragmentSproutTarget(document, target, kind);
    expect(result.refusal).toBeUndefined();
    const after = molecule(result.document);
    expect(after.atoms).toHaveLength(before.atoms.length + atoms);
    expect(after.bonds).toHaveLength(before.bonds.length + bonds);
    expect(after.bonds.filter(bond => bond.order === "double")).toHaveLength(doubles);
    expect(after.atoms.slice(0, before.atoms.length)).toEqual(before.atoms);
    expect(after.bonds.slice(0, before.bonds.length)).toEqual(before.bonds);
    expect(incident(after)).toHaveLength(2);
    if (kind === "alkyne") {
      const [a, b] = after.atoms.slice(-2);
      const source = sourceAtom(after);
      expect((a.x - source.x) * (b.y - a.y) - (a.y - source.y) * (b.x - a.x)).toBeCloseTo(0, 8);
      expect(after.bonds.at(-1)?.order).toBe("triple");
      expect(after.chemistry?.formula).toBe("C4H6");
    }
    expect(result.document.selection.objectIds).toEqual([before.id]);
  });

  it.each(["cyclopropyl", "cyclobutyl", "alkyne", "cyclopentadienyl", "phenyl"] as const)("refuses missing %s targets without partial changes", kind => {
    const { document, target } = fixture("C", ["C"]);
    expect(nativeFragmentSproutTarget(document, { ...target, objectId: "missing" }, kind)).toEqual({ document, refusal: "target-unavailable" });
  });

  it.each(["single", "double"] as const)("fuses a five-membered diene without moving the original %s bond", order => {
    const { document, before } = fixture("C", ["C"], [order]);
    const bond = before.bonds[0];
    const target = { objectId: before.id, kind: "bond" as const, bondId: bond.id, fromAtomId: bond.fromAtomId, toAtomId: bond.toAtomId, distanceToPointer: 0 };
    const result = nativeDieneFuseTarget(document, target);
    expect(result.refusal).toBeUndefined();
    const after = molecule(result.document);
    expect(after.atoms).toHaveLength(5);
    expect(after.bonds).toHaveLength(5);
    expect(after.bonds.filter(bond => bond.order === "double")).toHaveLength(2);
    expect(after.atoms.slice(0, 2)).toEqual(before.atoms);
    expect(after.bonds[0]).toEqual(bond);
    expect(after.chemistry?.formula).toBe("C5H6");
    expect(canonicalSmiles(after.structure)).toBe(canonicalSmiles("C1=CC=CC1"));
    expectNoCumulatedDoubleBonds(after);
    for (const atom of after.atoms) expect(nativeAtomValidationState(atom, after.bonds, atom.formalCharge, after.atoms).valid).toBe(true);
  });

  it("fuses on propene's terminal =CH2 bond without cumulated double bonds", () => {
    const { document, before } = fixture("C", ["C", "C"], ["double", "single"]);
    const bond = before.bonds[0];
    const target = { objectId: before.id, kind: "bond" as const, bondId: bond.id, fromAtomId: bond.fromAtomId, toAtomId: bond.toAtomId, distanceToPointer: 0 };
    const result = nativeDieneFuseTarget(document, target);
    expect(result.refusal).toBeUndefined();
    const after = molecule(result.document);
    expect(after.atoms).toHaveLength(6);
    expect(after.bonds).toHaveLength(6);
    expect(after.atoms.slice(0, before.atoms.length)).toEqual(before.atoms);
    expect(after.bonds.slice(0, before.bonds.length)).toEqual(before.bonds);
    expect(after.bonds.filter(candidate => candidate.order === "double")).toHaveLength(2);
    expect(after.chemistry?.formula).toBe("C6H8");
    expect(canonicalSmiles(after.structure)).toBe(canonicalSmiles("CC1=CC=CC1"));
    expectNoCumulatedDoubleBonds(after);
    for (const atom of after.atoms) expect(nativeAtomValidationState(atom, after.bonds, atom.formalCharge, after.atoms).valid).toBe(true);
  });

  it.each(["single", "double", "aromatic"] as const)("fuses indene on a %s benzene bond while preserving the original graph", order => {
    let document = insertNativeTemplateMolecule(createPhase4Document("Indene"), { x: 300, y: 300 }, "benzene");
    if (order === "aromatic") {
      const graph = molecule(document);
      document = applyPatches(document, [{ op: "updateObject", objectId: graph.id, changes: {
        bonds: graph.bonds.map(bond => ({ ...bond, order: "aromatic" as const }))
      } }]);
    }
    const before = molecule(document);
    // Exercise both ends and every available edge so candidate order cannot hide a failure.
    for (const bond of before.bonds.filter(bond => bond.order === order)) {
      const target = { objectId: before.id, kind: "bond" as const, bondId: bond.id, fromAtomId: bond.fromAtomId, toAtomId: bond.toAtomId, distanceToPointer: 0 };
      const result = nativeDieneFuseTarget(document, target);
      expect(result.refusal).toBeUndefined();
      const after = molecule(result.document);
      expect(after.atoms).toHaveLength(9);
      expect(after.bonds).toHaveLength(10);
      expect(after.chemistry?.formula).toBe("C9H8");
      expect(canonicalSmiles(after.structure)).toBe(canonicalSmiles("c1ccc2c(c1)CC=C2"));
      expectNoCumulatedDoubleBonds(after);
      expect(after.atoms.slice(0, before.atoms.length)).toEqual(before.atoms);
      expect(after.bonds.slice(0, before.bonds.length)).toEqual(before.bonds);
      expect(after.bonds.slice(before.bonds.length).filter(bond => bond.order === "double")).toHaveLength(1);
      for (const atom of after.atoms) expect(nativeAtomValidationState(atom, after.bonds, atom.formalCharge, after.atoms).valid).toBe(true);
    }
  });

  it("fuses on an alkane ring bond without over-valence or changing existing bonds", () => {
    const document = insertNativeTemplateMolecule(createPhase4Document("Fused alkane"), { x: 300, y: 300 }, "cyclohexane");
    const before = molecule(document);
    const bond = before.bonds[0];
    const target = { objectId: before.id, kind: "bond" as const, bondId: bond.id, fromAtomId: bond.fromAtomId, toAtomId: bond.toAtomId, distanceToPointer: 0 };
    const result = nativeDieneFuseTarget(document, target);
    expect(result.refusal).toBeUndefined();
    const after = molecule(result.document);
    expect(after.atoms).toHaveLength(9);
    expect(after.bonds).toHaveLength(10);
    expect(after.chemistry?.formula).toBe("C9H12");
    expect(after.atoms.slice(0, 6)).toEqual(before.atoms);
    expect(after.bonds.slice(0, 6)).toEqual(before.bonds);
    for (const atom of after.atoms) expect(nativeAtomValidationState(atom, after.bonds, atom.formalCharge, after.atoms).valid).toBe(true);
  });
});
