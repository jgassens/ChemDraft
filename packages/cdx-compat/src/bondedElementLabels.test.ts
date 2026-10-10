import { describe, expect, it } from "vitest";
import { applyPatches, createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";

import { nativeSingleBondGraphMetadata } from "../../document-workflow-core/src/index";
import { exportDocumentToCdxml, openChemDraftPayload } from "./index";

// A bonded "Ar" is aryl and a bonded "Ts" tosyl — never argon or tennessine. The formula and every
// other export already say so; the CDXML visible layer must too, or any CDXML reader gets element 18.

function documentWith(atoms: MoleculeObject["atoms"], bonds: MoleculeObject["bonds"]) {
  const base = createEmptyDocument({ title: "Bonded element labels" });
  const molecule: MoleculeObject = {
    id: "mol_1", type: "molecule", x: 0, y: 0, width: 100, height: 40, rotation: 0, style: {},
    structureFormat: "smiles", structure: "", atoms, bonds, superatoms: [], rGroups: []
  };
  return applyPatches(base, [{ op: "addObject", pageId: base.pages[0]!.id, object: molecule }]);
}

/** How many atom nodes carry each Element attribute value. */
const elementCounts = (contents: string) => {
  const counts = new Map<string, number>();
  for (const match of contents.matchAll(/<n [^>]*?Element="([^"]*)"[^>]*\/>/g)) {
    counts.set(match[1]!, (counts.get(match[1]!) ?? 0) + 1);
  }
  return counts;
};

describe("CDXML export of element symbols that mean a group on a bond", () => {
  // Typed labels (`labelLiteral`): only those carry the bonded meaning.
  const document = documentWith(
    [
      { id: "ar", element: "Ar", x: 0, y: 0, formalCharge: 0, labelLiteral: true },
      { id: "o1", element: "O", x: 30, y: 0, formalCharge: 0 },
      { id: "ts", element: "Ts", x: 60, y: 0, formalCharge: 0, labelLiteral: true },
      { id: "c1", element: "C", x: 90, y: 0, formalCharge: 0 },
      { id: "lone", element: "Ar", x: 150, y: 0, formalCharge: 0 }
    ],
    [
      { id: "b1", fromAtomId: "ar", toAtomId: "o1", order: "single" },
      { id: "b2", fromAtomId: "ts", toAtomId: "c1", order: "single" }
    ]
  );

  it("writes a bonded Ar or Ts as its label with a warning, never an atomic number", () => {
    const exported = exportDocumentToCdxml(document);
    const counts = elementCounts(exported.contents);
    expect(counts.get("Ar")).toBe(1);
    expect(counts.get("Ts")).toBe(1);
    expect(counts.get("117")).toBeUndefined();
    // Only the unbonded Ar is argon.
    expect(counts.get("18")).toBe(1);
    expect(exported.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "cdxml.bonded_element_label_exported",
        message: "Atom \"Ar\" on a bond is aryl, not the element Ar; it was exported as the label \"Ar\" rather than an atomic number."
      }),
      expect.objectContaining({ code: "cdxml.bonded_element_label_exported", message: expect.stringContaining("tosyl") })
    ]));
  });

  it("still writes an unbonded Ar as argon", () => {
    const lone = documentWith([{ id: "lone", element: "Ar", x: 0, y: 0, formalCharge: 0, labelLiteral: true }], []);
    const exported = exportDocumentToCdxml(lone);
    expect(elementCounts(exported.contents).get("18")).toBe(1);
    expect(exported.warnings.some((warning) => warning.code === "cdxml.bonded_element_label_exported")).toBe(false);
  });

  it("writes a bonded element from a structure (no typed label) by its atomic number", () => {
    const fromFile = documentWith(
      [{ id: "ac", element: "Ac", x: 0, y: 0, formalCharge: 0 }, { id: "cl", element: "Cl", x: 30, y: 0, formalCharge: 0 }],
      [{ id: "b1", fromAtomId: "ac", toAtomId: "cl", order: "single" }]
    );
    const exported = exportDocumentToCdxml(fromFile);
    expect(elementCounts(exported.contents).get("89")).toBe(1);
    expect(exported.warnings.some((warning) => warning.code === "cdxml.bonded_element_label_exported")).toBe(false);
  });

  it("reads the typed labels back from the visible layer alone, still typed", () => {
    const visibleOnly = exportDocumentToCdxml(document).contents.replace(/<objecttag Name="org\.chemdraft\/[^>]*\/>/g, "");
    const reopened = openChemDraftPayload(visibleOnly);
    expect(reopened.source).toBe("external-cdxml");
    const atoms = reopened.document!.pages[0]!.objects
      .filter((object): object is MoleculeObject => object.type === "molecule")
      .flatMap((molecule) => molecule.atoms);
    expect(atoms.map((atom) => atom.element)).toEqual(expect.arrayContaining(["Ar", "O", "Ts", "C"]));
    for (const label of ["Ar", "Ts"]) {
      expect(atoms.find((atom) => atom.element === label && atom.labelLiteral === true), label).toBeDefined();
    }
  });
});

describe("CDXML import keeps a numeric element an element, and a text label a label", () => {
  const moleculeOf = (contents: string) =>
    openChemDraftPayload(contents).document!.pages[0]!.objects.find((object): object is MoleculeObject => object.type === "molecule")!;

  it("reads Element=\"89\" bonded to Cl as actinium, never acetyl chloride", () => {
    const molecule = moleculeOf(`<CDXML><page id="1"><fragment id="2">
      <n id="a" p="0 0" Element="89"/><n id="b" p="30 0" Element="17"/><b id="c" B="a" E="b"/>
    </fragment></page></CDXML>`);
    const actinium = molecule.atoms.find((atom) => atom.element === "Ac")!;
    expect(actinium.labelLiteral).toBeUndefined();
    expect(nativeSingleBondGraphMetadata(molecule.atoms, molecule.bonds).formula).toBe("AcCl");
  });

  it("reads Element=\"18\" bonded to O as argon, and a text Element=\"Ar\" as the aryl label", () => {
    const argon = moleculeOf(`<CDXML><page id="1"><fragment id="2">
      <n id="a" p="0 0" Element="18"/><n id="b" p="30 0" Element="8"/><b id="c" B="a" E="b"/>
    </fragment></page></CDXML>`);
    expect(nativeSingleBondGraphMetadata(argon.atoms, argon.bonds).formula).toBe("ArHO");
    const aryl = moleculeOf(`<CDXML><page id="1"><fragment id="2">
      <n id="a" p="0 0" Element="Ar"/><n id="b" p="30 0" Element="8"/><b id="c" B="a" E="b"/>
    </fragment></page></CDXML>`);
    expect(aryl.atoms.find((atom) => atom.element === "Ar")?.labelLiteral).toBe(true);
    expect(nativeSingleBondGraphMetadata(aryl.atoms, aryl.bonds).formula).toBe("HO");
  });

  it("round-trips a structure's actinium through CDXML as actinium", () => {
    const fromFile = documentWith(
      [{ id: "ac", element: "Ac", x: 0, y: 0, formalCharge: 0 }, { id: "cl", element: "Cl", x: 30, y: 0, formalCharge: 0 }],
      [{ id: "b1", fromAtomId: "ac", toAtomId: "cl", order: "single" }]
    );
    const visibleOnly = exportDocumentToCdxml(fromFile).contents.replace(/<objecttag Name="org\.chemdraft\/[^>]*\/>/g, "");
    const molecule = moleculeOf(visibleOnly);
    expect(molecule.atoms.find((atom) => atom.element === "Ac")?.labelLiteral).toBeUndefined();
    expect(nativeSingleBondGraphMetadata(molecule.atoms, molecule.bonds).formula).toBe("AcCl");
  });
});
