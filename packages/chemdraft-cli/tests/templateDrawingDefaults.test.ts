import { describe, expect, it, vi } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";
import { resolveStructureTemplateName } from "@chemdraft/document-workflow-core";
import { buildSmilesDocument, type BuildSmilesDocumentOptions } from "../src/document";

// The shared node_modules resolves bare RDKit imports to the source checkout. Keep the real
// adapter in this worktree so it shares the singleton configured by Vitest's /node alias.
vi.mock("@chemdraft/rdkit-adapter", async () => import("../../rdkit-adapter/src/index"));

function bondLengths(molecule: MoleculeObject): number[] {
  const atoms = new Map(molecule.atoms.map(atom => [atom.id, atom]));
  return molecule.bonds.map(bond => {
    const from = atoms.get(bond.fromAtomId)!, to = atoms.get(bond.toAtomId)!;
    return Math.hypot(from.x - to.x, from.y - to.y);
  }).sort((a, b) => a - b);
}

describe("CLI template drawing defaults", () => {
  it.each<[BuildSmilesDocumentOptions, number]>([
    [{}, 28], [{ bondLength: 36 }, 36], [{ style: "document" }, 22]
  ])("matches ordinary SMILES style and sizing with %j", async (options, target) => {
    const template = resolveStructureTemplateName("18-crown-6")!;
    const built = await buildSmilesDocument(template.smiles, options);
    const ordinary = await buildSmilesDocument("CO", options);
    expect(built.layout).toBe(`template:${template.id}`);
    const { source, ...templateStyle } = built.molecule.style;
    const { source: ordinarySource, ...ordinaryStyle } = ordinary.molecule.style;
    expect(source).toBe(`structure-template:${template.id}`);
    expect(ordinarySource).toBe("clipboard-smiles");
    expect(Object.keys(templateStyle).sort()).toEqual(Object.keys(ordinaryStyle).sort());
    for (const [key, value] of Object.entries(ordinaryStyle)) {
      if (typeof value === "number") expect(templateStyle[key], key).toBeCloseTo(value, 9);
      else expect(templateStyle[key], key).toEqual(value);
    }
    const lengths = bondLengths(built.molecule);
    // Default insertion scales the mean; explicit CLI resizing uses the shared median contract.
    const measured = Object.keys(options).length === 0
      ? lengths.reduce((sum, length) => sum + length, 0) / lengths.length
      : (lengths[Math.floor((lengths.length - 1) / 2)]! + lengths[Math.floor(lengths.length / 2)]!) / 2;
    expect(measured).toBeCloseTo(target, 9);
    expect(bondLengths(ordinary.molecule)[0]).toBeCloseTo(target, 9);
  }, 60_000);

  it("rejects invalid explicit bond lengths for templates just as for ordinary SMILES", async () => {
    const template = resolveStructureTemplateName("18-crown-6")!;
    for (const smiles of [template.smiles, "CO"]) {
      await expect(buildSmilesDocument(smiles, { bondLength: 0 })).rejects.toThrow("Bond length");
    }
  });
});
