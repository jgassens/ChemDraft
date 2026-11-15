import { beforeAll, describe, expect, it } from "vitest";
import { moleculeToMolfileV2000 } from "@chemdraft/chem-core";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import type { ExportWarning } from "@chemdraft/export-engine";
import { moleculeSmiles } from "../src/moleculeSmiles";
import { invalidCarbonMolecule } from "./invalidStructureFixtures";
import { chargeSeparationCases } from "./chargeSeparationFixtures";

beforeAll(() => { installNodeRdkitModuleLoader(); });

function incompleteNitrogen() {
  const molecule = invalidCarbonMolecule();
  molecule.atoms = molecule.atoms.slice(0, 2);
  molecule.bonds = molecule.bonds.slice(0, 1);
  Object.assign(molecule.atoms[0]!, { element: "N", labelLiteral: true });
  return molecule;
}

describe("specific problem accounting (engine)", () => {
  it("keeps the main incomplete-N output and diagnostic exactly, without mutating the graph", async () => {
    const molecule = incompleteNitrogen();
    const before = structuredClone(molecule);
    const warnings: ExportWarning[] = [];
    expect(await moleculeSmiles(molecule, 0, warnings, computeStructureIdentifiers)).toBe("C[N]");
    expect(warnings).toEqual([{
      code: "export.smiles_radical_loss", severity: "warning", objectId: molecule.id,
      message: "Atom a1 (N) is drawn with 0 radical electrons; SMILES reparses with 2 radical electrons."
    }]);
    expect(molecule).toEqual(before);
  });

  it.each([0, 1])("still names a five-bond carbon with %s drawn radicals", async markRadicals => {
    const molecule = invalidCarbonMolecule();
    molecule.atoms[0]!.markRadicals = markRadicals;
    const warnings: ExportWarning[] = [];
    expect(await moleculeSmiles(molecule, 0, warnings, computeStructureIdentifiers)).not.toBe("");
    expect(warnings).toContainEqual({
      code: "export.invalid_structure", severity: "warning", objectId: molecule.id,
      message: `C1 has unsupported valence ${5 + markRadicals}.`
    });
    if (markRadicals) expect(warnings).toContainEqual(expect.objectContaining({
      code: "export.smiles_radical_loss", message: expect.stringContaining("Atom a1 (C)")
    }));
  });
});

it("retains the valence warning when the reported radicals do not fill the deficit", async () => {
  const molecule = incompleteNitrogen();
  const identifiers = (await computeStructureIdentifiers(
    moleculeToMolfileV2000(molecule, { fromDocFrame: true, kekuleBondOrders: new Map() }).contents,
    { includeAtomStates: true }
  ))!;
  const nitrogenIndex = identifiers.smilesAtomOrder!.indexOf(0);
  identifiers.smilesAtomStates![nitrogenIndex]!.nRad = 1;
  const warnings: ExportWarning[] = [];
  await moleculeSmiles(molecule, 0, warnings, async () => identifiers);
  expect(warnings.map(warning => warning.code)).toEqual(["export.invalid_structure", "export.smiles_radical_loss"]);
  expect(warnings[0]!.message).toBe("N1 has 1 of 3 bonds.");
});

it("keeps the main nitro SMILES and charge-separation note exactly", async () => {
  const molecule = chargeSeparationCases.find(entry => entry.name === "nitro")!.molecule;
  const warnings: ExportWarning[] = [];
  expect(await moleculeSmiles(molecule, 0, warnings, computeStructureIdentifiers)).toBe("C[N+](=O)[O-]");
  expect(warnings).toEqual([{
    code: "export.smiles_charge_separated", severity: "info", objectId: molecule.id,
    message: "SMILES writes charge-separated formal charges while preserving total charge: " +
      "Atom a0 (N) is drawn with formal charge 0; SMILES reparses with formal charge 1. " +
      "Atom a1 (O) is drawn with formal charge 0; SMILES reparses with formal charge -1."
  }]);
});

it("does not suppress nitro validation without evidence that sanitization applied", async () => {
  const molecule = chargeSeparationCases.find(entry => entry.name === "nitro")!.molecule;
  const warnings: ExportWarning[] = [];
  await moleculeSmiles(molecule, 0, warnings, async () => ({ smiles: "C[N+](=O)[O-]" }));
  expect(warnings).toEqual([expect.objectContaining({
    code: "export.invalid_structure", message: "N1 has unsupported valence 5."
  })]);
});

it("accounts only for the nitro atom named by the applied charge separation", async () => {
  const molecule = structuredClone(chargeSeparationCases.find(entry => entry.name === "nitro")!.molecule);
  const originalCount = molecule.atoms.length;
  molecule.atoms.push(...molecule.atoms.map(atom => ({ ...atom, id: `other_${atom.id}` })));
  molecule.bonds.push(...molecule.bonds.map(bond => ({ ...bond, id: `other_${bond.id}`,
    fromAtomId: `other_${bond.fromAtomId}`, toAtomId: `other_${bond.toAtomId}` })));
  const identifiers = (await computeStructureIdentifiers(
    moleculeToMolfileV2000(molecule, { fromDocFrame: true, kekuleBondOrders: new Map() }).contents,
    { includeAtomStates: true }
  ))!;
  // Model an engine reporting sanitization of only the first nitro group. A charge note
  // elsewhere in this molecule is not evidence that the second N's problem was accounted for.
  identifiers.smilesAtomOrder!.forEach((inputIndex, outputIndex) => {
    if (inputIndex >= originalCount) identifiers.smilesAtomStates![outputIndex]!.formalCharge = 0;
  });
  const warnings: ExportWarning[] = [];
  await moleculeSmiles(molecule, 0, warnings, async () => identifiers);
  expect(warnings).toEqual([
    { code: "export.invalid_structure", severity: "warning", objectId: molecule.id,
      message: "N5 has unsupported valence 5." },
    expect.objectContaining({ code: "export.smiles_charge_separated", severity: "info" })
  ]);
  expect(warnings[1]!.message).not.toContain("other_");
});
