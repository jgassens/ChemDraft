import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import { copyAsMolfile, copyAsSmiles, exportPhase4Cdxml } from "./documentWorkflow";
import { exportStructureListSdf, exportStructureListSmi } from "./structureListExport";
import { openChemDraftPayload } from "@chemdraft/cdx-compat";
import { invalidCarbonDocument, invalidCarbonWarning } from "../../../packages/document-workflow-core/test/invalidStructureFixtures";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@chemdraft/rdkit-adapter/identifiers", () => ({ computeStructureIdentifiers: vi.fn() }));
beforeEach(() => { vi.mocked(computeStructureIdentifiers).mockReset().mockResolvedValue(undefined); });

describe.each([false, true])("invalid exports (suppressed=%s)", suppressed => {
  it.each(["v2000", "v3000"] as const)("copies %s with the full graph and named diagnostic", flavor => {
    const document = invalidCarbonDocument(suppressed);
    const before = structuredClone(document);
    const warnings: string[] = [];
    const contents = copyAsMolfile(document, flavor, warnings)!;
    expect(contents).toContain(flavor === "v2000" ? "V2000" : "V3000");
    const graph = parseMolfileGraph(contents);
    expect(graph.atoms).toHaveLength(6);
    expect(graph.bonds).toHaveLength(5);
    expect(warnings).toEqual([invalidCarbonWarning]);
    expect(document).toEqual(before);
  });
  it("exports CDXML with the same diagnostic and preserves the native graph", () => {
    const result = exportPhase4Cdxml(invalidCarbonDocument(suppressed));
    expect(result.contents).toContain("<CDXML");
    expect(result.warnings).toContainEqual(expect.objectContaining({ message: invalidCarbonWarning }));
    const molecule = openChemDraftPayload(result.contents).document!.pages[0]!.objects[0]!;
    expect(molecule.type).toBe("molecule");
    if (molecule.type !== "molecule") throw new Error("Expected molecule");
    expect(molecule.atoms).toHaveLength(6);
    expect(molecule.bonds).toHaveLength(5);
  });
  it("returns the same warning from SDF, SMILES list and Copy As SMILES", async () => {
    const document = invalidCarbonDocument(suppressed);
    for (const exporter of [exportStructureListSdf, exportStructureListSmi]) {
      const result = await exporter(document);
      expect(result.contents).not.toBe("");
      expect(result.warnings.filter(warning => warning.code === "export.invalid_structure"))
        .toEqual([expect.objectContaining({ message: invalidCarbonWarning })]);
      if (result.format === "sdf") {
        expect(result.contents).toContain("$$$$");
        expect(parseMolfileGraph(result.contents).bonds).toHaveLength(5);
      }
    }
    const warnings: string[] = [];
    expect(await copyAsSmiles(document, warnings)).toBeTruthy();
    expect(warnings).toContain(invalidCarbonWarning);
  });
});
