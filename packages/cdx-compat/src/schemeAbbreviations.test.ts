import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { XMLParser } from "fast-xml-parser";
import { ChemDraftSyntheticStylePreset, createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { schemeSodiumHydroxideAbbreviation } from "@chemdraft/template-library";
import {
  chemicalIdentityMolfile, createSmilesMolecule, layoutReactionScheme, pastedStructureDepictionFromMolfile
} from "@chemdraft/document-workflow-core";
import { generateSmiles2DMolfile, resetRdkitForTesting } from "../../rdkit-adapter/src/conformer";
import { computeStructureIdentifiers } from "../../rdkit-adapter/src/identifiers";
import { installRealRdkitModuleLoader } from "../../rdkit-adapter/src/testing";
import { exportDocumentToCdx, exportDocumentToCdxml, openChemDraftPayload } from "./index";
import { cdxElementFromOrderedTree, readCdx, type CdxElement } from "./cdxBinary";

beforeAll(() => installRealRdkitModuleLoader());
afterAll(() => resetRdkitForTesting());

async function canonical(input: string): Promise<string> {
  const result = await computeStructureIdentifiers(input);
  if (!result?.smiles) throw new Error(`RDKit could not canonicalize ${input}`);
  return result.smiles;
}

describe("scheme abbreviations in visible CDXML", () => {
  it.each(["CDXML", "CDX"] as const)("writes scheme NaOH nickname and expansion in points in %s", format => {
    const document = createEmptyDocument();
    const atom = { id: "naoh", element: "NaOH", schemeAbbreviation: "NaOH" as const,
      x: 160, y: 240, formalCharge: 0 };
    document.pages[0]!.objects.push({ id: "salt", type: "molecule", x: 150, y: 230, width: 60, height: 30,
      rotation: 0, style: {}, structure: "", structureFormat: "unknown", superatoms: [], rGroups: [], bonds: [],
      atoms: [atom] });
    const root = format === "CDX"
      ? readCdx(exportDocumentToCdx(document, { embedNativePayload: false }).bytes)
      : cdxElementFromOrderedTree(new XMLParser({ preserveOrder: true, ignoreAttributes: false,
        attributeNamePrefix: "", trimValues: false }).parse(
        exportDocumentToCdxml(document, { embedNativePayload: false }).contents));
    const descendants = (node: CdxElement): CdxElement[] => [node, ...node.kids.flatMap(descendants)];
    const nickname = descendants(root).find(node => node.name === "n" && node.attrs.NodeType === "Nickname")!;
    expect(nickname).toBeDefined();
    const point = (node: CdxElement) => node.attrs.p.split(/\s+/).map(Number);
    const [x, y] = point(nickname);
    expect(x).toBeCloseTo(atom.x * 0.75, 4);
    expect(y).toBeCloseTo(atom.y * 0.75, 4);
    const body = nickname.kids.find(node => node.name === "fragment")!;
    const nodes = descendants(body).filter(node => node.name === "n");
    const definition = schemeSodiumHydroxideAbbreviation;
    const bondLength = ChemDraftSyntheticStylePreset.drawing.bondLengthPx;
    expect(nodes).toHaveLength(definition.atoms.length);
    for (const [index, part] of definition.atoms.entries()) {
      const [partX, partY] = point(nodes[index]!);
      expect(partX, `${format} ${part.element} x must use the nickname's point units`).toBeCloseTo(x + part.x * bondLength * 0.75, 4);
      expect(partY, `${format} ${part.element} y must use the nickname's point units`).toBeCloseTo(y + part.y * bondLength * 0.75, 4);
    }
    const [naX, naY] = point(nodes[0]!);
    const [oX, oY] = point(nodes[1]!);
    // The definition separates the ions by 1.5 bond lengths (33 px = 24.75 pt).
    expect(Math.hypot(oX - naX, oY - naY)).toBeCloseTo(1.5 * bondLength * 0.75, 4);
  });

  it("round-trips NaOH, water and PhMgBr chemistry without an embedded native payload", async () => {
    const smiles = ["[Na+].[OH-]", "O", "c1ccccc1[Mg]Br"];
    const document = createEmptyDocument();
    const reactants = [];
    for (const [index, input] of smiles.entries()) {
      const molfile = await generateSmiles2DMolfile(input, { standardOnly: true });
      const molecule = createSmilesMolecule(document, { x: 200, y: 200 },
        pastedStructureDepictionFromMolfile(molfile), input);
      if (molecule.type !== "molecule") throw new Error("Expected a molecule");
      reactants.push({ molecule: { ...molecule, id: `species${index}` } });
    }
    const scheme = layoutReactionScheme({ reactants, products: [], arrowKind: "forward",
      anchor: { x: 24, y: 120 }, gutter: 24, bondLength: 22, pagePadding: 24 });
    expect(scheme.molecules[0]!.atoms[0]).toMatchObject({ element: "NaOH", schemeAbbreviation: "NaOH" });
    expect(scheme.molecules[1]!.atoms[0]!.element).toBe("H2O");
    expect(scheme.molecules[2]!.atoms.some(atom => atom.element === "MgBr")).toBe(true);
    const saltAnchor = scheme.molecules[0]!.atoms[0]!;
    const saltCoordinates = schemeSodiumHydroxideAbbreviation.atoms.map(part => ({
      x: saltAnchor.x + part.x * ChemDraftSyntheticStylePreset.drawing.bondLengthPx,
      y: saltAnchor.y + part.y * ChemDraftSyntheticStylePreset.drawing.bondLengthPx
    }));
    const original = JSON.stringify(scheme.document);
    let current = scheme.document;
    for (let cycle = 0; cycle < 2; cycle++) {
      const exported = exportDocumentToCdxml(current, { embedNativePayload: false });
      expect(exported.contents).not.toContain("<objecttag");
      expect(exported.contents).toContain('NodeType="Nickname"');
      expect(exported.warnings.filter(warning => warning.code === "cdxml.scheme_abbreviation_not_expanded")).toEqual([]);
      const opened = openChemDraftPayload(exported.contents);
      expect(opened.source).toBe("external-cdxml");
      if (!opened.document) throw new Error(JSON.stringify(opened.warnings));
      current = opened.document;
      const molecules = current.pages[0]!.objects.filter((object): object is MoleculeObject => object.type === "molecule");
      expect(molecules).toHaveLength(smiles.length);
      for (const [index, molecule] of molecules.entries()) {
        expect(await canonical(chemicalIdentityMolfile(molecule))).toBe(await canonical(smiles[index]!));
      }
      expect(molecules[0]!.atoms.map(atom => [atom.element, atom.formalCharge])).toEqual([["Na", 1], ["O", -1]]);
      expect(molecules[0]!.atoms).toHaveLength(2);
      for (const [index, atom] of molecules[0]!.atoms.entries()) {
        expect(atom.x).toBeCloseTo(saltCoordinates[index]!.x, 3);
        expect(atom.y).toBeCloseTo(saltCoordinates[index]!.y, 3);
      }
    }
    expect(JSON.stringify(scheme.document)).toBe(original);
  });

  it("names a charged scheme abbreviation when it cannot faithfully write the ion pair", () => {
    const document = createEmptyDocument();
    document.pages[0]!.objects.push({ id: "salt", type: "molecule", x: 20, y: 20, width: 60, height: 30,
      rotation: 0, style: {}, structure: "", structureFormat: "unknown", superatoms: [], rGroups: [], bonds: [],
      atoms: [{ id: "naoh", element: "NaOH", schemeAbbreviation: "NaOH", x: 30, y: 30, formalCharge: 1 }] });
    expect(exportDocumentToCdxml(document, { embedNativePayload: false }).warnings).toContainEqual({
      code: "cdxml.scheme_abbreviation_not_expanded", sourceObjectId: "salt", atomIds: ["naoh"],
      message: expect.stringMatching(/atom naoh in molecule salt.*placeholder.*lose its chemistry/)
    });
  });
});
