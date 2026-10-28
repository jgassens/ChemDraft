import { beforeAll, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { smilesListCandidates } from "@chemdraft/clipboard-adapter";
import {
  assertMoleculeMatchesSmiles, pastedStructureDepictionFromMolfile, type InspectChemicalIdentity
} from "@chemdraft/document-workflow-core";
import { generateSmiles2DMolfile } from "../../../packages/rdkit-adapter/src/conformer";
import { computeStructureIdentifiers } from "../../../packages/rdkit-adapter/src/identifiers";
import { installRealRdkitModuleLoader } from "../../../packages/rdkit-adapter/src/testing";
import {
  isotopeInsertSmiles, expectIsotopeGraph
} from "../../../packages/document-workflow-core/test/isotopeInsertFixtures";
import { checkedSmilesPaste, checkedSmilesGridPaste } from "./smilesPasteIdentity";
import { depictSmilesListForPaste } from "./smilesListPaste";
import { structureFromSmilesForPlugin } from "./plugins/pluginChemistry";
import { depictSmilesOffThread } from "./depiction2d/client";

vi.mock("./depiction2d/client", () => ({ depictSmilesOffThread: vi.fn() }));
const point = { x: 200, y: 200 };
const inspect: InspectChemicalIdentity = async (_format, value) => {
  const result = await computeStructureIdentifiers(value);
  return result?.smiles
    ? { valid: true, canonicalSmiles: result.smiles } : { valid: false, reason: "invalid" };
};
beforeAll(() => {
  installRealRdkitModuleLoader();
  vi.mocked(depictSmilesOffThread).mockImplementation(async smiles => ({
    depiction: pastedStructureDepictionFromMolfile(await generateSmiles2DMolfile(smiles)), stereoCount: 0
  }));
});

async function verify(molecule: MoleculeObject, smiles: string) {
  await assertMoleculeMatchesSmiles(molecule, smiles, inspect);
  expectIsotopeGraph(molecule, await generateSmiles2DMolfile(smiles));
}

describe("isotope insert paths", () => {
  it.each(isotopeInsertSmiles)("preserves single paste and plugin structure %s", async smiles => {
    const source = await generateSmiles2DMolfile(smiles);
    const document = createEmptyDocument();
    const pasted = await checkedSmilesPaste(document, point, pastedStructureDepictionFromMolfile(source),
      smiles, inspect);
    await verify(pasted.pages[0]!.objects[0] as MoleculeObject, smiles);
    const plugin = await structureFromSmilesForPlugin({ smiles }, () => document);
    expect(plugin.available && plugin.built, JSON.stringify(plugin)).toBe(true);
    if (!plugin.available || !plugin.built || plugin.object.type !== "molecule") throw new Error("not built");
    await verify(plugin.object, smiles);
  });

  it("preserves every isotope and position in a list paste", async () => {
    const text = isotopeInsertSmiles.join("\n");
    const parsed = await depictSmilesListForPaste(text, smilesListCandidates(text));
    expect(parsed?.entries).toHaveLength(isotopeInsertSmiles.length);
    const result = await checkedSmilesGridPaste(createEmptyDocument(), point, parsed!.entries, inspect);
    expect(result.failures).toEqual([]);
    for (const [index, molecule] of result.document.pages[0]!.objects.entries()) {
      await verify(molecule as MoleculeObject, isotopeInsertSmiles[index]!);
    }
  });

  it("refuses an isotope moved to the other product carbon, even with the same atom counts", async () => {
    const input = "[2H]C1C(c2ccccc2)ON=C1c1ccccc1";
    const moved = "[2H]C1(CC(=NO1)c1ccccc1)c1ccccc1";
    const depiction = pastedStructureDepictionFromMolfile(await generateSmiles2DMolfile(moved));
    const document = createEmptyDocument();
    await expect(checkedSmilesPaste(document, point, depiction, input, inspect))
      .rejects.toThrow("isotope labels or their positions");
    const result = await checkedSmilesGridPaste(document, point, [{ smiles: input, depiction }], inspect);
    expect(result.document).toBe(document);
    expect(result.objectIds).toEqual([]);
    expect(result.failures).toHaveLength(1);
  });

  it.each(["[2H]C1C(c2ccccc2)ON=C1c1ccccc1", "[13CH3]c1ccccc1"])(
    "refuses a lossy single paste and skips only the lossy list entry: %s", async smiles => {
      const document = createEmptyDocument();
      const before = structuredClone(document);
      const stripped = pastedStructureDepictionFromMolfile(await generateSmiles2DMolfile(
        smiles.replace(/\[2H\]/g, "").replace("[13CH3]", "C")));
      await expect(checkedSmilesPaste(document, point, stripped, smiles, inspect))
        .rejects.toThrow("SMILES paste refused: the drawn structure would lose isotope labels");
      expect(document).toEqual(before);
      const valid = "CC(=[18O])C";
      const result = await checkedSmilesGridPaste(document, point, [
        { smiles, depiction: stripped },
        { smiles: valid,
          depiction: pastedStructureDepictionFromMolfile(await generateSmiles2DMolfile(valid)) }
      ], inspect);
      expect(result.failures).toEqual([
        { input: smiles, error: expect.stringContaining("SMILES paste refused") }
      ]);
      expect(result.objectIds).toHaveLength(1);
      await verify(result.document.pages[0]!.objects[0] as MoleculeObject, valid);
    });
});
