import { describe, expect, it } from "vitest";
import { nativeAtomValidationState, nativeSingleBondGraphMetadata } from "./atoms";
import { nativeDocumentExportWarnings, nativeMoleculeExportWarnings } from "./exportWarnings";
import { moleculeSmiles } from "./moleculeSmiles";
import type { ExportWarning } from "@chemdraft/export-engine";
import { invalidCarbonDocument, invalidCarbonMolecule, invalidCarbonWarning } from "../test/invalidStructureFixtures";

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
