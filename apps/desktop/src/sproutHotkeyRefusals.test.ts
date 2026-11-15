// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { applyPatches, type MoleculeObject } from "@chemdraft/chem-core";
import {
  nativeMoleculeInvalidAtomStates, createPhase4Document, insertNativeSingleBondMolecule,
  nativeAtomSproutHotkeyTarget, nativeCarbonylHotkeyAtAtomTarget, nativeSingleBondHotkeyAtAtomTarget,
  type NativeAtomSproutHotkeyResult, type NativeMoleculeDeleteTarget
} from "./documentWorkflow";
import { nativeTemplateFallbackReasonText } from "./MainWindow";
import { insertSmilesMolecule, nativeBondLengthPx } from "@chemdraft/document-workflow-core";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import { nativeOxoHotkeyTarget } from "./sproutHotkeys";

function seed() {
  const document = insertNativeSingleBondMolecule(createPhase4Document("Sprout refusal"), { x: 300, y: 300 });
  const molecule = document.pages[0].objects[0] as MoleculeObject;
  const target: NativeMoleculeDeleteTarget = {
    objectId: molecule.id, kind: "atom", atomId: molecule.atoms[1].id, distanceToPointer: 0
  };
  return { document, molecule, target };
}

const hotkeys = [
  ["single bond", nativeSingleBondHotkeyAtAtomTarget],
  ["C=O", nativeCarbonylHotkeyAtAtomTarget],
  ...(["wedge", "hashed", "methylidene", "gemDimethyl", "cyclic"] as const).map(kind => [
    kind, (document, target) => nativeAtomSproutHotkeyTarget(document, target, kind)
  ] as [string, (document: ReturnType<typeof seed>["document"], target: NativeMoleculeDeleteTarget) => NativeAtomSproutHotkeyResult])
] as const;

describe("sprout refusal diagnostics", () => {
  it.each([
    ["sulfone", "CS(=O)(=O)C", "S"],
    ["phosphine oxide", "CP(=O)(C)C", "P"]
  ])("the oxo key keeps the specific refusal for %s", (_name, smiles, element) => {
    const document = insertSmilesMolecule(createPhase4Document("Full oxo target"), { x: 300, y: 300 }, depictSmiles2D(smiles), smiles);
    const molecule = document.pages[0].objects[0] as MoleculeObject;
    const atom = molecule.atoms.find(atom => atom.element === element && molecule.bonds.filter(bond =>
      bond.fromAtomId === atom.id || bond.toAtomId === atom.id).length > 1)!;
    const result = nativeOxoHotkeyTarget(document, { objectId: molecule.id, kind: "atom", atomId: atom.id, distanceToPointer: 0 });
    expect(result).toEqual({ document, refusal: "atom-no-free-valence" });
    expect(`Cannot add carbonyl or oxo to hovered atom: ${nativeTemplateFallbackReasonText(result.refusal!)}`)
      .toBe("Cannot add carbonyl or oxo to hovered atom: that atom has no free valence");
  });

  it.each([["CP", "PH2"], ["CPC", "PH"], ["C1CC[PH]C1", "PH"]])("a second oxo on %s is refused exactly like the %s label path", (smiles, label) => {
    const document = insertSmilesMolecule(createPhase4Document("Phosphorus oxo limit"), { x: 300, y: 300 }, depictSmiles2D(smiles), smiles);
    const molecule = document.pages[0].objects[0] as MoleculeObject;
    const phosphorus = molecule.atoms.find(atom => atom.element === "P")!;
    const target = { objectId: molecule.id, kind: "atom" as const, atomId: phosphorus.id, distanceToPointer: 0 };
    const labelled = applyPatches(document, [{ op: "updateObject", objectId: molecule.id, changes: {
      atoms: molecule.atoms.map(atom => atom.id === phosphorus.id ? { ...atom, element: label, labelLiteral: true } : atom)
    } }]);
    const reference = nativeOxoHotkeyTarget(labelled, target);
    const first = nativeOxoHotkeyTarget(document, target);
    expect(reference.refusal).toBeUndefined();
    expect(first.refusal).toBeUndefined();
    const referenceRefusal = nativeOxoHotkeyTarget(reference.document, target);
    expect(referenceRefusal).toEqual({ document: reference.document, refusal: "atom-no-free-valence" });
    const result = nativeOxoHotkeyTarget(first.document, target);
    expect(result.refusal).toBe(referenceRefusal.refusal);
    expect(result.document).toBe(first.document);
    expect(`Cannot add carbonyl or oxo to hovered atom: ${nativeTemplateFallbackReasonText(result.refusal!)}`)
      .toBe("Cannot add carbonyl or oxo to hovered atom: that atom has no free valence");
  });

  it.each(hotkeys)("%s names a missing target and an uneditable structure", (_kind, apply) => {
    const { document, molecule, target } = seed();
    const missing = apply(document, { ...target, objectId: "missing" });
    expect(missing).toEqual({ document, refusal: "target-unavailable" });
    expect(nativeTemplateFallbackReasonText(missing.refusal!)).toBe("that target is unavailable");
    const uneditable = applyPatches(document, [{ op: "updateObject", objectId: molecule.id, changes: { atoms: [], bonds: [] } }]);
    const result = apply(uneditable, target);
    expect(result).toEqual({ document: uneditable, refusal: "structure-not-editable" });
    expect(nativeTemplateFallbackReasonText(result.refusal!)).toBe("that structure cannot be edited");
  });

  it("gem-dimethyl reports a failed second growth plan and discards the first methyl", () => {
    const { document, molecule } = seed();
    const L = nativeBondLengthPx;
    const atoms = [
      { id: "source", element: "C", formalCharge: 0, x: 300, y: 300 },
      { id: "up", element: "C", formalCharge: 0, x: 300 + L / 2, y: 300 - L * Math.sqrt(3) / 2 },
      { id: "down", element: "C", formalCharge: 0, x: 300 + L / 2, y: 300 + L * Math.sqrt(3) / 2 }
    ];
    const blockers = Array.from({ length: 24 }, (_, i) => {
      const angle = i * Math.PI / 12;
      return { id: `block${i}`, element: "OMe", formalCharge: 0,
        x: 300 + Math.cos(angle) * L, y: 300 + Math.sin(angle) * L };
    }).filter((_, i) => i !== 4 && i !== 20);
    const outside = blockers.map((atom, i) => ({ id: `outside${i}`, element: "C", formalCharge: 0,
      x: 300 + (atom.x - 300) * 2, y: 300 + (atom.y - 300) * 2 }));
    const crowded = applyPatches(document, [{ op: "updateObject", objectId: molecule.id, changes: {
      atoms: [...atoms, ...blockers, ...outside],
      bonds: [
        ...["up", "down"].map((toAtomId, i) => ({ id: `sourceb${i}`, fromAtomId: "source", toAtomId, order: "single" as const })),
        ...blockers.map((atom, i) => ({ id: `blockb${i}`, fromAtomId: atom.id, toAtomId: outside[i].id, order: "single" as const }))
      ]
    } }]);
    const target = { objectId: molecule.id, kind: "atom" as const, atomId: "source", distanceToPointer: 0 };
    // An explicit arrow supplies the first plan. After it is applied internally, the
    // second plan has no non-overlapping direction; neither methyl may be committed.
    const result = nativeAtomSproutHotkeyTarget(crowded, target, "gemDimethyl", {
      newAtomPoint: atoms[1], direction: { x: 0.5, y: -Math.sqrt(3) / 2 }
    });
    expect(result).toEqual({ document: crowded, refusal: "sprout-no-free-direction" });
    expect(`Cannot add gem-dimethyl here: ${nativeTemplateFallbackReasonText(result.refusal!)}`)
      .toBe("Cannot add gem-dimethyl here: there is no free direction to grow into without overlapping");
  });

  it("a single-bond closure names an existing bond without changing the document", () => {
    const { document, molecule, target } = seed();
    const result = nativeSingleBondHotkeyAtAtomTarget(document, target, {
      newAtomPoint: molecule.atoms[0], direction: { x: -1, y: 0 }, targetAtomId: molecule.atoms[0].id
    });
    expect(result).toEqual({ document, refusal: "closure-bond-exists" });
    expect(`Cannot add a single bond to hovered atom: ${nativeTemplateFallbackReasonText(result.refusal!)}`)
      .toBe("Cannot add a single bond to hovered atom: those atoms are already connected");
  });

  it.each([true, false])("a single-bond connection lands at a full target and warns (ring closure: %s)", (ringClosure) => {
    const { document, molecule, target } = seed();
    const blocked = applyPatches(document, [{ op: "updateObject", objectId: molecule.id, changes: {
      atoms: [...molecule.atoms, { id: "block", element: "OMe", formalCharge: 0, x: 300, y: 250 },
        ...(!ringClosure ? [{ id: "other", element: "C", formalCharge: 0, x: 250, y: 250 }] : [])],
      bonds: [...molecule.bonds, { id: "blockb", fromAtomId: "block", toAtomId: ringClosure ? molecule.atoms[0].id : "other", order: "single" }]
    } }]);
    const result = nativeSingleBondHotkeyAtAtomTarget(blocked, target, {
      newAtomPoint: { x: 300, y: 250 }, direction: { x: 0, y: -1 }, targetAtomId: "block"
    });
    expect(result.refusal).toBeUndefined();
    const after = result.document.pages[0].objects.find(object => object.id === molecule.id) as MoleculeObject;
    expect(after.bonds).toHaveLength(molecule.bonds.length + 2);
    expect(nativeMoleculeInvalidAtomStates(after).map(state => state.atomId)).toContain("block");
  });
});
