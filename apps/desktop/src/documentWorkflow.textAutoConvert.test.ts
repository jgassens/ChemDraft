import { describe, expect, it } from "vitest";
import { applyPatch, type ChemDraftDocument, type MoleculeObject, type TextSpan } from "@chemdraft/chem-core";
import { atomDisplayLabel, nativeElementWithChargeLabel } from "@chemdraft/layout-engine";
import {
  canAutoConvertNativeTextObjectToAtom,
  commitNativeAtomLabelTarget,
  convertNativeTextObjectToAtom,
  createPhase4Document,
  insertNativeSingleBondMolecule,
  insertNativeTemplateMolecule,
  insertNativeTextObject,
  nativeTextObjectElementWithCharge,
  updateNativeTextObjectStyle
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

const onlyAtom = (document: ChemDraftDocument) => {
  const objects = document.pages[0].objects;
  expect(objects).toHaveLength(1);
  const molecule = objects[0]!;
  if (molecule.type !== "molecule") throw new Error("Expected a one-atom molecule");
  expect(molecule.atoms).toHaveLength(1);
  expect(molecule.bonds).toHaveLength(0);
  return { molecule, atom: molecule.atoms[0]! };
};

const span = (text: string, script: TextSpan["script"] = "normal", style: Record<string, unknown> = {}): TextSpan =>
  ({ text, script, style });

describe("typed element symbols with a charge (owner report 1.2.3)", () => {
  it.each([
    ["Zn", "Zn", 0], ["Zn2+", "Zn", 2], ["Zn+2", "Zn", 2], ["Fe3+", "Fe", 3], ["Cl-", "Cl", -1], ["Na+", "Na", 1],
    ["O2-", "O", -2], ["Zn\u00B2\u207A", "Zn", 2]
  ] as const)("turns '%s' in open space into one %s atom with charge %d", (text, element, charge) => {
    const document = insertNativeTextObject(createPhase4Document("Charged"), { x: 300, y: 300 }, text);
    const textObject = document.pages[0].objects[0]!;
    const { molecule, atom } = onlyAtom(convertNativeTextObjectToAtom(document, textObject.id));
    expect(atom).toMatchObject({ element, formalCharge: charge, labelLiteral: true });
    // Placed where the text was: centered on its frame.
    if (textObject.type !== "text") throw new Error("Expected text");
    expect(atom.x).toBeCloseTo(textObject.x + textObject.width / 2);
    expect(atom.y).toBeCloseTo(textObject.y + textObject.height / 2);
    const magnitude = Math.abs(charge) === 1 ? "" : `${Math.abs(charge)}`;
    expect(molecule.structure).toBe(charge === 0 ? `[${element}]` : `[${element}${charge > 0 ? "+" : "-"}${magnitude}]`);
  });

  it.each(["H2O", "CO2", "hello", "Xx", "Xx2+", "zn2+", "Zn++", "Zn0+", "Zn 2+", "Zn2+\nZn", "OH-", "NH4+", "OMe-", "H2+", "C5+"])(
    "keeps '%s' as text", text => {
      const document = insertNativeTextObject(createPhase4Document("Stays text"), { x: 300, y: 300 }, text);
      const id = document.selection.objectIds[0]!;
      expect(nativeTextObjectElementWithCharge({ text, spans: [] })).toBeUndefined();
      expect(convertNativeTextObjectToAtom(document, id)).toBe(document);
    }
  );

  it("lets the auto-conversion consider exactly the element symbols with an optional charge, plus groups", () => {
    const decide = (text: string) => {
      const document = insertNativeTextObject(createPhase4Document("Decide"), { x: 300, y: 300 }, text);
      return canAutoConvertNativeTextObjectToAtom(document, document.selection.objectIds[0]!);
    };
    expect(["Zn", "Zn2+", "Fe3+", "Cl-", "OMe"].map(decide)).toEqual([true, true, true, true, true]);
    expect(["H2O", "hello", "Xx", "zn", "Zn2+\nZn"].map(decide)).toEqual([false, false, false, false, false]);
  });

  it("reads the charge from runs: baseline symbol, superscript or baseline charge", () => {
    expect(nativeTextObjectElementWithCharge({ text: "Zn2+", spans: [span("Zn"), span("2+", "superscript")] }))
      .toEqual({ element: "Zn", formalCharge: 2 });
    expect(nativeTextObjectElementWithCharge({ text: "Fe3+", spans: [span("Fe"), span("3"), span("+", "superscript")] }))
      .toEqual({ element: "Fe", formalCharge: 3 });
    expect(nativeTextObjectElementWithCharge({ text: "Cl-", spans: [span("Cl-")] })).toEqual({ element: "Cl", formalCharge: -1 });
    expect(nativeTextObjectElementWithCharge({ text: "Zn", spans: [] })).toEqual({ element: "Zn", formalCharge: 0 });
  });

  it.each([
    ["a superscript symbol", { text: "Zn2+", spans: [span("Zn2+", "superscript")] }],
    ["a symbol letter raised", { text: "Zn2+", spans: [span("Z"), span("n2+", "superscript")] }],
    ["a subscript charge", { text: "Zn2+", spans: [span("Zn"), span("2+", "subscript")] }],
    ["a bold run", { text: "Zn2+", spans: [span("Zn", "normal", { fontWeight: 700 }), span("2+", "superscript")] }],
    ["a colored charge", { text: "Na+", spans: [span("Na"), span("+", "superscript", { color: "#ff0000" })] }],
    ["runs that disagree with the text", { text: "Zn2+", spans: [span("Zn"), span("3+", "superscript")] }]
  ] as const)("keeps styled text with %s as text", (_label, object) => {
    expect(nativeTextObjectElementWithCharge(object)).toBeUndefined();
  });

  it("converts a text object whose charge was raised with the superscript command", () => {
    const base = insertNativeTextObject(createPhase4Document("Superscript"), { x: 300, y: 300 }, "Zn2+");
    const id = base.selection.objectIds[0]!;
    const document = applyPatch(base, { op: "updateObject", objectId: id, changes: { spans: [span("Zn"), span("2+", "superscript")] } });
    expect(onlyAtom(convertNativeTextObjectToAtom(document, id)).atom).toMatchObject({ element: "Zn", formalCharge: 2 });
  });

  it("relabels an existing atom under a charged symbol with that element and charge", () => {
    const base = insertNativeSingleBondMolecule(createPhase4Document("Charged on atom"), { x: 300, y: 300 });
    const molecule = base.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule")!;
    const document = insertNativeTextObject(base, molecule.atoms[0]!, "Zn2+");
    const id = document.selection.objectIds[0]!;
    const converted = convertNativeTextObjectToAtom(document, id, { placementPoint: molecule.atoms[0]! });
    const molecules = converted.pages[0].objects.filter((object): object is MoleculeObject => object.type === "molecule");
    expect(converted.pages[0].objects.some(object => object.id === id)).toBe(false);
    expect(molecules).toHaveLength(1);
    expect(molecules[0]!.atoms).toHaveLength(molecule.atoms.length);
    expect(molecules[0]!.atoms[0]).toMatchObject({ id: molecule.atoms[0]!.id, element: "Zn", formalCharge: 2, labelLiteral: true });
    // Away from every atom the same text is a new zinc atom of its own.
    const away = insertNativeTextObject(base, { x: 100, y: 100 }, "Zn2+");
    const awayId = away.selection.objectIds[0]!;
    const placed = convertNativeTextObjectToAtom(away, awayId, { placementPoint: { x: 100, y: 100 } });
    expect(placed.pages[0].objects.find(object => object.id === molecule.id)).toEqual(molecule);
    expect(placed.pages[0].objects.filter(object => object.type === "molecule")).toHaveLength(2);
  });

  it.each(["O", "C", "N", "Zn", "Cl", "Zn2+", "Zn+2", "Fe3+", "Cl-", "Na+", "N+", "Zn\u00B2\u207A"])("gives '%s' the same atom whether typed as text or typed over an atom", text => {
    const typed = insertNativeTextObject(createPhase4Document("Same atom"), { x: 300, y: 300 }, text);
    const fromText = onlyAtom(convertNativeTextObjectToAtom(typed, typed.selection.objectIds[0]!)).atom;
    const seed = insertNativeTextObject(createPhase4Document("Same atom"), { x: 300, y: 300 }, "Fe");
    const seeded = onlyAtom(convertNativeTextObjectToAtom(seed, seed.selection.objectIds[0]!));
    const relabeled = commitNativeAtomLabelTarget(
      convertNativeTextObjectToAtom(seed, seed.selection.objectIds[0]!),
      { objectId: seeded.molecule.id, kind: "atom", atomId: seeded.atom.id, distanceToPointer: 0 }, text, { literal: true }
    );
    const fromRelabel = onlyAtom(relabeled.document).atom;
    const { x: _x1, y: _y1, ...textFields } = fromText;
    const { x: _x2, y: _y2, ...relabelFields } = fromRelabel;
    expect(textFields).toEqual(relabelFields);
    // A typed label is literal: no implicit hydrogens, and the label shows exactly the symbol ("O", not "H2O").
    expect(fromText).toMatchObject({ element: nativeElementWithChargeLabel(text)!.element, formalCharge: nativeElementWithChargeLabel(text)!.charge });
    if (fromText.formalCharge === 0) expect(atomDisplayLabel(fromText, [], undefined, [fromText])).toBe(text);
    expect(fromText.labelVisible === true).toBe(text === "C");
  });
});

describe("typed element symbols in a box formatted as a whole", () => {
  it.each([
    ["bold", { fontWeight: 700 }],
    ["red", { color: "#ff0000" }],
    ["italic", { fontStyle: "italic" }],
    ["underlined", { textDecoration: "underline" }],
    ["in another font", { fontFamily: "Times New Roman" }],
    ["in another size", { fontSizePx: 30 }]
  ] as const)("keeps a %s 'Na+' box as text", (_label, style) => {
    const base = insertNativeTextObject(createPhase4Document("Styled box"), { x: 300, y: 300 }, "Na+");
    const id = base.selection.objectIds[0]!;
    const document = updateNativeTextObjectStyle(base, id, style);
    const object = document.pages[0].objects.find(candidate => candidate.id === id)!;
    if (object.type !== "text") throw new Error("Expected text");
    expect(nativeTextObjectElementWithCharge(object, document)).toBeUndefined();
    expect(canAutoConvertNativeTextObjectToAtom(document, id)).toBe(false);
    expect(convertNativeTextObjectToAtom(document, id)).toBe(document);
  });

  it("keeps a bold 'Zn2+' box over an atom as text and leaves the atom alone", () => {
    const base = insertNativeSingleBondMolecule(createPhase4Document("Styled on atom"), { x: 300, y: 300 });
    const molecule = base.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule")!;
    const typed = insertNativeTextObject(base, molecule.atoms[0]!, "Zn2+");
    const id = typed.selection.objectIds[0]!;
    const document = updateNativeTextObjectStyle(typed, id, { fontWeight: 700 });
    expect(canAutoConvertNativeTextObjectToAtom(document, id)).toBe(false);
    expect(convertNativeTextObjectToAtom(document, id, { placementPoint: molecule.atoms[0]! })).toBe(document);
  });

  it("still converts a box whose formatting was set back to the document default", () => {
    const base = insertNativeTextObject(createPhase4Document("Unstyled again"), { x: 300, y: 300 }, "Na+");
    const id = base.selection.objectIds[0]!;
    const bold = updateNativeTextObjectStyle(base, id, { fontWeight: 700 });
    const plain = updateNativeTextObjectStyle(bold, id, { fontWeight: 400 });
    expect(onlyAtom(convertNativeTextObjectToAtom(plain, id)).atom).toMatchObject({ element: "Na", formalCharge: 1 });
  });

  it("judges the default against the document's text style, not the app's", () => {
    const styled = { ...createPhase4Document("Preset text"), styles: { text: { fontFamily: "Times New Roman", fontSizePx: 12 } } } as ChemDraftDocument;
    const document = insertNativeTextObject(styled, { x: 300, y: 300 }, "Na+");
    const id = document.selection.objectIds[0]!;
    const object = document.pages[0].objects.find(candidate => candidate.id === id)!;
    if (object.type !== "text") throw new Error("Expected text");
    expect(object.style.fontFamily).toBe("Times New Roman");
    expect(nativeTextObjectElementWithCharge(object, document)).toEqual({ element: "Na", formalCharge: 1 });
    expect(onlyAtom(convertNativeTextObjectToAtom(document, id)).atom).toMatchObject({ element: "Na", formalCharge: 1 });
    // The same box in a document without that text style is formatted, so it stays text.
    expect(nativeTextObjectElementWithCharge(object, createPhase4Document("App defaults"))).toBeUndefined();
  });

  it("treats a box without stored formatting as default", () => {
    expect(nativeTextObjectElementWithCharge({ text: "Na+", spans: [], style: {} })).toEqual({ element: "Na", formalCharge: 1 });
  });
});
