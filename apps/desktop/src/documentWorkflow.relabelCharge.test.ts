import { describe, expect, it } from "vitest";
import { type ChemDraftDocument, type MoleculeAtom, type MoleculeObject } from "@chemdraft/chem-core";
import {
  applyNativeAtomElementTarget,
  applyNativeAtomLabelDraft,
  commitNativeAtomLabelTarget,
  createPhase4Document,
  finishNativeAtomLabelEdit,
  insertNativeSingleBondMolecule,
  insertNativeTemplateMolecule
} from "./documentWorkflow";

// Relabelling an existing atom with typed text: an element symbol with a charge ("Zn2+", "N+")
// sets that element and exactly that charge; any other text keeps today's relabel and the charge.

function molecule(document: ChemDraftDocument): MoleculeObject {
  const object = document.pages[0].objects.find((candidate): candidate is MoleculeObject => candidate.type === "molecule");
  if (!object) throw new Error("Expected molecule");
  return object;
}

function withAtom(document: ChemDraftDocument, atomId: string, changes: Partial<MoleculeAtom>): ChemDraftDocument {
  const object = molecule(document);
  const next = { ...object, atoms: object.atoms.map(atom => atom.id === atomId ? { ...atom, ...changes } : atom) };
  return { ...document, pages: document.pages.map(page => ({ ...page,
    objects: page.objects.map(candidate => candidate.id === next.id ? next : candidate) })) };
}

function ethane() {
  const document = insertNativeSingleBondMolecule(createPhase4Document("Relabel charge"), { x: 300, y: 300 });
  const object = molecule(document);
  const atom = object.atoms[0]!;
  return { document, atom, target: { objectId: object.id, kind: "atom" as const, atomId: atom.id, distanceToPointer: 0 } };
}

function atomIn(document: ChemDraftDocument, atomId: string): MoleculeAtom {
  return molecule(document).atoms.find(atom => atom.id === atomId)!;
}

describe("relabelling an atom with an element and its charge", () => {
  it.each([
    ["Zn2+", "Zn", 2], ["Zn+2", "Zn", 2], ["Fe3+", "Fe", 3], ["Cl-", "Cl", -1], ["Na+", "Na", 1],
    ["N+", "N", 1], ["Zn²⁺", "Zn", 2], ["Fe⁺³", "Fe", 3], ["Cl−", "Cl", -1]
  ] as const)("the label editor's commit relabels a carbon typed %s as %s with charge %d", (label, element, charge) => {
    const { document, atom, target } = ethane();
    const result = commitNativeAtomLabelTarget(document, target, label, { literal: true, replaceElement: true });
    expect(result.target).toEqual(target);
    expect(molecule(result.document).atoms).toHaveLength(molecule(document).atoms.length);
    expect(atomIn(result.document, atom.id)).toMatchObject({ element, formalCharge: charge, labelLiteral: true });
  });

  it("never places a charged symbol as a neutral substituent on a ring carbon", () => {
    const document = insertNativeTemplateMolecule(createPhase4Document("Ring"), { x: 300, y: 300 }, "cyclohexane");
    const object = molecule(document);
    const atom = object.atoms[0]!;
    const target = { objectId: object.id, kind: "atom" as const, atomId: atom.id, distanceToPointer: 0 };
    // Uncharged Cl over a ring carbon attaches a chlorine substituent, as before.
    const neutral = commitNativeAtomLabelTarget(document, target, "Cl", { literal: true });
    expect(molecule(neutral.document).atoms).toHaveLength(object.atoms.length + 1);
    const charged = commitNativeAtomLabelTarget(document, target, "Cl-", { literal: true });
    expect(molecule(charged.document).atoms).toHaveLength(object.atoms.length);
    expect(atomIn(charged.document, atom.id)).toMatchObject({ element: "Cl", formalCharge: -1 });
  });

  it("sets the typed charge, replacing the atom's own, and is a no-op when nothing changes", () => {
    const { document, atom, target } = ethane();
    const charged = withAtom(document, atom.id, { formalCharge: 1 });
    expect(atomIn(applyNativeAtomElementTarget(charged, target, "N-", { literal: true }), atom.id))
      .toMatchObject({ element: "N", formalCharge: -1 });
    const once = applyNativeAtomElementTarget(document, target, "Zn2+", { literal: true });
    expect(applyNativeAtomElementTarget(once, target, "Zn2+", { literal: true })).toBe(once);
  });

  it.each(["O", "n", "Xx", "Xx2+", "OMe", "NH4+", "zn2+", "Zn++", "C5+"])(
    "keeps today's relabel for '%s', charge unchanged", label => {
      const { document, atom, target } = ethane();
      const charged = withAtom(document, atom.id, { formalCharge: 1 });
      const relabeled = atomIn(applyNativeAtomElementTarget(charged, target, label, { literal: true }), atom.id);
      expect(relabeled.formalCharge).toBe(1);
      expect(relabeled.element).not.toMatch(/^(Zn|C)$/);
    }
  );

  it("keeps a carbon-13 isotope when the same element is retyped with a charge", () => {
    const { document, atom, target } = ethane();
    const labelled = withAtom(document, atom.id, { isotope: 13 });
    const result = commitNativeAtomLabelTarget(labelled, target, "C+", { literal: true, replaceElement: true });
    expect(result.refusal).toBeUndefined();
    expect(atomIn(result.document, atom.id)).toMatchObject({ element: "C", isotope: 13, formalCharge: 1 });
  });
});

describe("an atom an older build stored with its charge in the element string", () => {
  // Opening a document never relabels (no relabel runs on open), and the label editor always starts
  // from a cleared or typed draft, so the stored "Zn2+" changes only when the user types a label.
  it("becomes zinc with charge +2 when the user types Zn2+ over it", () => {
    const { document, atom, target } = ethane();
    const legacy = withAtom(document, atom.id, { element: "Zn2+", labelLiteral: true });
    const start = { element: "Zn2+", literal: true, formalCharge: 0 };
    const typed = applyNativeAtomLabelDraft(applyNativeAtomLabelDraft(legacy, target, "Zn2", start), target, "Zn2+", start);
    expect(atomIn(typed, atom.id)).toMatchObject({ element: "Zn", formalCharge: 2 });
    const committed = commitNativeAtomLabelTarget(legacy, target, "Zn2+", { literal: true, replaceElement: true });
    expect(atomIn(committed.document, atom.id)).toMatchObject({ element: "Zn", formalCharge: 2 });
  });
});

describe("a label draft and its close carry the charge", () => {
  it("a draft that types a charge and deletes it again returns to the starting charge", () => {
    const { document, atom, target } = ethane();
    const start = { element: "C", literal: false, formalCharge: 0 };
    let current = document;
    const seen: Array<[string, number]> = [];
    for (const draft of ["Z", "Zn", "Zn2", "Zn2+", "Zn2", "Zn"]) {
      current = applyNativeAtomLabelDraft(current, target, draft, start);
      const now = atomIn(current, atom.id);
      seen.push([now.element, now.formalCharge]);
    }
    expect(seen).toEqual([["Z", 0], ["Zn", 0], ["Zn2", 0], ["Zn", 2], ["Zn2", 0], ["Zn", 0]]);
  });

  it("an uncharged draft over a charged atom keeps that atom's starting charge", () => {
    const { document, atom, target } = ethane();
    const charged = withAtom(document, atom.id, { element: "N", formalCharge: 1 });
    const start = { element: "N", literal: false, formalCharge: 1 };
    const minus = applyNativeAtomLabelDraft(charged, target, "N-", start);
    expect(atomIn(minus, atom.id)).toMatchObject({ element: "N", formalCharge: -1 });
    expect(atomIn(applyNativeAtomLabelDraft(minus, target, "O", start), atom.id)).toMatchObject({ element: "O", formalCharge: 1 });
  });

  it("closing a side-dependent label back on its starting text restores its starting charge", () => {
    const { document, atom, target } = ethane();
    const start = { element: "SCN", literal: true, formalCharge: 0 };
    // The session's last written state still holds a charge an earlier draft key typed.
    const stale = withAtom(document, atom.id, { element: "SCN", labelLiteral: true, formalCharge: -1 });
    expect(atomIn(finishNativeAtomLabelEdit(stale, target, start), atom.id)).toMatchObject({ element: "SCN", formalCharge: 0 });
  });
});
