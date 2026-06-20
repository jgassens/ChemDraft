/**
 * Phase −1 spike helper: emit the EXACT molfile the Spin 3D handler sends for the
 * offending fused-polyether, via the real paste path (insertSmilesMolecule) +
 * moleculeToMolfileV2000(mol, { fromDocFrame: true }) — so the native RDKit spike
 * embeds precisely what ChemDraft produces, not an RDKit-generated proxy.
 *
 * Writes the molfile to SPIN3D_EXACT_MOLFILE_OUT if set (used once to capture the
 * docs/benchmarks artifact); otherwise just asserts the structure round-trips.
 */
import { writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { moleculeToMolfileV2000, type MoleculeObject } from "@chemdraft/chem-core";
import { depictSmiles2D, ensureOclResources, type Depiction2D } from "@chemdraft/ocl-adapter";
import { createPhase4Document, insertSmilesMolecule, type PastedStructureDepiction } from "./documentWorkflow";

const SMILES =
  "C[C@@H]1C[C@H]2[C@@H](C[C@]3([C@H](O2)C[C@H]4[C@H](O3)C(=CC(=O)O4)C)C)O[C@@H]5[C@@H]1O[C@H]6C[C@@H]7[C@](C[C@@H]8[C@@](O7)(C/C=C\\[C@@H]9[C@@H](O8)C[C@@H]1[C@@H](O9)C[C@@H]2[C@@](O1)([C@H](C[C@H](O2)CC(=C)C=O)O)C)C)(O[C@@]6(CC5)C)C";

function toPasted(dep: Depiction2D): PastedStructureDepiction {
  return {
    atoms: dep.atoms.map((atom) => ({ element: atom.element, x: atom.x, y: atom.y, charge: atom.charge })),
    bonds: dep.bonds.map((bond) => ({
      from: bond.from,
      to: bond.to,
      order: bond.order === "aromatic" || bond.order === "unknown" ? "single" : bond.order,
      wedge: bond.wedge
    }))
  };
}

beforeAll(async () => {
  await ensureOclResources();
});

describe("Spin 3D exact molfile (Phase −1 spike)", () => {
  it("emits the ChemDraft-serialized molfile for the offending polyether", () => {
    const document = createPhase4Document("spike");
    const next = insertSmilesMolecule(document, { x: 200, y: 200 }, toPasted(depictSmiles2D(SMILES)), SMILES);
    const placed = next.pages[0].objects.find((object) => object.type === "molecule");
    if (!placed || placed.type !== "molecule") throw new Error("no molecule placed");
    const mol = placed as MoleculeObject;
    // Exactly what apps/desktop/src/MainWindow.tsx sends to the conformer engine.
    const molfile = moleculeToMolfileV2000(mol, { fromDocFrame: true });

    const out = process.env.SPIN3D_EXACT_MOLFILE_OUT;
    if (out) writeFileSync(out, molfile);

    expect(mol.atoms.length).toBe(64);
    expect(molfile).toContain("V2000");
    // Stereo must be carried as V2000 bond-stereo flags (1=up, 6=down) for RDKit to
    // perceive it — bond line is "atom1 atom2 order stereo ...".
    const wedgeFlags = molfile.split(/\r?\n/).filter((line) => /^ *\d+ +\d+ +1 +[16](\s|$)/.test(line));
    expect(wedgeFlags.length).toBe(23);
  });
});
