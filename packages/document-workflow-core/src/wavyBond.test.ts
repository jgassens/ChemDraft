// The purity boundary scans src imports as production dependencies.
import { describe, expect, it } from "../../../node_modules/vitest";
import { createEmptyDocument, moleculeToMolfileV2000 } from "@chemdraft/chem-core";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import { computeStructureIdentifiers } from "../../rdkit-adapter/src/identifiers";
import { installNodeRdkitModuleLoader } from "../../rdkit-adapter/src/node";
import { createSmilesMolecule, pastedStructureDepictionFromMolfile } from "./molecule";
import { moleculeSmiles } from "./moleculeSmiles";

function drawing() {
  const doc = createEmptyDocument();
  const smiles = "F[C@](Cl)(Br)I";
  const mol = createSmilesMolecule(doc, { x: 200, y: 200 }, depictSmiles2D(smiles), smiles);
  const bond = mol.bonds.find(bond => bond.display?.bondStyle === "wedge" || bond.display?.bondStyle === "hashed")!;
  bond.display = { bondStyle: "wavy" };
  return { doc, mol, bond };
}

describe("shared workflow wavy stereo", () => {
  it("refuses a stale chiral stored SMILES shortcut when the engine is unavailable", async () => {
    const { mol } = drawing();
    mol.structureFormat = "smiles"; mol.structure = "F[C@](Cl)(Br)I";
    const warnings: Parameters<typeof moleculeSmiles>[2] = [];
    const result = await moleculeSmiles(mol, 0, warnings, undefined);
    expect(result).not.toContain("@");
    expect(result).toContain("F");
    expect(warnings.some(warning => warning.code === "export.smiles_stereo_dropped")).toBe(false);
  });

  it("rebuilds engine input from the graph even if the caller supplies a stale chiral molfile", async () => {
    installNodeRdkitModuleLoader();
    const { mol } = drawing();
    const warnings: Parameters<typeof moleculeSmiles>[2] = [];
    const result = await moleculeSmiles(mol, 0, warnings, computeStructureIdentifiers, depictSmiles2D("F[C@](Cl)(Br)I").molfile);
    expect(result).not.toContain("@");
    expect(warnings).toEqual([]);
  });

  it("preserves wavy direction through MOL depiction parsing and native insertion", () => {
    const { doc, mol, bond } = drawing();
    const molfile = moleculeToMolfileV2000(mol, { kekuleBondOrders: new Map() }).contents;
    const depiction = pastedStructureDepictionFromMolfile(molfile);
    const wave = depiction.bonds.find(bond => bond.wedge === "wavy")!;
    expect(wave.from).toBe(mol.atoms.findIndex(atom => atom.id === bond.fromAtomId));
    expect(wave.to).toBe(mol.atoms.findIndex(atom => atom.id === bond.toAtomId));
    const inserted = createSmilesMolecule(doc, { x: 200, y: 200 }, depiction, "FC(Cl)(Br)I");
    expect(inserted.bonds.find(bond => bond.display?.bondStyle === "wavy")).toMatchObject({ fromAtomId: `a${wave.from}`, toAtomId: `a${wave.to}` });
    expect(parseMolfileGraph(inserted.structure).bonds.some(bond => bond.bondStyle === "wavy")).toBe(true);
  });
});
