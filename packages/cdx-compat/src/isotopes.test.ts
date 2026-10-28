import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyPatch, createEmptyDocument, moleculeToMolfileV2000, type MoleculeObject
} from "@chemdraft/chem-core";
import { nativeBondOrderResolution, planMoleculeAtomLabels } from "@chemdraft/layout-engine";
import {
  createSmilesMolecule, pastedStructureDepictionFromMolfile
} from "../../document-workflow-core/src/molecule";
import { isotopeFixtures } from "../../document-workflow-core/src/isotopes.fixtures";
import { generateSmiles2DMolfile, resetRdkitForTesting } from "../../rdkit-adapter/src/conformer";
import { computeStructureIdentifiers } from "../../rdkit-adapter/src/identifiers";
import { installRealRdkitModuleLoader } from "../../rdkit-adapter/src/testing";
import { exportDocumentToCdxml, openChemDraftPayload } from "./index";

beforeAll(() => installRealRdkitModuleLoader());
afterAll(() => resetRdkitForTesting());

async function canonical(input: string): Promise<string> {
  const result = await computeStructureIdentifiers(input);
  if (!result?.smiles) throw new Error(`RDKit could not canonicalize ${input}`);
  return result.smiles;
}

function importedMolecule(contents: string): MoleculeObject {
  const opened = openChemDraftPayload(contents);
  const molecule = opened.document?.pages[0]?.objects[0];
  if (molecule?.type !== "molecule") throw new Error(JSON.stringify(opened.warnings));
  return molecule;
}

describe("CDXML isotope compatibility", () => {
  it.each([
    ["[13CH3]C", "13CH3"], ["[13CH3-]", "13CH3-"], ["[15NH4+]", "15NH4+"],
    ["C[18O-]", "18O-"], ["[2H][O+]([3H])C", "O+"]
  ])("writes canvas label text, hydrogen counts and charges for %s", async (smiles, expectedLabel) => {
    const document = createEmptyDocument();
    const molfile = await generateSmiles2DMolfile(smiles, { standardOnly: true });
    const molecule = createSmilesMolecule(document, { x: 200, y: 200 },
      pastedStructureDepictionFromMolfile(molfile), smiles);
    const exported = exportDocumentToCdxml(applyPatch(document, {
      op: "addObject", pageId: document.pages[0]!.id, object: molecule
    }));
    const canvasLabels = planMoleculeAtomLabels(molecule);
    expect(canvasLabels.map((plan) => plan.label)).toContain(expectedLabel);
    const visibleLabels = [...exported.contents.matchAll(/<n\b[^>]*Isotope="\d+"[^>]*><t>(.*?)<\/t>/g)]
      .map((match) => match[1]!.replace(/<[^>]*>/g, ""));
    expect(visibleLabels).toEqual(canvasLabels
      .filter(({ atom }) => atom.isotope !== undefined || atom.element === "D" || atom.element === "T")
      .map(({ label }) => label));
    if (expectedLabel.includes("H3")) expect(exported.contents).toContain('<s face="64">3</s>');
    if (expectedLabel.endsWith("-")) expect(exported.contents).toContain('<s face="32">-</s>');
    const plain = exported.contents.replace(/<objecttag\b[^>]*\/>/g, "");
    for (const contents of [exported.contents, plain]) {
      const restored = importedMolecule(contents);
      const output = moleculeToMolfileV2000(restored, {
        fromDocFrame: true,
        kekuleBondOrders: nativeBondOrderResolution(restored.atoms, restored.bonds).kekuleOrders
      }).contents;
      expect(await canonical(output)).toBe(await canonical(smiles));
    }
  });

  it.each(isotopeFixtures)("preserves $smiles with and without the native payload", async ({ smiles }) => {
    const document = createEmptyDocument();
    const molfile = await generateSmiles2DMolfile(smiles, { standardOnly: true });
    const molecule = createSmilesMolecule(document, { x: 200, y: 200 },
      pastedStructureDepictionFromMolfile(molfile), smiles);
    if (molecule.type !== "molecule") throw new Error("Expected a molecule");
    const exported = exportDocumentToCdxml(applyPatch(document, {
      op: "addObject", pageId: document.pages[0]!.id, object: molecule
    }));
    expect(exported.contents).not.toMatch(/Element="[DT]"/);
    const expected = await canonical(smiles);
    const plain = exported.contents.replace(/<objecttag\b[^>]*\/>/g, "");
    expect(openChemDraftPayload(plain).source).toBe("external-cdxml");
    for (const contents of [exported.contents, plain]) {
      const restored = importedMolecule(contents);
      expect(restored.atoms).toHaveLength(molecule.atoms.length);
      expect(restored.bonds).toHaveLength(molecule.bonds.length);
      expect(restored.atoms.map(({ element, isotope }) => ({ element, isotope })))
        .toEqual(molecule.atoms.map(({ element, isotope }) => ({ element, isotope })));
      const output = moleculeToMolfileV2000(restored, {
        fromDocFrame: true,
        kekuleBondOrders: nativeBondOrderResolution(restored.atoms, restored.bonds).kekuleOrders
      }).contents;
      expect(await canonical(output)).toBe(expected);
    }
  });

  it.each([
    ['Element="1" Isotope="2"', "D", undefined],
    ['Element="1" Isotope="3"', "T", undefined],
    ['Element="D"', "D", undefined],
    ['Element="T"', "T", undefined],
    ['Element="1" Isotope="1"', "H", 1],
    ['Element="6" Isotope="13"', "C", 13]
  ] as const)("imports %s", (attributes, element, isotope) => {
    const molecule = importedMolecule(
      `<CDXML><page><fragment><n id="1" p="0 0" ${attributes}/></fragment></page></CDXML>`
    );
    expect(molecule.atoms[0]).toMatchObject({ element });
    expect(molecule.atoms[0]!.isotope).toBe(isotope);
  });

  it.each(["0", "-2", "2.5", "1000", "invalid"])("refuses invalid isotope %s", (isotope) => {
    const opened = openChemDraftPayload('<CDXML><page><fragment>' +
      `<n id="1" Element="6" Isotope="${isotope}" p="0 0"/></fragment></page></CDXML>`);
    expect(opened.document).toBeUndefined();
    expect(opened.warnings).toEqual([
      expect.objectContaining({ message: expect.stringContaining("Invalid isotope mass number") })
    ]);
  });

  it("writes standard isotope attributes and visible labels without isotope-only warnings", () => {
    const document = createEmptyDocument();
    const molecule = importedMolecule('<CDXML><page><fragment>' +
      '<n id="1" Element="D" p="0 0"/><n id="2" Element="T" p="20 0"/>' +
      '<n id="3" Isotope="13" p="40 0"/></fragment></page></CDXML>');
    molecule.chemistry = { isotopeLabels: ["2H", "3H", "13C"], stereochemistry: [], warnings: [] };
    const exported = exportDocumentToCdxml(applyPatch(document, {
      op: "addObject", pageId: document.pages[0]!.id, object: molecule
    }));
    expect(exported.contents).toMatch(/Element="1" Isotope="2"[^>]*><t><s>D<\/s>/);
    expect(exported.contents).toMatch(/Element="1" Isotope="3"[^>]*><t><s>T<\/s>/);
    expect(exported.contents).toContain('<s face="32">13</s><s>CH</s><s face="64">4</s>');
    const codes = exported.warnings.map(({ code }) => code);
    expect(codes).not.toContain("cdxml.atom_element_symbol_exported");
    expect(codes).not.toContain("cdxml.molecule_metadata_payload_only");
  });
});
