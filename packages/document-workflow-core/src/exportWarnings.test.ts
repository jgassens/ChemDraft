import { beforeAll, describe, expect, it } from "vitest";
import { moleculeToMolfileV2000 } from "@chemdraft/chem-core";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import { nativeAtomValidationState, nativeSingleBondGraphMetadata } from "./atoms";
import { nativeDocumentExportWarnings, nativeMoleculeExportWarnings } from "./exportWarnings";
import { moleculeSmiles } from "./moleculeSmiles";
import type { ExportWarning } from "@chemdraft/export-engine";
import { invalidCarbonDocument, invalidCarbonMolecule, invalidCarbonWarning } from "../test/invalidStructureFixtures";
import { chargeSeparationCases } from "../test/chargeSeparationFixtures";

beforeAll(() => { installNodeRdkitModuleLoader(); });

describe.each([false, true])("invalid structure diagnostics (suppressed=%s)", suppressed => {
  it("retains validation and metadata independently of badge suppression", () => {
    const molecule = invalidCarbonMolecule(suppressed);
    const state = nativeAtomValidationState(molecule.atoms[0]!, molecule.bonds, 0, molecule.atoms);
    expect(state).toMatchObject({ valid: false, invalidReason: "C has unsupported valence 5." });
    expect(state.warningSuppressed).toBe(suppressed ? true : undefined);
    const metadata = nativeSingleBondGraphMetadata(molecule.atoms, molecule.bonds);
    expect(metadata.warnings).toContainEqual(expect.objectContaining({
      message: "C atom a1 has unsupported valence 5.", objectId: "a1"
    }));
  });
  it("uses drawn atom indices and one warning per problem even with stale metadata", () => {
    const molecule = invalidCarbonMolecule(suppressed);
    const expected = [{ code: "export.invalid_structure", message: invalidCarbonWarning,
      severity: "warning", objectId: molecule.id }];
    expect(nativeMoleculeExportWarnings(molecule)).toEqual(expected);
    expect(nativeDocumentExportWarnings(invalidCarbonDocument(suppressed))).toEqual(expected);
    molecule.atoms[2]!.element = "Qq";
    expect(nativeMoleculeExportWarnings(molecule)).toHaveLength(2);
    expect(nativeMoleculeExportWarnings(molecule)[1]!.message).toContain("Qq3");
  });
  it.each([undefined, async () => undefined])("warns on native SMILES with absent/rejecting engine", async engine => {
    const warnings: ExportWarning[] = [];
    const contents = await moleculeSmiles(invalidCarbonMolecule(suppressed), 0, warnings, engine);
    expect(contents).not.toBe("");
    expect(warnings).toContainEqual(expect.objectContaining({ message: invalidCarbonWarning }));
  });
  it("writes the current invalid graph instead of a stale stored valid SMILES", async () => {
    const molecule = { ...invalidCarbonMolecule(suppressed), structureFormat: "smiles" as const, structure: "CC" };
    const warnings: ExportWarning[] = [];
    const contents = await moleculeSmiles(molecule, 0, warnings, undefined);
    expect(contents.match(/C/g)).toHaveLength(6);
    expect(warnings).toContainEqual(expect.objectContaining({ message: invalidCarbonWarning }));
  });
});

function incompleteNitrogen() {
  const molecule = invalidCarbonMolecule();
  molecule.atoms = molecule.atoms.slice(0, 2);
  molecule.bonds = molecule.bonds.slice(0, 1);
  Object.assign(molecule.atoms[0]!, { element: "N", labelLiteral: true });
  return molecule;
}

describe.each([
  { route: "engine", compute: computeStructureIdentifiers },
  { route: "native", compute: undefined }
])("specific problem accounting ($route)", ({ compute }) => {
  it("keeps the main incomplete-N output and diagnostic exactly, without mutating the graph", async () => {
    const molecule = incompleteNitrogen();
    const before = structuredClone(molecule);
    const warnings: ExportWarning[] = [];
    expect(await moleculeSmiles(molecule, 0, warnings, compute)).toBe(compute ? "C[N]" : "[N]C");
    expect(warnings).toEqual([{
      code: "export.smiles_radical_loss", severity: "warning", objectId: molecule.id,
      message: compute
        ? "Atom a1 (N) is drawn with 0 radical electrons; SMILES reparses with 2 radical electrons."
        : "Atom a1 (N) is drawn with 0 radical electrons; SMILES would imply 2 radical electrons with its hydrogen count and formal charge."
    }]);
    expect(molecule).toEqual(before);
  });

  it.each([0, 1])("still names a five-bond carbon with %s drawn radicals", async markRadicals => {
    const molecule = invalidCarbonMolecule();
    molecule.atoms[0]!.markRadicals = markRadicals;
    const warnings: ExportWarning[] = [];
    expect(await moleculeSmiles(molecule, 0, warnings, compute)).not.toBe("");
    expect(warnings).toContainEqual({
      code: "export.invalid_structure", severity: "warning", objectId: molecule.id,
      message: `C1 has unsupported valence ${5 + markRadicals}.`
    });
    if (markRadicals) expect(warnings).toContainEqual(expect.objectContaining({
      code: "export.smiles_radical_loss", message: expect.stringContaining("Atom a1 (C)")
    }));
  });
});

it("never trusts stale stored CC for an incomplete N-C graph without RDKit", async () => {
  const molecule = { ...incompleteNitrogen(), structureFormat: "smiles" as const, structure: "CC" };
  const warnings: ExportWarning[] = [];
  expect(await moleculeSmiles(molecule, 0, warnings, undefined)).toBe("[N]C");
  expect(warnings).toEqual([expect.objectContaining({ code: "export.smiles_radical_loss" })]);
  // Filtering the output diagnostic must never filter the raw validity guard.
  expect(nativeMoleculeExportWarnings(molecule)).toEqual([expect.objectContaining({
    code: "export.invalid_structure", message: "N1 has 1 of 3 bonds."
  })]);
});

it("retains the valence warning when the reported radicals do not fill the deficit", async () => {
  const molecule = incompleteNitrogen();
  const identifiers = (await computeStructureIdentifiers(
    moleculeToMolfileV2000(molecule, {}).contents, { includeAtomStates: true }
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
    moleculeToMolfileV2000(molecule, {}).contents, { includeAtomStates: true }
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
