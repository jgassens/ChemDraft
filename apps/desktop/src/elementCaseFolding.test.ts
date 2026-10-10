// Element case folding on the desktop's relabel paths: the inline label editor and hotkeys
// (applyNativeAtomElementTarget), text converted to an atom, and reopening a saved file. "NH" used to
// become nihonium and "CO" cobalt; the folding rule itself is tested in layout-engine.

import { describe, expect, it } from "vitest";
import type { ChemDraftDocument, MoleculeObject, TextObject } from "@chemdraft/chem-core";

import {
  applyNativeAtomElementTarget,
  convertNativeTextObjectToAtom,
  createNativeSavePayload,
  createPhase4Document,
  getSelectedMolecule,
  insertNativeSingleBondMolecule,
  insertNativeTextObject,
  insertNativeTemplateMolecule,
  openNativeDocument
} from "./documentWorkflow";

function selectedMolecule(document: ChemDraftDocument): MoleculeObject {
  const molecule = getSelectedMolecule(document);
  if (!molecule) throw new Error("Expected a selected molecule.");
  return molecule;
}

function relabel(document: ChemDraftDocument, atomId: string, label: string, options: { literal?: boolean } = {}): ChemDraftDocument {
  const molecule = selectedMolecule(document);
  return applyNativeAtomElementTarget(document, { objectId: molecule.id, kind: "atom", atomId, distanceToPointer: 0 }, label, options);
}

describe("relabel paths", () => {
  it("stores a typed NH on a ring nitrogen as NH, never nihonium", () => {
    const ring = insertNativeTemplateMolecule(createPhase4Document("NH Ring"), { x: 300, y: 300 }, "cyclopentane");
    const ringAtomId = selectedMolecule(ring).atoms[0]!.id;
    const molecule = selectedMolecule(relabel(ring, ringAtomId, "NH", { literal: true }));
    expect(molecule.atoms[0]!.element).toBe("NH");
    // Pyrrolidine: four CH2 and an N–H.
    expect(molecule.chemistry?.formula).toBe("C4H9N");
    // Lower case is ambiguous (nihonium or N–H), so it is not folded to an element at all: it stays
    // the text typed and counts nothing, rather than silently becoming either one.
    const lower = selectedMolecule(relabel(ring, ringAtomId, "nh", { literal: true }));
    expect(lower.atoms[0]!.element).toBe("nh");
    expect(lower.chemistry?.formula).toBe("C4H8");
  });

  it("stores CO and CN as typed, not cobalt and copernicium, while Co and cl still fold", () => {
    const ethane = insertNativeSingleBondMolecule(createPhase4Document("Two Letters"), { x: 300, y: 300 });
    expect(selectedMolecule(relabel(ethane, "atom_002", "CO", { literal: true })).atoms[1]!.element).toBe("CO");
    expect(selectedMolecule(relabel(ethane, "atom_002", "CN", { literal: true })).atoms[1]!.element).toBe("CN");
    expect(selectedMolecule(relabel(ethane, "atom_002", "Co")).atoms[1]!.element).toBe("Co");
    expect(selectedMolecule(relabel(ethane, "atom_002", "cl")).atoms[1]!.element).toBe("Cl");
  });

  it("returns to the earlier chemistry when NH is relabelled back to N", () => {
    const ring = insertNativeTemplateMolecule(createPhase4Document("NH Back"), { x: 300, y: 300 }, "cyclopentane");
    const ringAtomId = selectedMolecule(ring).atoms[0]!.id;
    const nitrogen = relabel(ring, ringAtomId, "N");
    const typed = relabel(nitrogen, ringAtomId, "NH", { literal: true });
    const back = selectedMolecule(relabel(typed, ringAtomId, "N"));
    expect(back.chemistry).toEqual(selectedMolecule(nitrogen).chemistry);
  });
});

describe("text converted to an atom", () => {
  function textConverted(text: string): ChemDraftDocument {
    const withText = insertNativeTextObject(createPhase4Document("Text Atom"), { x: 200, y: 200 }, text);
    const textObject = withText.pages[0]!.objects.find((object): object is TextObject => object.type === "text")!;
    return convertNativeTextObjectToAtom(withText, textObject.id);
  }

  it("leaves NH and CO as text instead of making nihonium and cobalt atoms", () => {
    for (const text of ["NH", "CO", "CN"]) {
      const objects = textConverted(text).pages[0]!.objects;
      expect(objects.some((object) => object.type === "molecule"), text).toBe(false);
      expect(objects.some((object) => object.type === "text"), text).toBe(true);
    }
  });

  it("still converts an element symbol in any unambiguous case", () => {
    for (const [text, element] of [["Cl", "Cl"], ["cl", "Cl"], ["Co", "Co"], ["n", "N"]] as const) {
      const molecule = textConverted(text).pages[0]!.objects.find((object): object is MoleculeObject => object.type === "molecule");
      expect(molecule?.atoms[0]?.element, text).toBe(element);
    }
  });
});

describe("files saved before the fix", () => {
  it("reopen with the elements they stored: a saved Nh stays Nh and Co stays Co", () => {
    const ethane = insertNativeSingleBondMolecule(createPhase4Document("Old File"), { x: 300, y: 300 });
    const molecule = selectedMolecule(ethane);
    // What the old blind folding wrote for a typed "NH" and "CO".
    const old: ChemDraftDocument = {
      ...ethane,
      pages: ethane.pages.map((page) => ({
        ...page,
        objects: page.objects.map((object) => object.id === molecule.id
          ? { ...molecule, atoms: [{ ...molecule.atoms[0]!, element: "Nh" }, { ...molecule.atoms[1]!, element: "Co" }] }
          : object)
      }))
    };
    const reopened = openNativeDocument(createNativeSavePayload(old).contents).document!;
    const atoms = reopened.pages[0]!.objects.find((object): object is MoleculeObject => object.type === "molecule")!.atoms;
    expect(atoms.map((atom) => atom.element)).toEqual(["Nh", "Co"]);
  });
});
