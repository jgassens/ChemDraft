import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deserializeDocument, moleculeToMolfileV3000, type MoleculeObject } from "@chemdraft/chem-core";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import { canonicalVisibleCdxml, exportDocumentToCdxml, openChemDraftPayload } from "./index";

const openDocument = () => deserializeDocument(readFileSync(new URL(
  "../../fixtures/open-double-bonds/open.json", import.meta.url
), "utf8"));

// Synthetic fixtures: atom order intentionally differs from the default bond direction.
const singleBondCdxml = (display: string, order: string | undefined, reverse = true) =>
  `<CDXML><page id="p"><fragment id="m">
    <n id="a" p="0 0" Element="9"/><n id="b" p="30 0"/>
    <b id="ab" B="${reverse ? "b" : "a"}" E="${reverse ? "a" : "b"}"
      ${order === undefined ? "" : `Order="${order}"`} ${display ? `Display="${display}"` : ""}/>
  </fragment></page></CDXML>`;

describe("CDXML wavy single bonds", () => {
  it.each([
    ["1", false], ["1", true], [undefined, false], [undefined, true]
  ] as const)("imports Order=%s with Begin at the native from atom (reverse=%s)", (order, reverse) => {
    const opened = openChemDraftPayload(singleBondCdxml("Wavy", order, reverse));
    const molecule = opened.document!.pages[0].objects[0] as MoleculeObject;
    expect(molecule.bonds[0]).toMatchObject({
      order: "single", fromAtomId: reverse ? "atom_002" : "atom_001",
      toAtomId: reverse ? "atom_001" : "atom_002", display: { bondStyle: "wavy" }
    });
    expect(opened.warnings.map(warning => warning.code)).not.toContain("cdxml.bond_display_unsupported");
  });

  it.each([false, true])("exports Display=Wavy with B=fromAtomId (reverse=%s)", reverse => {
    const document = openChemDraftPayload(singleBondCdxml("", "1", reverse)).document!;
    const molecule = document.pages[0].objects[0] as MoleculeObject;
    molecule.bonds[0].display = { bondStyle: "wavy" };
    const exported = exportDocumentToCdxml(document);
    const visible = canonicalVisibleCdxml(exported.contents);
    const atomIds = [...visible.matchAll(/<n\b[^>]*\bid="([^"]+)"/g)].map(match => match[1]);
    expect(atomIds).toHaveLength(2);
    const bond = visible.match(/<b\b[^>]*\/>/)![0];
    expect(bond).toContain('Order="1"');
    expect(bond).toContain('Display="Wavy"');
    expect(bond).toContain(`B="${atomIds[reverse ? 1 : 0]}"`);
    expect(bond).toContain(`E="${atomIds[reverse ? 0 : 1]}"`);
    expect(exported.warnings).toEqual([]);
    expect(openChemDraftPayload(exported.contents).document).toEqual(document);
  });

  it("round-trips the visible atom and directed bond graph without the native payload", () => {
    const document = openChemDraftPayload(singleBondCdxml("Wavy", "1")).document!;
    const original = document.pages[0].objects[0] as MoleculeObject;
    const visible = canonicalVisibleCdxml(exportDocumentToCdxml(document).contents);
    const reopened = openChemDraftPayload(visible);
    expect(reopened.source).toBe("external-cdxml");
    const molecule = reopened.document!.pages[0].objects[0] as MoleculeObject;
    expect(molecule.bonds[0].display?.bondStyle).toBe("wavy");
    expect(molecule.bonds).toEqual(original.bonds);
    expect(molecule.atoms).toEqual(original.atoms);
    expect(canonicalVisibleCdxml(exportDocumentToCdxml(reopened.document!).contents)).toBe(visible);
  });

  it.each(["", 'Display="WedgedHashBegin"'])("leaves a wavy stereocentre unspecified with neighbouring %s", async neighborDisplay => {
    installNodeRdkitModuleLoader();
    const source = `<CDXML><page id="p"><fragment id="m">
      <n id="c" p="50 50"/><n id="f" p="20 50" Element="9"/>
      <n id="cl" p="50 20" Element="17"/><n id="br" p="80 50" Element="35"/>
      <n id="i" p="50 80" Element="53"/>
      <b id="cf" B="c" E="f" Order="1" Display="Wavy"/>
      <b id="ccl" B="c" E="cl" Order="1" ${neighborDisplay}/>
      <b id="cbr" B="c" E="br" Order="1"/><b id="ci" B="c" E="i" Order="1"/>
    </fragment></page></CDXML>`;
    const canonicalSmiles = async (cdxml: string) => {
      const molecule = openChemDraftPayload(cdxml).document!.pages[0].objects[0] as MoleculeObject;
      return (await computeStructureIdentifiers(moleculeToMolfileV3000(molecule, {
        kekuleBondOrders: new Map(), fromDocFrame: true
      }).contents))?.smiles;
    };
    const document = openChemDraftPayload(source).document!;
    const molecule = document.pages[0].objects[0] as MoleculeObject;
    expect(molecule.bonds[0].display?.bondStyle).toBe("wavy");
    expect(await canonicalSmiles(source)).toBe("FC(Cl)(Br)I");
    const visible = canonicalVisibleCdxml(exportDocumentToCdxml(document).contents);
    expect(await canonicalSmiles(visible)).toBe("FC(Cl)(Br)I");
    if (!neighborDisplay) {
      // Positive control: the same geometry can represent an assigned stereocentre.
      expect(await canonicalSmiles(source.replace('Display="Wavy"', 'Display="WedgeBegin"'))).toContain("@");
    }
  });

  it.each([
    ["", undefined, false], ["WedgeBegin", "wedge", false], ["WedgeEnd", "wedge", true],
    ["WedgedHashBegin", "hashed", false], ["WedgedHashEnd", "hashed", true], ["Hash", "hashed", false]
  ] as const)("preserves the existing %s single-bond style and direction", (display, bondStyle, swap) => {
    const document = openChemDraftPayload(singleBondCdxml(display, "1")).document!;
    const molecule = document.pages[0].objects[0] as MoleculeObject;
    expect(molecule.bonds[0]).toMatchObject({
      order: "single", fromAtomId: swap ? "atom_001" : "atom_002",
      toAtomId: swap ? "atom_002" : "atom_001"
    });
    expect(molecule.bonds[0].display?.bondStyle).toBe(bondStyle);
    const visible = canonicalVisibleCdxml(exportDocumentToCdxml(document).contents);
    const reopened = openChemDraftPayload(visible).document!.pages[0].objects[0] as MoleculeObject;
    expect(reopened.bonds).toEqual(molecule.bonds);
  });
});

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
    expect(molecule.bonds[0].display?.bondStyle).toBeUndefined();
    expect(opened.warnings).toContainEqual(expect.objectContaining({ code: "cdxml.bond_display_unsupported" }));
  });
});
