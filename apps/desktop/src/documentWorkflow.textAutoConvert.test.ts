import { describe, expect, it } from "vitest";
import {
  convertNativeTextObjectToAtom,
  createPhase4Document,
  insertNativeSingleBondMolecule,
  insertNativeTemplateMolecule,
  insertNativeTextObject
} from "./documentWorkflow";

describe("finished text auto-conversion", () => {
  it.each(["N", "Cl", "Br", "C", "O"])("converts exact element symbol '%s'", element => {
    const document = insertNativeTextObject(createPhase4Document("Exact element"), { x: 300, y: 300 }, element);
    const converted = convertNativeTextObjectToAtom(document, document.selection.objectIds[0]!);
    expect(converted.pages[0].objects).toHaveLength(1);
    const molecule = converted.pages[0].objects[0];
    expect(molecule.type).toBe("molecule");
    if (molecule.type !== "molecule") throw new Error("Expected element atom");
    expect(molecule.atoms).toHaveLength(1);
    expect(molecule.atoms[0]).toMatchObject({ element, formalCharge: 0, labelLiteral: true });
    expect(molecule.bonds).toHaveLength(0);
    expect(converted.selection.objectIds).toEqual([molecule.id]);
  });

  it.each(["n", "cl", "CL", "Nn", "hello", "", " N", "N ", "N\n", "OMe", "CH3"])(
    "keeps '%s' exactly as text", text => {
      const document = insertNativeTextObject(createPhase4Document("Literal text"), { x: 300, y: 300 }, text);
      expect(convertNativeTextObjectToAtom(document, document.selection.objectIds[0]!)).toBe(document);
    }
  );

  it.each(["n", "cl", "CL", "Nn", "hello", "Ome", "ome", " OMe", "OMe "])("keeps '%s' as text even beside an atom", text => {
    const base = insertNativeSingleBondMolecule(createPhase4Document("Text beside molecule"), { x: 300, y: 300 });
    const molecule = base.pages[0].objects.find(object => object.type === "molecule")!;
    const document = insertNativeTextObject(base, molecule.atoms[0], text);
    expect(convertNativeTextObjectToAtom(document, document.selection.objectIds[0]!)).toBe(document);
    expect(document.pages[0].objects.find(object => object.id === molecule.id)).toBe(molecule);
  });

  it("attaches a recognized OMe group beside a ring exactly once", () => {
    const base = insertNativeTemplateMolecule(createPhase4Document("Text beside ring"), { x: 300, y: 300 }, "cyclohexane");
    const molecule = base.pages[0].objects.find(object => object.type === "molecule")!;
    const document = insertNativeTextObject(base, molecule.atoms[0]!, "OMe");
    const textId = document.selection.objectIds[0]!;
    const converted = convertNativeTextObjectToAtom(document, textId);
    expect(converted.pages[0].objects).toHaveLength(1);
    const attached = converted.pages[0].objects[0];
    expect(attached.type).toBe("molecule");
    if (attached.type !== "molecule") throw new Error("Expected ring with substituent");
    expect(attached.atoms.slice(0, 6)).toEqual(molecule.atoms);
    expect(attached.atoms).toHaveLength(7);
    expect(attached.atoms[6]).toMatchObject({ element: "OMe", labelLiteral: true });
    expect(attached.bonds).toHaveLength(7);
    expect(convertNativeTextObjectToAtom(converted, textId)).toBe(converted);
  });
});
