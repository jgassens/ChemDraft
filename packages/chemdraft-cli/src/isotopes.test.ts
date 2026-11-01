import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openChemDraftPayload } from "@chemdraft/cdx-compat";
import { moleculeToMolfileV2000, moleculeToMolfileV3000, type MoleculeObject } from "@chemdraft/chem-core";
import { nativeBondOrderResolution } from "@chemdraft/layout-engine";
import { generateSmiles2DMolfile } from "../../rdkit-adapter/src/conformer";
import { installIsotopeTestEngine } from "./isotopes.testUtils";
import { isotopeInsertSmiles, isotopeReactions, expectIsotopeGraph } from
  "../../document-workflow-core/test/isotopeInsertFixtures";
import { runCli } from "./cli";
import { canonicalSmiles, buildSmilesDocument, renderSmilesToAssets } from "./document";
import { renderReactionScheme } from "./commands/reaction";

vi.setConfig({ testTimeout: 60_000 });
let directory: string;
beforeAll(async () => {
  installIsotopeTestEngine();
  directory = await mkdtemp(join(tmpdir(), "chemdraft-isotopes-"));
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
async function run(args: string[]) {
  const lines: string[] = [];
  const errors: string[] = [];
  const code = await runCli(args, { stdout: line => lines.push(line), stderr: line => errors.push(line) });
  expect(code, [...lines, ...errors].join("\n")).toBe(0);
  expect(JSON.parse(lines[0]!).ok).toBe(true);
}
async function verify(molecule: MoleculeObject, smiles: string) {
  const expected = await canonicalSmiles(smiles, "source");
  expectIsotopeGraph(molecule, await generateSmiles2DMolfile(smiles));
  for (const write of [moleculeToMolfileV2000, moleculeToMolfileV3000]) {
    const molfile = write(molecule, { fromDocFrame: true,
      kekuleBondOrders: nativeBondOrderResolution(molecule.atoms, molecule.bonds).kekuleOrders }).contents;
    expect(await canonicalSmiles(molfile, "native graph")).toBe(expected);
  }
}

describe("CLI isotope preservation", () => {
  it.each(isotopeInsertSmiles)("document, render and every chemical export: %s", async smiles => {
    const index = isotopeInsertSmiles.indexOf(smiles);
    const built = await buildSmilesDocument(smiles);
    await verify(built.molecule, smiles);
    const path = join(directory, `${index}.json`);
    await run(["document", "--smiles", smiles, "--out", path]);
    const native = openChemDraftPayload(await readFile(path, "utf8")).document!;
    await verify(native.pages[0]!.objects[0] as MoleculeObject, smiles);
    const rendered = await renderSmilesToAssets(smiles, { width: 160 });
    expect(rendered.svg).toContain("<svg");
    await verify(rendered.molecule, smiles);
    for (const format of ["mol", "sdf", "smi", "cdxml"]) {
      const out = join(directory, `${index}.${format}`);
      await run(["export", "--smiles", smiles, "--out", out]);
      const contents = await readFile(out, "utf8");
      if (format === "cdxml") {
        const reopened = openChemDraftPayload(contents).document!;
        await verify(reopened.pages[0]!.objects[0] as MoleculeObject, smiles);
      } else {
        const structure = format === "smi" ? contents.trim().split(/\s/)[0]! : contents.split("> <")[0]!;
        expect(await canonicalSmiles(structure, "export")).toBe(await canonicalSmiles(smiles, "source"));
      }
    }
  });
  it.each(isotopeReactions)("keeps the worked reaction positions: $products", async reaction => {
    const rendered = await renderReactionScheme({ ...reaction, agents: [] });
    const molecules = rendered.document.pages[0]!.objects.filter(object => object.type === "molecule");
    const inputs = [...reaction.reactants, ...reaction.products];
    expect(molecules).toHaveLength(inputs.length);
    for (const [index, molecule] of molecules.entries()) await verify(molecule, inputs[index]!);
  });
  it("accepts isotope-labelled reaction agents as formula text", async () => {
    const rendered = await renderReactionScheme({
      reactants: ["CCO"], agents: ["CC(=[18O])C"], products: ["CC=O"]
    });
    expect(rendered.agentTexts[0]).toMatchObject({ smiles: "CC(=[18O])C", source: "formula" });
    expect(rendered.agentTexts[0]!.text).toContain("18");
  });
  it("refuses a radical reaction agent with a radical-only message", async () => {
    await expect(renderReactionScheme({
      reactants: ["CCO"], agents: ["[15N]=O"], products: ["CC=O"]
    })).rejects.toThrow("SMILES contains a radical that ChemDraft cannot yet draw: [15N]=O");
  });
  it.each(["[CH3]", "[15N]=O"])("continues refusing radicals: %s", async smiles => {
    const lines: string[] = [];
    const code = await runCli(["document", "--smiles", smiles, "--out", join(directory, "radical.json")],
      { stdout: line => lines.push(line), stderr: () => {} });
    expect(code).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false, error: expect.stringMatching(/radical/) });
    expect(JSON.parse(lines[0]!).error).not.toContain("radical/isotope");
    await expect(readFile(join(directory, "radical.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
