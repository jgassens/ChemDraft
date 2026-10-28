import { beforeAll, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { smilesListCandidates } from "@chemdraft/clipboard-adapter";
import {
  assertMoleculeMatchesSmiles, createSmilesMolecule, pastedStructureDepictionFromMolfile,
  type InspectChemicalIdentity
} from "@chemdraft/document-workflow-core";
import { ensureRdkit, generateSmiles2DMolfile } from "../../../packages/rdkit-adapter/src/conformer";
import { computeStructureIdentifiers } from "../../../packages/rdkit-adapter/src/identifiers";
import { installRealRdkitModuleLoader } from "../../../packages/rdkit-adapter/src/testing";
import {
  isotopeInsertSmiles, expectIsotopeGraph
} from "../../../packages/document-workflow-core/test/isotopeInsertFixtures";
import { checkedSmilesPaste, checkedSmilesGridPaste } from "./smilesPasteIdentity";
import { depictSmilesForPaste, depictSmilesListForPaste } from "./smilesListPaste";
import { structureFromSmilesForPlugin } from "./plugins/pluginChemistry";
import { applyAssistantWrite, buildInsertStructures } from "./assistant/writeBuilder";
import { testContext } from "./assistant/tools/testContext";

vi.mock("./plugins/rdkitAppLoader", () => ({
  loadRdkitWithAppLoader: async () => ({ ensureRdkit })
}));
const point = { x: 200, y: 200 };
const inspect: InspectChemicalIdentity = async (_format, value) => {
  const result = await computeStructureIdentifiers(value);
  return result?.smiles
    ? { valid: true, canonicalSmiles: result.smiles } : { valid: false, reason: "invalid" };
};
beforeAll(() => installRealRdkitModuleLoader());

async function verify(molecule: MoleculeObject, smiles: string) {
  await assertMoleculeMatchesSmiles(molecule, smiles, inspect);
  expectIsotopeGraph(molecule, await generateSmiles2DMolfile(smiles));
}

describe("isotope insert paths", () => {
  it.each([
    "[H]C([H])([H])O", "C[C@@H](O)CC", "[H]/C(C)=C(/[H])C", "[Na+].[O-]C(=O)c1ccccc1",
    "c1cc[nH]c1", "C[N+](C)(C)C", "[2H]C([2H])([2H])O", "N[C@@H](C)C(=O)O", "F/C=C/F",
    "C1=CC=CC=C1"
  ])("accepts real paste depiction without changing identity: %s", async smiles => {
    const parsed = await depictSmilesForPaste(smiles);
    expect(parsed).toBeDefined();
    const pasted = await checkedSmilesPaste(createEmptyDocument(), point, parsed!.depiction, smiles);
    await verify(pasted.pages[0]!.objects[0] as MoleculeObject, smiles);
  });

  it.each(["[H]C([H])([H])O", "[H]/C(C)=C(/[H])C"])(
    "normalizes the assistant's explicit-H inspection as well: %s", async smiles => {
      const { context } = testContext(false);
      context.chemistry.inspectStructure = async (_format, value) => {
        const molecule = (await ensureRdkit()).get_mol(value, JSON.stringify({ removeHs: false }));
        if (!molecule) throw new Error("RDKit could not parse the structure");
        try {
          const graph = JSON.parse(molecule.get_json!());
          const defaultZ = graph.defaults.atom.z;
          const heavyAtoms = graph.molecules[0].atoms.filter(
            (atom: { z?: number }) => (atom.z ?? defaultZ) !== 1).length;
          return { valid: true, canonicalSmiles: molecule.get_smiles!(), heavyAtoms,
            formula: "test-only", warnings: [] };
        } finally { molecule.delete(); }
      };
      context.chemistry.structureFromSmiles = async ({ smiles }) => {
        const parsed = await depictSmilesForPaste(smiles);
        const object = createSmilesMolecule(context.getDocument()!, point, parsed!.depiction, smiles);
        return { available: true, built: true, object };
      };
      const built = await buildInsertStructures(context, { items: [{ kind: "molecule", smiles }] });
      const result = await applyAssistantWrite(context, built);
      const molecule = context.getDocument()!.pages[0]!.objects.find(object =>
        result.objectIds.includes(object.id) && object.type === "molecule") as MoleculeObject;
      await verify(molecule, smiles);
    });

  it.each([
    ["N[C@@H](C)C(=O)O", "NC(C)C(=O)O"],
    ["F/C=C/F", "F/C=C\\F"],
    ["[NH3+]CC(=O)[O-]", "NCC(=O)O"]
  ])("refuses a depiction with missing or changed stereo or charge: %s", async (smiles, stripped) => {
    const parsed = await depictSmilesForPaste(stripped);
    await expect(checkedSmilesPaste(createEmptyDocument(), point, parsed!.depiction, smiles))
      .rejects.toThrow("SMILES paste refused");
  });

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
      await expect(checkedSmilesPaste(document, point, stripped, smiles))
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
