import { describe, expect, it } from "vitest";
import { Molecule } from "openchemlib";
import { applyPatches, type ChemDraftDocument, type MoleculeObject, type MoleculeAtom, type MoleculeBond } from "@chemdraft/chem-core";
import { insertSmilesMolecule, nativeAtomValidationState, nativeBondLengthPx } from "@chemdraft/document-workflow-core";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import { applyNativeAtomElementTarget, createPhase4Document, insertNativeSingleBondMolecule, insertNativeTemplateMolecule, nativeSingleBondHotkeyAtAtomTarget, type NativeMoleculeDeleteTarget } from "./documentWorkflow";
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
  it("oxidizes plain sulfur in CSC to sulfoxide then sulfone and refuses a third oxo", () => {
    const document = insertSmilesMolecule(createPhase4Document("Sulfur oxo"), { x: 300, y: 300 }, depictSmiles2D("CSC"), "CSC");
    const before = molecule(document);
    const sulfur = before.atoms.find(atom => atom.element === "S")!;
    const target = { objectId: before.id, kind: "atom" as const, atomId: sulfur.id, distanceToPointer: 0 };
    let current = document;
    for (const smiles of ["CS(=O)C", "CS(=O)(=O)C"]) {
      const result = nativeOxoHotkeyTarget(current, target);
      expect(result.refusal).toBeUndefined();
      const after = molecule(result.document);
      expect(canonicalSmiles(after.structure)).toBe(canonicalSmiles(smiles));
      expect(after.atoms.slice(0, before.atoms.length)).toEqual(before.atoms);
      expect(after.bonds.slice(0, before.bonds.length)).toEqual(before.bonds);
      current = result.document;
    }
    expect(nativeOxoHotkeyTarget(current, target)).toEqual({ document: current, refusal: "atom-no-free-valence" });
  });

  it("oxidizes plain phosphorus in trimethylphosphine to its oxide", () => {
    const document = insertSmilesMolecule(createPhase4Document("Phosphorus oxo"), { x: 300, y: 300 }, depictSmiles2D("CP(C)C"), "CP(C)C");
    const before = molecule(document);
    const phosphorus = before.atoms.find(atom => atom.element === "P")!;
    const result = nativeOxoHotkeyTarget(document, { objectId: before.id, kind: "atom", atomId: phosphorus.id, distanceToPointer: 0 });
    expect(result.refusal).toBeUndefined();
    const after = molecule(result.document);
    expect(canonicalSmiles(after.structure)).toBe(canonicalSmiles("CP(=O)(C)C"));
    expect(after.atoms.slice(0, before.atoms.length)).toEqual(before.atoms);
    expect(after.bonds.slice(0, before.bonds.length)).toEqual(before.bonds);
  });

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

  it.each(["element tool", "pasted CS"])("oxidizes terminal sulfur from %s exactly like SH, retaining its hydrogen", origin => {
    let document = origin === "pasted CS"
      ? insertSmilesMolecule(createPhase4Document("Terminal sulfur"), { x: 300, y: 300 }, depictSmiles2D("CS"), "CS")
      : insertNativeSingleBondMolecule(createPhase4Document("Terminal sulfur"), { x: 300, y: 300 });
    const before = molecule(document);
    const sulfur = origin === "pasted CS" ? before.atoms.find(atom => atom.element === "S")! : before.atoms[1];
    const target = { objectId: before.id, kind: "atom" as const, atomId: sulfur.id, distanceToPointer: 0 };
    if (origin === "element tool") document = applyNativeAtomElementTarget(document, target, "S");
    const source = molecule(document);
    expect(source.atoms.find(atom => atom.id === sulfur.id)).toMatchObject({ element: "S", formalCharge: 0 });
    expect(source.bonds).toHaveLength(1);
    let labelled = applyPatches(document, [{ op: "updateObject", objectId: source.id, changes: {
      atoms: source.atoms.map(atom => atom.id === sulfur.id ? { ...atom, element: "SH", labelLiteral: true } : atom)
    } }]);
    for (const smiles of ["C[SH]=O", "C[SH](=O)=O"]) {
      const reference = nativeOxoHotkeyTarget(labelled, target);
      expect(reference.refusal).toBeUndefined();
      const result = nativeOxoHotkeyTarget(document, target);
      expect(result.refusal).toBeUndefined();
      const after = molecule(result.document);
      expect(canonicalSmiles(after.structure)).toBe(canonicalSmiles(smiles));
      expect(canonicalSmiles(after.structure)).toBe(canonicalSmiles(molecule(reference.document).structure));
      expect(after.chemistry?.formula).toBe(molecule(reference.document).chemistry?.formula);
      expect(after.chemistry?.totalCharge).toBe(0);
      expect(after.atoms).toHaveLength(molecule(document).atoms.length + 1);
      document = result.document;
      labelled = reference.document;
    }
    expect(nativeOxoHotkeyTarget(document, target)).toEqual({ document, refusal: "atom-no-free-valence" });
    expect(nativeOxoHotkeyTarget(labelled, target)).toEqual({ document: labelled, refusal: "atom-no-free-valence" });
  });

  it.each([
    ["pasted CP", "CP", "PH2", "C[PH2]=O", "CH5OP"],
    ["element tool", "CP", "PH2", "C[PH2]=O", "CH5OP"],
    ["pasted CPC", "CPC", "PH", "C[PH](=O)C", "C2H7OP"],
    ["pasted phospholane", "C1CC[PH]C1", "PH", "O=[PH]1CCCC1", "C4H9OP"]
  ])("oxidizes phosphorus from %s exactly like its spelled label, retaining its hydrogens", (origin, smiles, label, oxide, formula) => {
    let document = origin === "element tool"
      ? insertNativeSingleBondMolecule(createPhase4Document("Phosphorus hydrogens"), { x: 300, y: 300 })
      : insertSmilesMolecule(createPhase4Document("Phosphorus hydrogens"), { x: 300, y: 300 }, depictSmiles2D(smiles), smiles);
    const before = molecule(document);
    const phosphorus = origin === "element tool" ? before.atoms[1] : before.atoms.find(atom => atom.element === "P")!;
    const target = { objectId: before.id, kind: "atom" as const, atomId: phosphorus.id, distanceToPointer: 0 };
    if (origin === "element tool") document = applyNativeAtomElementTarget(document, target, "P");
    const source = molecule(document);
    expect(source.atoms.find(atom => atom.id === phosphorus.id)).toMatchObject({ element: "P", formalCharge: 0 });
    const labelled = applyPatches(document, [{ op: "updateObject", objectId: source.id, changes: {
      atoms: source.atoms.map(atom => atom.id === phosphorus.id ? { ...atom, element: label, labelLiteral: true } : atom)
    } }]);
    const reference = nativeOxoHotkeyTarget(labelled, target);
    expect(reference.refusal).toBeUndefined();
    const result = nativeOxoHotkeyTarget(document, target);
    expect(result.refusal).toBeUndefined();
    const after = molecule(result.document);
    expect(canonicalSmiles(after.structure)).toBe(canonicalSmiles(molecule(reference.document).structure));
    expect(canonicalSmiles(after.structure)).toBe(canonicalSmiles(oxide));
    expect(after.chemistry?.formula).toBe(molecule(reference.document).chemistry?.formula);
    expect(after.chemistry?.formula).toBe(formula);
    expect(Molecule.fromSmiles(after.structure).getMolecularFormula().formula).toBe(formula);
    expect(after.atoms.find(atom => atom.id === phosphorus.id)).toMatchObject({ element: label, labelLiteral: true });
    expect(after.atoms).toHaveLength(source.atoms.length + 1);
    expect(after.bonds.slice(0, source.bonds.length)).toEqual(source.bonds);
    expect(nativeOxoHotkeyTarget(reference.document, target).refusal).toBe("atom-no-free-valence");
    expect(nativeOxoHotkeyTarget(result.document, target)).toEqual({ document: result.document, refusal: "atom-no-free-valence" });
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

  it("preserves sulfur's isotope while adding an oxo", () => {
    const { document, target, before } = fixture("S", ["C", "C"]);
    const isotopic = applyPatches(document, [{ op: "updateObject", objectId: before.id, changes: {
      atoms: before.atoms.map(atom => atom.id === target.atomId ? { ...atom, isotope: 34 } : atom)
    } }]);
    const result = nativeOxoHotkeyTarget(isotopic, target);
    expect(result.refusal).toBeUndefined();
    expect(molecule(result.document).atoms.slice(0, before.atoms.length)).toEqual(molecule(isotopic).atoms);
    expect(canonicalSmiles(molecule(result.document).structure)).toBe(canonicalSmiles("C[34S](=O)C"));
  });

  it("preserves an explicitly drawn hydrogen on sulfur", () => {
    const { document, target, before } = fixture("S", ["C", "H"]);
    const result = nativeOxoHotkeyTarget(document, target);
    expect(result.refusal).toBeUndefined();
    const after = molecule(result.document);
    expect(after.atoms.slice(0, before.atoms.length)).toEqual(before.atoms);
    expect(after.bonds.slice(0, before.bonds.length)).toEqual(before.bonds);
    expect(canonicalSmiles(after.structure)).toBe(canonicalSmiles("C[SH]=O"));
  });

  it.each([
    ["S", ["C", "C", "C"]], ["SH2", ["C"]],
    ["P", ["C", "C", "C"]], ["PH", ["C", "C", "C"]]
  ] as const)("keeps the formal-charge gate for %s", (element, neighbors) => {
    const { document, target, before } = fixture(element, [...neighbors]);
    const charged = applyPatches(document, [{ op: "updateObject", objectId: before.id, changes: {
      atoms: before.atoms.map(atom => atom.id === target.atomId ? { ...atom, formalCharge: 1, labelLiteral: element.length > 1 } : atom)
    } }]);
    const graph = molecule(charged);
    expect(nativeAtomValidationState(sourceAtom(graph), graph.bonds, 1, graph.atoms).valid).toBe(true);
    expect(nativeOxoHotkeyTarget(charged, target)).toEqual({ document: charged, refusal: "atom-no-free-valence" });
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

  it("key 9 leaves quaternary carbon unchanged to honor its never-pentavalent contract", () => {
    const { document, target, before } = fixture("C", ["C", "C", "C"]);
    const filled = nativeBranchedHotkeyTarget(document, target).document;
    const result = nativeBranchedHotkeyTarget(filled, target);
    expect(result.document).toBe(filled);
    expect(result.refusal).toBe("branched-carbon-full");
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
