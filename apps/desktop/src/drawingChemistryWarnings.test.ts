import { describe, expect, it } from "vitest";
import { applyPatches, type ChemDraftDocument, type MoleculeAtom, type MoleculeBond, type MoleculeObject } from "@chemdraft/chem-core";
import { nativeAtomValidationState, nativeBondLengthPx } from "@chemdraft/document-workflow-core";
import {
  applyChargeToolAtNativeAtom, applyFreeformSingleBondToolAtPoint, applyNativeChainTool, applyNativeAtomElementTarget, applyNativeMoleculeBondOrderTarget,
  applyNativeMoleculeBondOrderValueTarget, createPhase4Document, findNativeMoleculeAtomHit,
  insertNativeSingleBondMolecule, nativeAtomSproutHotkeyTarget, nativeMoleculeInvalidAtomStates,
  nativeSingleBondHotkeyAtAtomTarget, reconcileNativeChargeMarks
} from "./documentWorkflow";

function molecule(document: ChemDraftDocument): MoleculeObject {
  return document.pages[0].objects.find(object => object.type === "molecule") as MoleculeObject;
}
function graph(atoms: MoleculeAtom[], bonds: MoleculeBond[]) {
  const seed = insertNativeSingleBondMolecule(createPhase4Document("Drawing chemistry warnings"), { x: 300, y: 300 });
  const before = molecule(seed);
  return applyPatches(seed, [{ op: "updateObject", objectId: before.id, changes: { atoms, bonds } }]);
}
function atomTarget(document: ChemDraftDocument, atomId = "source") {
  return { objectId: molecule(document).id, kind: "atom" as const, atomId, distanceToPointer: 0 };
}
function bondTarget(document: ChemDraftDocument, bondId: string) {
  const bond = molecule(document).bonds.find(candidate => candidate.id === bondId)!;
  return { objectId: molecule(document).id, kind: "bond" as const, ...bond, bondId, distanceToPointer: 0 };
}
function star(degree: number, element = "C") {
  const source = { id: "source", element, x: 300, y: 300, formalCharge: 0 };
  const tips = Array.from({ length: degree }, (_, i) => ({
    id: `tip${i}`, element: "C", formalCharge: 0,
    x: 300 + Math.cos(i * 2 * Math.PI / degree) * nativeBondLengthPx,
    y: 300 + Math.sin(i * 2 * Math.PI / degree) * nativeBondLengthPx
  }));
  return graph([source, ...tips], tips.map((tip, i) => ({
    id: `bond${i}`, fromAtomId: source.id, toAtomId: tip.id, order: "single"
  })));
}
function incident(mol: MoleculeObject, atomId = "source") {
  return mol.bonds.filter(bond => bond.fromAtomId === atomId || bond.toAtomId === atomId);
}

describe("drawing edits keep the requested chemistry and diagnose it", () => {
  it.each(["explicit order", "cycle"])("Ru–N double lands with (!) on the pincer N via %s", mode => {
    let document = star(3, "N");
    document = applyNativeAtomElementTarget(document, atomTarget(document, "tip0"), "Ru");
    expect(nativeMoleculeInvalidAtomStates(molecule(document))).toEqual([]);
    const target = bondTarget(document, "bond0");
    const changed = mode === "cycle"
      ? applyNativeMoleculeBondOrderTarget(document, target)
      : applyNativeMoleculeBondOrderValueTarget(document, target, "double");
    const after = molecule(changed);
    expect(after.bonds.find(bond => bond.id === "bond0")?.order).toBe("double");
    expect(after.atoms).toEqual(molecule(document).atoms);
    expect(nativeMoleculeInvalidAtomStates(after)).toEqual([
      expect.objectContaining({ atomId: "source", valid: false, valenceUsed: 4 })
    ]);
  });

  it.each([false, true])("stepwise S=O edits from neopentane reach H2SO4 (literal labels: %s)", literal => {
    let document = star(4);
    document = applyNativeAtomElementTarget(document, atomTarget(document), "S", { literal });
    for (let i = 0; i < 4; i++) {
      document = applyNativeAtomElementTarget(document, atomTarget(document, `tip${i}`), literal && i >= 2 ? "OH" : "O", { literal });
    }
    const baseline = molecule(document);
    const first = applyNativeMoleculeBondOrderValueTarget(document, bondTarget(document, "bond0"), "double");
    expect(molecule(first).bonds[0].order).toBe("double");
    expect(nativeMoleculeInvalidAtomStates(molecule(first)).map(state => state.atomId)).toContain("source");
    const final = molecule(applyNativeMoleculeBondOrderValueTarget(first, bondTarget(first, "bond1"), "double"));
    expect(final.atoms.map(atom => [atom.id, atom.element, atom.formalCharge, atom.x, atom.y]))
      .toEqual(baseline.atoms.map(atom => [atom.id, atom.element, atom.formalCharge, atom.x, atom.y]));
    expect(final.bonds.map(bond => bond.order)).toEqual(["double", "double", "single", "single"]);
    expect(final.chemistry?.formula).toBe("H2O4S");
    expect(nativeMoleculeInvalidAtomStates(final)).toEqual([]);
  });

  it.each([2, 3])("9 chooses the correct alkyl topology at carbon degree %s (IV-9)", degree => {
    const document = star(degree), before = molecule(document);
    const result = nativeAtomSproutHotkeyTarget(document, atomTarget(document), "gemDimethyl");
    expect(result.refusal).toBeUndefined();
    const after = molecule(result.document);
    expect(after.atoms).toHaveLength(before.atoms.length + (degree === 3 ? 3 : 2));
    expect(incident(after)).toHaveLength(4);
    const source = after.atoms.find(atom => atom.id === "source")!;
    expect(nativeAtomValidationState(source, after.bonds, source.formalCharge, after.atoms).valid).toBe(true);
    const added = after.atoms.filter(atom => !before.atoms.some(old => old.id === atom.id));
    expect(added.map(atom => incident(after, atom.id).length).sort()).toEqual(degree === 3 ? [1, 1, 3] : [1, 1]);
    expect(after.atoms.slice(0, before.atoms.length)).toEqual(before.atoms);
    expect(after.bonds.slice(0, before.bonds.length)).toEqual(before.bonds);
  });

  it("9 leaves C4 unchanged rather than making pentavalent carbon", () => {
    const document = star(4);
    const result = nativeAtomSproutHotkeyTarget(document, atomTarget(document), "gemDimethyl");
    expect(result).toEqual({ document, refusal: "branched-carbon-full" });
    expect(incident(molecule(result.document))).toHaveLength(4);
    expect(nativeMoleculeInvalidAtomStates(molecule(result.document))).toEqual([]);
  });

  it("growth hits and explicit growth stay available beyond eight bonds", () => {
    const document = star(8), before = molecule(document);
    expect(findNativeMoleculeAtomHit(before, before.atoms[0])?.atomId).toBe("source");
    const result = nativeSingleBondHotkeyAtAtomTarget(document, atomTarget(document), {
      newAtomPoint: { x: 350, y: 310 }, direction: { x: 1, y: 0 }
    });
    expect(result.refusal).toBeUndefined();
    expect(incident(molecule(result.document))).toHaveLength(9);
    expect(nativeMoleculeInvalidAtomStates(molecule(result.document)).map(state => state.atomId)).toContain("source");
  });

  it("a bond dragged from another object merges onto a target beyond eight bonds", () => {
    const document = star(8), before = molecule(document), source = before.atoms[0];
    const withOther = insertNativeSingleBondMolecule(document, { x: 450, y: 300 });
    const other = withOther.pages[0].objects.filter(object => object.type === "molecule").at(-1) as MoleculeObject;
    const joined = applyFreeformSingleBondToolAtPoint(withOther, other.id, other.atoms[0].id, source, { forceCustomLength: true });
    expect(joined.pages[0].objects.filter(object => object.type === "molecule")).toHaveLength(1);
    const after = molecule(joined);
    const mergedSource = after.atoms.find(atom => atom.x === source.x && atom.y === source.y)!;
    expect(incident(after, mergedSource.id)).toHaveLength(9);
    const { id: _oldId, ...authored } = source;
    expect(mergedSource).toMatchObject(authored);
    expect(nativeMoleculeInvalidAtomStates(after).map(state => state.atomId)).toContain(mergedSource.id);
  });

  it("a chain run starts beyond eight source bonds and preserves its warning", () => {
    const document = star(8), before = molecule(document), source = before.atoms[0];
    const grown = applyNativeChainTool(document, source, { x: 450, y: 400 }, { objectId: before.id, atomId: source.id });
    const after = molecule(grown);
    expect(after.atoms.length).toBeGreaterThan(before.atoms.length);
    expect(incident(after)).toHaveLength(9);
    expect(nativeMoleculeInvalidAtomStates(after).map(state => state.atomId)).toContain(source.id);
  });

  it.each(["charge", "radical-dot"] as const)("a %s stays on clicked C4 instead of moving to a neighbour or floating", kind => {
    const document = star(4), target = atomTarget(document);
    const marked = reconcileNativeChargeMarks(applyChargeToolAtNativeAtom(document,
      kind === "charge" ? 1 : { kind: "radical-dot" }, target));
    const after = molecule(marked);
    expect(after.atoms[0]).toMatchObject(kind === "charge" ? { formalCharge: 1, markCharge: 1 } : { formalCharge: 0, markRadicals: 1 });
    expect(after.atoms.slice(1)).toEqual(molecule(document).atoms.slice(1));
    expect(after.bonds).toEqual(molecule(document).bonds);
    const mark = marked.pages[0].objects.find(object => object.type === "electron-mark");
    expect(mark).toMatchObject({ anchor: { kind: "atom", objectId: after.id, atomId: "source" } });
    expect(nativeMoleculeInvalidAtomStates(after).map(state => state.atomId)).toContain("source");
    expect(reconcileNativeChargeMarks(marked)).toBe(marked);
  });

  it("keeps group multiple-bond and dashed dative format guards", () => {
    let document = star(1);
    document = applyNativeAtomElementTarget(document, atomTarget(document, "tip0"), "OMe");
    expect(applyNativeMoleculeBondOrderValueTarget(document, bondTarget(document, "bond0"), "double")).toBe(document);
    const plain = star(1);
    const dashed = applyPatches(plain, [{ op: "updateObject", objectId: molecule(plain).id,
      changes: { bonds: [{ ...molecule(plain).bonds[0], display: { bondStyle: "dashed" } }] }
    }]);
    expect(applyNativeMoleculeBondOrderValueTarget(dashed, bondTarget(dashed, "bond0"), "double")).toBe(dashed);
  });
});
