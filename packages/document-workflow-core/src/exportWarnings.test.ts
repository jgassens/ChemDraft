import { describe, expect, it } from "vitest";
import { nativeAtomValidationState, nativeSingleBondGraphMetadata } from "./atoms";
import { nativeDocumentExportWarnings, nativeMoleculeExportWarnings } from "./exportWarnings";
import { moleculeSmiles } from "./moleculeSmiles";
import type { ExportWarning } from "@chemdraft/export-engine";
import { invalidCarbonDocument, invalidCarbonMolecule, invalidCarbonWarning } from "../test/invalidStructureFixtures";
import { chargeSeparationCases } from "../test/chargeSeparationFixtures";

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

it("does not suppress nitro validation without evidence that sanitization applied", async () => {
  const molecule = chargeSeparationCases.find(entry => entry.name === "nitro")!.molecule;
  const warnings: ExportWarning[] = [];
  await moleculeSmiles(molecule, 0, warnings, async () => ({ smiles: "C[N+](=O)[O-]" }));
  expect(warnings).toEqual([expect.objectContaining({
    code: "export.invalid_structure", message: "N1 has unsupported valence 5."
  })]);
});
