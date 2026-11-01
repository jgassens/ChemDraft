import { beforeAll, describe, expect, it } from "vitest";
import { applyPatch, createEmptyDocument } from "@chemdraft/chem-core";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import { ensureRdkit, generateSmiles2DMolfile } from "../../../../packages/rdkit-adapter/src/conformer";
import {
  createSmilesMolecule, inspectHydrogenNormalizedIdentity, pastedStructureDepictionFromMolfile
} from "@chemdraft/document-workflow-core";
import { callAssistantTool } from "./assistantTools";
import { isotopeInsertSmiles, isotopeReactions, expectIsotopeGraph } from
  "../../../../packages/document-workflow-core/test/isotopeInsertFixtures";
import { buildInsertStructures, inspectMolecule } from "./writeBuilder";
import { verifyNormalizedAssistantWrite } from "./normalizedWrite";
import { testContext } from "./tools/testContext";
import type { AssistantToolContext } from "./AssistantToolContext";
import { depictSmilesForPaste } from "../smilesListPaste";

beforeAll(() => installNodeRdkitModuleLoader());
function realContext(selected = true): AssistantToolContext {
  const { context } = testContext(selected);
  context.chemistry.inspectStructure = async (_format, value, stereoReference) => {
    const rdkit = await ensureRdkit();
    const mol = rdkit.get_mol(value, JSON.stringify({ removeHs: false })) as {
      get_smiles(): string; get_json(): string; delete(): void
    } | null;
    if (!mol) return { valid: false, reason: "RDKit could not parse the structure" };
    try {
      const graph = JSON.parse(mol.get_json()) as { defaults?: { atom?: { z?: number } }; molecules: { atoms: { z?: number }[] }[] };
      const defaultZ = graph.defaults?.atom?.z ?? 6;
      const identity = inspectHydrogenNormalizedIdentity(rdkit, value, stereoReference);
      if (!identity.valid) return identity;
      return { valid: true, canonicalSmiles: mol.get_smiles(), identitySmiles: identity.canonicalSmiles,
        identityFacts: identity.facts,
        formula: "test-only", warnings: [],
        heavyAtoms: graph.molecules.reduce((sum, molecule) => sum + molecule.atoms.filter(atom => (atom.z ?? defaultZ) !== 1).length, 0) };
    } finally { mol.delete(); }
  };
  context.chemistry.structureFromSmiles = async ({ smiles }) => ({ available: true, built: true,
    object: createSmilesMolecule(context.getDocument()!, { x: 200, y: 200 },
      pastedStructureDepictionFromMolfile(await generateSmiles2DMolfile(smiles)), smiles)
  });
  return context;
}
describe("RDKit assistant write identity", () => {
  it.each([
    ["F[C@](Cl)=C=C(Br)I", "allene (axial)"],
    ["F[C@@](Cl)=C=C(Br)I", "allene (axial)"],
    ["N[Pt@SP1](N)(Cl)Cl", "square-planar"]
  ])("refuses unverifiable stereo before building or writing: %s", async (smiles, kind) => {
    const context = realContext(false);
    await expect(buildInsertStructures(context, { items: [{ kind: "molecule", smiles }] }))
      .rejects.toThrow(`${kind} stereochemistry cannot be verified or drawn`);
    expect(context.write).not.toHaveBeenCalled();
  });

  it.each(["C[C@H](C)C", "[C@H](F)(F)F", "C[C@H](O)CC"])(
    "allows harmless chirality marks and ordinary stereocentres: %s", async smiles => {
      const result = await callAssistantTool(realContext(false), "insert_structures", {
        items: [{ kind: "molecule", smiles }]
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
    });

  it.each(["CC=CC", "CC(C)=CCCC(C)=CC=O", "[2H]C=Cc1ccccc1"])(
    "accepts input-unspecified E/Z during preparation and normalized commit: %s", async smiles => {
      const context = realContext(false);
      context.getDocument()!.pages[0]!.objects = [];
      context.chemistry.structureFromSmiles = async ({ smiles }) => {
        const parsed = (await depictSmilesForPaste(smiles))!;
        return { available: true, built: true, object: createSmilesMolecule(
          context.getDocument()!, { x: 200, y: 200 }, parsed.depiction, smiles) };
      };
      const write = context.write;
      context.write = async (patch, signal, check, expected) => {
        const before = context.getDocument()!;
        const patched = applyPatch(before, patch);
        await verifyNormalizedAssistantWrite(context, before, patched, new Set(expected?.keys()), expected);
        return write(patch, signal, check, expected);
      };
      const result = await callAssistantTool(context, "insert_structures", {
        items: [{ kind: "molecule", smiles }]
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(write).toHaveBeenCalledTimes(1);
    });

  it("canonicalizes the actual inserted native graph to the input SMILES", async () => {
    const context = realContext(false);
    const result = await callAssistantTool(context, "insert_structures", { items: [{ kind: "molecule", smiles: "OC(C)=O" }] });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const ids = result.structuredContent!.objectIds as string[];
    const object = context.getDocument()!.pages[0]!.objects.find(object => ids.includes(object.id))!;
    if (object.type !== "molecule") throw new Error("expected molecule");
    const source = await context.chemistry.inspectStructure("smiles", "OC(C)=O");
    expect(source.valid).toBe(true);
    expect((await inspectMolecule(context, object)).canonicalSmiles).toBe(source.valid ? source.canonicalSmiles : "");
  });
  it("rejects a depiction with a different canonical identity", async () => {
    const context = realContext();
    const original = context.chemistry.structureFromSmiles;
    context.chemistry.structureFromSmiles = () => original({ smiles: "CC" });
    await expect(buildInsertStructures(context, { items: [{ kind: "molecule", smiles: "CO" }] })).rejects.toThrow("Canonical SMILES mismatch");
    expect(context.write).not.toHaveBeenCalled();
  });
  it.each([
    ["[2H]CO", "CO"], ["[3H]CO", "CO"], ["[1H]CO", "CO"], ["[13CH3]O", "CO"],
    ["N[C@@H](C)C(=O)O", "NC(C)C(=O)O"], ["F/C=C/F", "F/C=C\\F"],
    ["[NH3+]CC(=O)[O-]", "NCC(=O)O"], ["CCO", "CO"]
  ])("refuses identity loss during preparation and commit: %s", async (smiles, changed) => {
    const context = realContext(false);
    const original = context.chemistry.structureFromSmiles;
    context.chemistry.structureFromSmiles = () => original({ smiles: changed });
    await expect(buildInsertStructures(context, { items: [{ kind: "molecule", smiles }] }))
      .rejects.toThrow("Canonical SMILES mismatch");
    expect(context.write).not.toHaveBeenCalled();

    const before = createEmptyDocument();
    const molecule = createSmilesMolecule(before, { x: 200, y: 200 },
      pastedStructureDepictionFromMolfile(await generateSmiles2DMolfile(changed)), changed);
    const patched = applyPatch(before, { op: "addObject", pageId: before.pages[0]!.id, object: molecule });
    await expect(verifyNormalizedAssistantWrite(context, before, patched, new Set([molecule.id]),
      new Map([[molecule.id, smiles]]))).rejects.toThrow("canonical isomeric SMILES or atom count");
  });
  it("rejects more than 500 heavy atoms before depiction", async () => {
    const context = realContext();
    const result = await callAssistantTool(context, "insert_structures", { items: [{ kind: "molecule", smiles: "C".repeat(501) }] });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("500 heavy atom") });
    expect(context.write).not.toHaveBeenCalled();
  });
  it("rejects more than 24 items before chemistry", async () => {
    const context = realContext();
    await expect(buildInsertStructures(context, { items: Array(25).fill({ kind: "molecule", smiles: "CC" }) })).rejects.toThrow();
    expect(context.write).not.toHaveBeenCalled();
  });
  it("keeps the original centre when replacing a selected molecule", async () => {
    const context = realContext();
    const old = context.getDocument()!.pages[0]!.objects[0]!;
    const result = await callAssistantTool(context, "edit_structure", { objectId: old.id, smiles: "CCC" });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const ids = result.structuredContent!.objectIds as string[];
    const edited = context.getDocument()!.pages[0]!.objects.find(object => ids.includes(object.id))!;
    expect(edited.x + edited.width / 2).toBeCloseTo(old.x + old.width / 2);
    expect(edited.y + edited.height / 2).toBeCloseTo(old.y + old.height / 2);
    expect(context.write).toHaveBeenCalledTimes(1);
  });
  it("restyles without changing the atom/bond graph or canonical identity", async () => {
    const context = realContext();
    const old = context.getDocument()!.pages[0]!.objects[0]!;
    const before = structuredClone(old);
    const result = await callAssistantTool(context, "style_objects", { objectIds: [old.id], style: { color: "#345678", strokeWidth: 2 } });
    expect(result.isError).not.toBe(true);
    const after = context.getDocument()!.pages[0]!.objects.find(object => object.id === old.id)!;
    expect({ ...after, style: before.style }).toEqual(before);
    if (old.type !== "molecule" || after.type !== "molecule") throw new Error("expected molecule");
    expect((await inspectMolecule(context, after)).canonicalSmiles).toBe((await inspectMolecule(context, old)).canonicalSmiles);
  });
  it.each(isotopeInsertSmiles)("inserts isotopes successfully: %s", async smiles => {
    const context = realContext(false);
    const result = await callAssistantTool(context, "insert_structures", {
      items: [{ kind: "molecule", smiles }]
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const ids = result.structuredContent!.objectIds as string[];
    const molecule = context.getDocument()!.pages[0]!.objects.find(object => ids.includes(object.id))!;
    if (molecule.type !== "molecule") throw new Error("expected molecule");
    const input = await context.chemistry.inspectStructure("smiles", smiles);
    expect((await inspectMolecule(context, molecule)).canonicalSmiles)
      .toBe(input.valid ? input.canonicalSmiles : "");
    expectIsotopeGraph(molecule, await generateSmiles2DMolfile(smiles));
  });
  it.each(isotopeReactions)("inserts the worked reaction: $products", async reaction => {
    const context = realContext(false);
    context.confirmPageGrowth = async () => true;
    const result = await callAssistantTool(context, "insert_reaction", reaction);
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const ids = result.structuredContent!.objectIds as string[];
    const molecules = context.getDocument()!.pages[0]!.objects.filter(object =>
      object.type === "molecule" && ids.includes(object.id));
    const inputs = [...reaction.reactants, ...reaction.products];
    expect(molecules).toHaveLength(inputs.length);
    for (const [index, molecule] of molecules.entries()) {
      if (molecule.type !== "molecule") throw new Error("expected molecule");
      const input = await context.chemistry.inspectStructure("smiles", inputs[index]!);
      expect((await inspectMolecule(context, molecule)).canonicalSmiles)
        .toBe(input.valid ? input.canonicalSmiles : "");
      expectIsotopeGraph(molecule, await generateSmiles2DMolfile(inputs[index]!));
    }
  });
  it.each(["[CH3]"])("refuses any isotope or radical loss for %s", async smiles => {
    const context = realContext(false);
    const result = await callAssistantTool(context, "insert_structures", { items: [{ kind: "molecule", smiles }] });
    expect(result.isError).toBe(true);
    expect(context.write).not.toHaveBeenCalled();
    expect(result.content[0]).toMatchObject({
      text: expect.stringMatching(/identity|radical|isotope|hydrogen/i)
    });
  });
});
