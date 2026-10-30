import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deserializeDocument, moleculeToMolfileV3000, type MoleculeObject } from "@chemdraft/chem-core";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import { canonicalVisibleCdxml, exportDocumentToCdxml, openChemDraftPayload } from "./index";

const openDocument = () => deserializeDocument(readFileSync(new URL(
  "../../fixtures/open-double-bonds/open.json", import.meta.url
), "utf8"));

describe("CDXML E/Z-unspecified double bonds", () => {
  it.each([undefined, "bold"] as const)("writes the usual display (%s) and warns once per open bond", bondStyle => {
    const document = openDocument();
    const molecule = document.pages[0].objects[0] as MoleculeObject;
    // Use two such bonds to prove warnings are per bond rather than per molecule/document.
    molecule.bonds[0] = { ...molecule.bonds[0], order: "double", stereo: "either" };
    const openBonds = molecule.bonds.filter(bond => bond.stereo === "either");
    expect(openBonds).toHaveLength(2);
    for (const bond of openBonds) bond.display = bondStyle ? { bondStyle } : undefined;
    const exported = exportDocumentToCdxml(document);
    const doubleBondElements = canonicalVisibleCdxml(exported.contents).match(/<b\b[^>]*Order="2"[^>]*\/>/g)!;
    expect(doubleBondElements).toHaveLength(2);
    for (const element of doubleBondElements) {
      expect(element).not.toContain('Display="Wavy"');
      if (bondStyle) expect(element).toContain('Display="Bold"');
      else expect(element).not.toContain("Display=");
    }
    expect(exported.warnings.filter(warning => warning.code === "cdxml.open_double_bond_native_only"))
      .toEqual(openBonds.map(bond => ({
        code: "cdxml.open_double_bond_native_only",
        message: `E/Z-unspecified double bond ${bond.id} is kept for ChemDraft only; other apps will see a plain double bond.`
      })));
  });

  it("round-trips stereo exactly through the native payload", () => {
    const document = openDocument();
    const reopened = openChemDraftPayload(exportDocumentToCdxml(document).contents);
    expect(reopened.source).toBe("native-payload");
    expect(reopened.document).toEqual(document);
    const molecule = reopened.document!.pages[0].objects[0] as MoleculeObject;
    expect(molecule.bonds.filter(bond => bond.stereo === "either")).toHaveLength(1);
  });

  it("imports a plain double bond without the payload, keeping the remaining canonical chemistry", async () => {
    installNodeRdkitModuleLoader();
    const document = openDocument();
    const original = document.pages[0].objects[0] as MoleculeObject;
    const reopened = openChemDraftPayload(canonicalVisibleCdxml(exportDocumentToCdxml(document).contents));
    expect(reopened.source).toBe("external-cdxml");
    const molecule = reopened.document!.pages[0].objects[0] as MoleculeObject;
    const bond = molecule.bonds.find(candidate => candidate.order === "double")!;
    expect(bond).toBeDefined();
    expect(bond).not.toHaveProperty("stereo");
    expect(molecule.bonds.map(candidate => candidate.order)).toEqual(original.bonds.map(candidate => candidate.order));
    expect(molecule.atoms).toHaveLength(original.atoms.length);
    const canonicalSmiles = async (value: MoleculeObject) => (await computeStructureIdentifiers(moleculeToMolfileV3000(value, {
      kekuleBondOrders: new Map(), fromDocFrame: true
    }).contents))?.smiles;
    // Visible coordinates may encode E/Z once the native unspecified intent is absent.
    const { stereo: _stereo, ...plainBond } = original.bonds.find(candidate => candidate.stereo === "either")!;
    const plainOriginal = { ...original, bonds: original.bonds.map(candidate => candidate.id === plainBond.id ? plainBond : candidate) };
    const expected = await canonicalSmiles(plainOriginal);
    expect(expected).toBe("C/C=C/C");
    expect(await canonicalSmiles(molecule)).toBe(expected);
  });

  it("does not infer unspecified stereo from an unconfirmed Wavy double bond display", () => {
    const opened = openChemDraftPayload(`<CDXML><page id="p"><fragment id="m">
      <n id="a" p="0 0"/><n id="b" p="30 0"/>
      <b id="ab" B="a" E="b" Order="2" Display="Wavy"/>
    </fragment></page></CDXML>`);
    const molecule = opened.document!.pages[0].objects[0] as MoleculeObject;
    expect(molecule.bonds[0].order).toBe("double");
    expect(molecule.bonds[0]).not.toHaveProperty("stereo");
    expect(opened.warnings).toContainEqual(expect.objectContaining({ code: "cdxml.bond_display_unsupported" }));
  });
});
