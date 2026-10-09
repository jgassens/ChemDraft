import { describe, expect, it } from "vitest";
import { moleculeToMolfileV3000, type MoleculeObject } from "@chemdraft/chem-core";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import { nativeSingleBondGraphSmiles } from "../../document-workflow-core/src/index";
import { canonicalVisibleCdxml, exportDocumentToCdxml, openChemDraftPayload } from "./index";

describe("CDXML double bond position", () => {
  it.each([["Center", "center"], ["Left", "left"], ["Right", "right"]] as const)(
    "round-trips %s through the visible CDXML layer without changing chemistry", (position, side) => {
      const fixture = `<CDXML><page id="p"><fragment id="m">
        <n id="a" p="0 26"/><n id="b" p="15 0"/><n id="c" p="45 0"/><n id="d" p="60 -26"/>
        <b id="ab" B="a" E="b" Order="1"/>
        <b id="bc" B="b" E="c" Order="2" DoublePosition="${position}"/>
        <b id="cd" B="c" E="d" Order="1"/>
      </fragment></page></CDXML>`;
      const document = openChemDraftPayload(fixture).document!;
      const molecule = document.pages[0].objects[0] as MoleculeObject;
      expect(molecule.bonds.find((bond) => bond.order === "double")?.display?.doubleBondSide).toBe(side);
      const exported = exportDocumentToCdxml(document);
      expect(exported.contents).toContain(`DoublePosition="${position}"`);
      // Strip the native payload so this checks actual CDXML import, not embedded JSON recovery.
      const reopened = openChemDraftPayload(canonicalVisibleCdxml(exported.contents));
      expect(reopened.source).toBe("external-cdxml");
      const restored = reopened.document!.pages[0].objects[0] as MoleculeObject;
      expect(restored.bonds.find((bond) => bond.order === "double")?.display?.doubleBondSide).toBe(side);
      expect(restored.bonds.map((bond) => bond.order)).toEqual(molecule.bonds.map((bond) => bond.order));
      expect(restored.atoms).toHaveLength(molecule.atoms.length);
      expect(nativeSingleBondGraphSmiles(restored.atoms, restored.bonds)).toBe(nativeSingleBondGraphSmiles(molecule.atoms, molecule.bonds));
    }
  );

  it("preserves an explicit Center in a ring instead of assigning an interior side", () => {
    const fixture = `<CDXML><page id="p"><fragment id="m">
      <n id="a" p="0 0"/><n id="b" p="30 0"/><n id="c" p="30 30"/><n id="d" p="0 30"/>
      <b id="ab" B="a" E="b" Order="2" DoublePosition="Center"/>
      <b id="bc" B="b" E="c"/><b id="cd" B="c" E="d"/><b id="da" B="d" E="a"/>
    </fragment></page></CDXML>`;
    const document = openChemDraftPayload(fixture).document!;
    const molecule = document.pages[0].objects[0] as MoleculeObject;
    expect(molecule.bonds[0].display?.doubleBondSide).toBe("center");
    const reopened = openChemDraftPayload(canonicalVisibleCdxml(exportDocumentToCdxml(document).contents));
    expect((reopened.document!.pages[0].objects[0] as MoleculeObject).bonds[0].display?.doubleBondSide).toBe("center");
  });

  it("preserves RDKit canonical SMILES and E/Z when changing only the display position", async () => {
    installNodeRdkitModuleLoader();
    const fixture = `<CDXML><page id="p"><fragment id="m">
      <n id="a" p="0 26"/><n id="b" p="15 0"/><n id="c" p="45 0"/><n id="d" p="60 -26"/>
      <b id="ab" B="a" E="b"/><b id="bc" B="b" E="c" Order="2" DoublePosition="Left"/>
      <b id="cd" B="c" E="d"/>
    </fragment></page></CDXML>`;
    const document = openChemDraftPayload(fixture).document!;
    const molecule = document.pages[0].objects[0] as MoleculeObject;
    const identifiers = (m: MoleculeObject) => computeStructureIdentifiers(moleculeToMolfileV3000(m, {
      kekuleBondOrders: new Map(), fromDocFrame: true
    }).contents);
    const original = await identifiers(molecule);
    expect(original?.smiles).toBe("C/C=C/C");
    molecule.bonds[1].display = { doubleBondSide: "center" };
    expect(await identifiers(molecule)).toEqual(original);
    const reopened = openChemDraftPayload(canonicalVisibleCdxml(exportDocumentToCdxml(document).contents));
    expect(await identifiers(reopened.document!.pages[0].objects[0] as MoleculeObject)).toEqual(original);
  });
});
