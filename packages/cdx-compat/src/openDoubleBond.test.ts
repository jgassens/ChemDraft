import { describe, expect, it } from "vitest";
import { moleculeToMolfileV3000, type MoleculeObject } from "@chemdraft/chem-core";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import { canonicalVisibleCdxml, exportDocumentToCdxml, openChemDraftPayload } from "./index";

// Synthetic but-2-ene or 1-phenylpropene, with coordinates that would otherwise imply E or Z.
const alkeneCdxml = (attributes = "", cis = false, phenyl = false) =>
  `<CDXML><page id="p"><fragment id="m">
    <n id="a" p="0 26"/><n id="b" p="15 0"/>
    <n id="c" p="45 0"/><n id="d" p="60 ${cis ? 26 : -26}"/>
    <b id="ab" B="a" E="b" Order="1"/>
    <b id="bc" B="b" E="c" Order="2" ${attributes}/>
    <b id="cd" B="c" E="d" Order="1"/>
    ${phenyl ? `<n id="e" p="-26 11"/><n id="f" p="-52 26"/>
      <n id="g" p="-52 56"/><n id="h" p="-26 71"/><n id="i" p="0 56"/>
      <b id="ae" B="a" E="e" Order="2"/><b id="ef" B="e" E="f" Order="1"/>
      <b id="fg" B="f" E="g" Order="2"/><b id="gh" B="g" E="h" Order="1"/>
      <b id="hi" B="h" E="i" Order="2"/><b id="ia" B="i" E="a" Order="1"/>` : ""}
  </fragment></page></CDXML>`;

const canonicalSmiles = async (molecule: MoleculeObject) => {
  installNodeRdkitModuleLoader();
  return (await computeStructureIdentifiers(moleculeToMolfileV3000(molecule, {
    kekuleBondOrders: new Map(), fromDocFrame: true
  }).contents))?.smiles;
};

// Set native stereo independently of the reader so writer regressions fail in isolation.
const openDocument = (phenyl = false) => {
  const document = openChemDraftPayload(alkeneCdxml("", false, phenyl)).document!;
  (document.pages[0].objects[0] as MoleculeObject).bonds[1].stereo = "either";
  return document;
};

describe("CDXML E/Z-unspecified double bonds", () => {
  it.each([undefined, "bold"] as const)("writes Display=Wavy for native either (style: %s)", bondStyle => {
    const document = openDocument();
    const molecule = document.pages[0].objects[0] as MoleculeObject;
    const bond = molecule.bonds[1];
    bond.display = bondStyle ? { bondStyle } : undefined;
    const exported = exportDocumentToCdxml(document);
    const element = canonicalVisibleCdxml(exported.contents).match(/<b\b[^>]*Order="2"[^>]*\/>/)![0];
    expect(element).toContain('Display="Wavy"');
    expect(element.match(/\bDisplay=/g)).toHaveLength(1);
    expect(exported.warnings.map(warning => warning.code)).not.toContain("cdxml.open_double_bond_native_only");
    if (bondStyle) {
      expect(exported.warnings).toContainEqual(expect.objectContaining({
        code: "cdxml.open_double_bond_style_native_only",
        sourceObjectId: molecule.id,
        bondIds: [bond.id],
        message: expect.stringContaining(bondStyle)
      }));
    } else {
      expect(exported.warnings).toEqual([]);
    }
  });

  it("round-trips stereo exactly through the native payload", () => {
    const document = openDocument();
    const reopened = openChemDraftPayload(exportDocumentToCdxml(document).contents);
    expect(reopened.source).toBe("native-payload");
    expect(reopened.document).toEqual(document);
    const molecule = reopened.document!.pages[0].objects[0] as MoleculeObject;
    expect(molecule.bonds.filter(bond => bond.stereo === "either")).toHaveLength(1);
  });

  it.each([false, true])("round-trips either through visible CDXML (phenyl: %s)", async phenyl => {
    const document = openDocument(phenyl);
    const original = document.pages[0].objects[0] as MoleculeObject;
    // Strip the payload to prove that ordinary CDXML carries the unspecified intent.
    const reopened = openChemDraftPayload(canonicalVisibleCdxml(exportDocumentToCdxml(document).contents));
    expect(reopened.source).toBe("external-cdxml");
    const molecule = reopened.document!.pages[0].objects[0] as MoleculeObject;
    expect(molecule.bonds[1].stereo).toBe("either");
    expect(molecule.atoms).toEqual(original.atoms);
    expect(molecule.bonds.map(bond => [bond.fromAtomId, bond.toAtomId, bond.order, bond.stereo]))
      .toEqual(original.bonds.map(bond => [bond.fromAtomId, bond.toAtomId, bond.order, bond.stereo]));
    expect(await canonicalSmiles(molecule)).toBe(phenyl ? "CC=Cc1ccccc1" : "CC=CC");
    expect(await canonicalSmiles(molecule)).toBe(await canonicalSmiles(original));
  });

  for (const cis of [false, true]) {
    it.each(["Center", "Left", "Right"])(
      `imports Wavy as either regardless of DoublePosition=%s and ${cis ? "cis" : "trans"} coordinates`, async position => {
        const opened = openChemDraftPayload(alkeneCdxml(`Display="Wavy" DoublePosition="${position}"`, cis));
        const molecule = opened.document!.pages[0].objects[0] as MoleculeObject;
        expect(molecule.bonds[1]).toMatchObject({ order: "double", stereo: "either" });
        expect(await canonicalSmiles(molecule)).toBe("CC=CC");
        expect(opened.warnings.map(warning => warning.code)).not.toContain("cdxml.bond_display_unsupported");
      }
    );
  }

  it.each([false, true])("keeps a normal drawn double bond's E/Z (cis: %s)", async cis => {
    const opened = openChemDraftPayload(alkeneCdxml("", cis));
    const molecule = opened.document!.pages[0].objects[0] as MoleculeObject;
    expect(molecule.bonds[1]).not.toHaveProperty("stereo");
    expect(await canonicalSmiles(molecule)).toBe(cis ? "C/C=C\\C" : "C/C=C/C");
    const reopened = openChemDraftPayload(canonicalVisibleCdxml(exportDocumentToCdxml(opened.document!).contents));
    expect(await canonicalSmiles(reopened.document!.pages[0].objects[0] as MoleculeObject))
      .toBe(cis ? "C/C=C\\C" : "C/C=C/C");
  });

  it("imports a crossed ring-substituted alkene without inventing E/Z", async () => {
    const molecule = openChemDraftPayload(alkeneCdxml('Display="Wavy"', false, true))
      .document!.pages[0].objects[0] as MoleculeObject;
    expect(molecule.bonds[1].stereo).toBe("either");
    expect(molecule.bonds.filter(bond => bond.stereo === "either")).toHaveLength(1);
    expect(molecule.atoms).toHaveLength(9);
    expect(molecule.bonds).toHaveLength(9);
    expect(await canonicalSmiles(molecule)).toBe("CC=Cc1ccccc1");
  });

  it.each([['Display2', 'Wavy'], ['BS', 'U'], ['BS', 'Unspecified']])(
    "warns by name for an unmapped %s=%s variant", (attribute, value) => {
      const opened = openChemDraftPayload(alkeneCdxml(`${attribute}="${value}"`));
      expect(opened.warnings).toContainEqual(expect.objectContaining({
        code: "cdxml.bond_stereo_attribute_unsupported",
        bondIds: ["bond_002"],
        message: expect.stringContaining(`${attribute}="${value}"`)
      }));
    }
  );

  it("still warns by name for Wavy on a single bond", () => {
    const opened = openChemDraftPayload(`<CDXML><page id="p"><fragment id="m">
      <n id="a" p="0 0"/><n id="b" p="30 0"/>
      <b id="ab" B="a" E="b" Order="1" Display="Wavy"/>
    </fragment></page></CDXML>`);
    const molecule = opened.document!.pages[0].objects[0] as MoleculeObject;
    expect(molecule.bonds[0]).not.toHaveProperty("stereo");
    expect(opened.warnings).toContainEqual(expect.objectContaining({
      code: "cdxml.bond_display_unsupported", message: expect.stringContaining('"Wavy"')
    }));
  });
});
