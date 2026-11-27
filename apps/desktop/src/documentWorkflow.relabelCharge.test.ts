import { describe, expect, it } from "vitest";
import { type ChemDraftDocument, type MoleculeAtom, type MoleculeObject } from "@chemdraft/chem-core";
import { nativeAtomLabelReading } from "@chemdraft/layout-engine";
import { abbreviationBondedSpellings, bondedElementLabelMeaning } from "@chemdraft/template-library";
import {
  applyNativeAtomElementTarget,
  applyNativeAtomLabelDraft,
  chargedAtomRelabelRefusal,
  chargedLabelOnChargeMarkRefusal,
  commitNativeAtomLabelTarget,
  convertNativeTextObjectToAtom,
  convertNativeTextObjectToAtomLabel,
  createPhase4Document,
  finishNativeAtomLabelEdit,
  insertNativeSingleBondMolecule,
  insertNativeTemplateMolecule,
  insertNativeTextObject
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

describe("a charged label the atom cannot hold is refused and changes nothing", () => {
  /** Ethane whose first carbon's +2 all comes from charge marks (`markCharge`), as reconciliation records it. */
  function markedEthane() {
    const { document, atom, target } = ethane();
    return { document: withAtom(document, atom.id, { formalCharge: 2, markCharge: 2 }), atom, target };
  }

  /** One unbonded carbon, made the way a finished "C" text box becomes an atom. */
  function loneCarbon() {
    const typed = insertNativeTextObject(createPhase4Document("Lone atom"), { x: 300, y: 300 }, "C");
    const document = convertNativeTextObjectToAtom(typed, typed.selection.objectIds[0]!);
    const object = molecule(document);
    expect(object.atoms).toHaveLength(1);
    expect(object.bonds).toHaveLength(0);
    const atom = object.atoms[0]!;
    return { document, atom, target: { objectId: object.id, kind: "atom" as const, atomId: atom.id, distanceToPointer: 0 } };
  }

  it.each(["N+", "N-", "Zn2+", "C+"])("refuses %s over an atom carrying a charge mark", label => {
    const { document, atom, target } = markedEthane();
    expect(chargedAtomRelabelRefusal(atomIn(document, atom.id), molecule(document), label)).toBe(chargedLabelOnChargeMarkRefusal);
    // The label draft writes nothing, and the close refuses with the message, the document untouched.
    expect(applyNativeAtomElementTarget(document, target, label, { literal: true })).toBe(document);
    expect(applyNativeAtomLabelDraft(document, target, label, { element: "C", literal: false, formalCharge: 2 })).toBe(document);
    const result = commitNativeAtomLabelTarget(document, target, label, { literal: true, replaceElement: true });
    expect(result.refusal).toBe("Remove the charge mark before typing a charged label.");
    expect(result.message).toBe(result.refusal);
    expect(result.document).toBe(document);
    expect(atomIn(result.document, atom.id)).toMatchObject({ element: "C", formalCharge: 2, markCharge: 2 });
  });

  it("still relabels a marked atom with an uncharged label, keeping its charge and mark", () => {
    const { document, atom, target } = markedEthane();
    const result = commitNativeAtomLabelTarget(document, target, "O", { literal: true, replaceElement: true });
    expect(result.refusal).toBeUndefined();
    expect(atomIn(result.document, atom.id)).toMatchObject({ element: "O", formalCharge: 2, markCharge: 2 });
  });

  it("keeps a charged text box on a marked atom as text, with the refusal", () => {
    const { document, atom } = markedEthane();
    const typed = insertNativeTextObject(document, atomIn(document, atom.id), "N+");
    const result = convertNativeTextObjectToAtomLabel(typed, typed.selection.objectIds[0]!);
    expect(result.disabledReason).toBe(chargedLabelOnChargeMarkRefusal);
    expect(result.message).toBe(`Text kept: ${chargedLabelOnChargeMarkRefusal}`);
    expect(result.document).toBe(typed);
    expect(convertNativeTextObjectToAtom(typed, typed.selection.objectIds[0]!)).toBe(typed);
  });

  // Every element symbol a bonded typed label reads as something else, from the table itself.
  const bondedSymbols = [...abbreviationBondedSpellings, "Ar"];
  it("covers the table's bonded spellings", () => {
    expect(abbreviationBondedSpellings).toEqual(expect.arrayContaining(["Ac", "Pr", "Ts"]));
    for (const symbol of bondedSymbols) expect(bondedElementLabelMeaning(symbol)).toBeTruthy();
  });

  it.each(bondedSymbols.flatMap(symbol => [`${symbol}+`, `${symbol}3+`, `${symbol}-`]))(
    "refuses %s on a bonded atom, naming the group it would read as", label => {
      const { document, atom, target } = ethane();
      const symbol = label.replace(/[0-9+-]+$/, "");
      const expected = `${label} on a bonded atom reads as the ${bondedElementLabelMeaning(symbol)} group; draw the ion unbonded or set the charge separately.`;
      expect(chargedAtomRelabelRefusal(atom, molecule(document), label)).toBe(expected);
      expect(applyNativeAtomElementTarget(document, target, label, { literal: true })).toBe(document);
      const result = commitNativeAtomLabelTarget(document, target, label, { literal: true, replaceElement: true });
      expect(result.refusal).toBe(expected);
      expect(result.document).toBe(document);
      expect(atomIn(result.document, atom.id)).toEqual(atom);
    }
  );

  it("names acetyl for Ac+ on a bonded atom", () => {
    const { document, atom } = ethane();
    expect(chargedAtomRelabelRefusal(atom, molecule(document), "Ac+"))
      .toBe("Ac+ on a bonded atom reads as the acetyl group; draw the ion unbonded or set the charge separately.");
  });

  it("keeps a charged Ac text box on a bonded atom as text", () => {
    const { document, atom } = ethane();
    const typed = insertNativeTextObject(document, atom, "Ac+");
    const result = convertNativeTextObjectToAtomLabel(typed, typed.selection.objectIds[0]!);
    expect(result.disabledReason).toMatch(/^Ac\+ on a bonded atom reads as the acetyl group/);
    expect(result.document).toBe(typed);
  });

  it("leaves an uncharged Ac on a bonded atom the acetyl abbreviation", () => {
    const { document, atom, target } = ethane();
    const result = commitNativeAtomLabelTarget(document, target, "Ac", { literal: true, replaceElement: true });
    expect(result.refusal).toBeUndefined();
    const relabeled = atomIn(result.document, atom.id);
    expect(relabeled).toMatchObject({ element: "Ac", formalCharge: 0, labelLiteral: true });
    expect(nativeAtomLabelReading(relabeled.element, { bonded: true, typed: true })).toMatchObject({
      kind: "group", group: { kind: "abbreviation", label: "Ac", definition: { name: "acetyl" } }
    });
  });

  it.each([["Ac+", "Ac", 1], ["Pr3+", "Pr", 3], ["Ar+", "Ar", 1]] as const)(
    "relabels an unbonded atom typed %s as the element %s with charge %d", (label, element, charge) => {
      const { document, atom, target } = loneCarbon();
      expect(chargedAtomRelabelRefusal(atom, molecule(document), label)).toBeUndefined();
      const result = commitNativeAtomLabelTarget(document, target, label, { literal: true, replaceElement: true });
      expect(result.refusal).toBeUndefined();
      expect(atomIn(result.document, atom.id)).toMatchObject({ element, formalCharge: charge });
    }
  );

  it("turns a free Ac+ text box into an actinium atom with charge +1", () => {
    const typed = insertNativeTextObject(createPhase4Document("Free ion"), { x: 300, y: 300 }, "Ac+");
    const converted = convertNativeTextObjectToAtom(typed, typed.selection.objectIds[0]!);
    expect(molecule(converted).atoms).toEqual([expect.objectContaining({ element: "Ac", formalCharge: 1 })]);
  });

  it("never refuses a label with no charge of its own", () => {
    const { document, atom } = markedEthane();
    for (const label of ["N", "O", "Ac", "Ts", "NH4+", "OMe", "Zn"]) {
      expect(chargedAtomRelabelRefusal(atomIn(document, atom.id), molecule(document), label)).toBeUndefined();
    }
  });
});
