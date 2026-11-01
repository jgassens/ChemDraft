import { beforeAll, describe, expect, it } from "vitest";
import { parseMolfileGraph, smilesListCandidates } from "@chemdraft/clipboard-adapter";
import { perceiveDoubleBondStereoFromMolfile } from "@chemdraft/ocl-adapter";
import { generateSmiles2DMolfile } from "@chemdraft/rdkit-adapter";
import { installRealRdkitModuleLoader } from "@chemdraft/rdkit-adapter/testing";
import { depictInWorker } from "./depiction2d/depict";
import { depictSmilesForPaste, depictSmilesListForPaste, unspecifiedDoubleBondNotice } from "./smilesListPaste";
import { createPhase4Document, getSelectedMolecule, insertSmilesMolecule, insertSmilesMoleculeGrid } from "./documentWorkflow";

beforeAll(() => installRealRdkitModuleLoader());

describe.each(["rdkit", "fallback"] as const)("SMILES open E/Z in the %s worker path", engine => {
  it.each([["CC=CC", 1], ["C/C=C/C", 0], ["CC=O", 0], ["CC=C(C)C", 0], ["C1=CCCCC1", 0]] as const)("preserves %s (open count %s)", async (smiles, count) => {
    const standardCounts: number[] = [];
    const parsed = await depictInWorker(smiles, engine === "rdkit" ? generateSmiles2DMolfile : async () => { throw new Error("unavailable"); },
      result => standardCounts.push(result.depiction.bonds.filter(b => b.stereo === "either").length));
    expect(parsed.depiction.bonds.filter(b => b.stereo === "either")).toHaveLength(count);
    if (engine === "rdkit") expect(standardCounts).toEqual([count]);
    const document = insertSmilesMolecule(createPhase4Document(), { x: 220, y: 220 }, parsed.depiction, smiles, { openUnspecifiedDoubleBonds: true });
    const molecule = getSelectedMolecule(document)!;
    expect(molecule.bonds.filter(b => b.stereo === "either")).toHaveLength(count);
    expect(parseMolfileGraph(molecule.structure).bonds.filter(b => b.stereo === "either")).toHaveLength(count);
    if (smiles === "C/C=C/C") expect(perceiveDoubleBondStereoFromMolfile(molecule.structure)[0].descriptor).toBe("E");
  });
});

it("single and list paste report the exact notice and list total through the existing warnings", async () => {
  const parsed = await depictSmilesForPaste("CC=CC");
  expect(parsed?.warnings).toContain(unspecifiedDoubleBondNotice(1));
  const defined = await depictSmilesForPaste("C/C=C/C");
  expect(defined?.warnings?.some(w => w.includes("E/Z was not specified")) ?? false).toBe(false);
  const text = "CC=CC\nCC=CC\nC/C=C/C\nCC=O\nCC=C(C)C";
  const list = await depictSmilesListForPaste(text, smilesListCandidates(text));
  expect(list?.warnings?.filter(w => w.includes("E/Z was not specified"))).toEqual([
    "E/Z was not specified for 2 double bond(s) in the pasted structure. Confirm the geometry."
  ]);
  const grid = insertSmilesMoleculeGrid(createPhase4Document(), { x: 20, y: 20 }, list!.entries);
  expect(grid.document.pages[0].objects.flatMap(o => o.type === "molecule" ? o.bonds.filter(b => b.stereo === "either") : [])).toHaveLength(2);
});
