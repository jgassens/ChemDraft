import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import { molfileCoordinateScale } from "@chemdraft/layout-engine";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import * as identifiers from "@chemdraft/rdkit-adapter/identifiers";
import { assertMolfileExportIdentity, type ComputeStructureIdentifiers } from "@chemdraft/document-workflow-core";
import { copyAsMolfile, copyAsMolfileForExport, createNativeMolfileMolecule, createPhase4Document } from "./documentWorkflow";
import { exportStructureListSdf } from "./structureListExport";

// Keep the desktop's loader from replacing the real Node WASM loader in these tests.
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));

beforeAll(() => installNodeRdkitModuleLoader());
afterEach(() => vi.restoreAllMocks());

function documentWithStructures(): ChemDraftDocument {
  const document = createPhase4Document("Export identity");
  document.pages[0]!.objects = ["C[C@H](N)C(=O)O", "F/C=C/F"].map((smiles, index): MoleculeObject => {
    const molecule = createNativeMolfileMolecule(document, { x: 100 + index * 250, y: 100 },
      depictSmiles2D(smiles).molfile, "molfile-v2000");
    return { ...molecule, id: `structure-${index}`, structure: `Named structure ${index + 1}${molecule.structure.slice(molecule.structure.indexOf("\n"))}` };
  });
  return document;
}

function expectAngstromScale(contents: string) {
  const graph = parseMolfileGraph(contents);
  expect(molfileCoordinateScale(graph.atoms, graph.bonds, 1.5, 22).medianBondLength).toBeCloseTo(1.5, 3);
}

describe("desktop final MOL/SDF identity guard", () => {
  it.each(["v2000", "v3000"] as const)("verifies the returned merged Copy As %s bytes against the raw merged CTAB", async flavor => {
    const document = documentWithStructures();
    const before = structuredClone(document);
    const engine = vi.fn(identifiers.computeStructureIdentifiers);
    const contents = (await copyAsMolfileForExport(document, flavor, [], engine))!;
    expect(engine).toHaveBeenCalledTimes(2);
    expect(engine).toHaveBeenNthCalledWith(1, copyAsMolfile(document, flavor, [], { coordinateUnits: "raw" }));
    expect(engine).toHaveBeenNthCalledWith(2, contents);
    expect(contents).not.toBe(engine.mock.calls[0]![0]);
    expect((await engine.mock.results[0]!.value)?.smiles).toContain("@");
    expect((await engine.mock.results[1]!.value)?.smiles).toBe((await engine.mock.results[0]!.value)?.smiles);
    expectAngstromScale(contents);
    expect(document).toEqual(before);
  });

  it.each(["v2000", "v3000"] as const)("Copy As %s refuses a forced stereo change before writing and reports it in the status bar", async flavor => {
    const document = documentWithStructures();
    const engine = vi.fn<ComputeStructureIdentifiers>()
      .mockResolvedValueOnce({ smiles: "C[C@H](N)C(=O)O" })
      .mockResolvedValueOnce({ smiles: "C[C@@H](N)C(=O)O" });
    const writeText = vi.fn();
    const setStatus = vi.fn();
    // Exercise the actual command branch, including its await, write ordering and error handler.
    const source = readFileSync(new URL("./MainWindow.tsx", import.meta.url), "utf8");
    const command = flavor === "v2000" ? "molV2000" : "mol";
    const start = source.indexOf(`case "clipboard.copyAs.${command}": {`);
    const end = source.indexOf("\n      case ", start + 1);
    const branch = source.slice(start, end).replace('case "clipboard.copyAs.' + command + '": ', "")
      .replace("const warnings: string[] = [];", "const warnings = [];");
    expect(source).toContain("copyAsMolfileForExport as copyAsMolfile");
    const runCommand = new Function("current", "copyAsMolfile", "writeText", "setStatus",
      `return (async () => ${branch})();`) as (
        current: ChemDraftDocument, prepare: typeof copyAsMolfileForExport, write: typeof writeText, status: typeof setStatus
      ) => Promise<void>;
    await runCommand(document, (current, format, warnings) => copyAsMolfileForExport(current, format, warnings, engine), writeText, setStatus);
    const label = flavor === "v2000" ? "Copy As MOL V2000" : "Copy As MOL";
    expect(setStatus).toHaveBeenCalledWith(`${label} failed: ${label} refused: exported coordinates would change the structure (C[C@H](N)C(=O)O became C[C@@H](N)C(=O)O).`);
    expect(writeText).not.toHaveBeenCalled();
    expect(engine).toHaveBeenNthCalledWith(2, copyAsMolfile(document, flavor));
  });

  it("checks each complete SDF CTAB exactly as returned, including its final title", async () => {
    const document = documentWithStructures();
    const before = structuredClone(document);
    const engine = vi.spyOn(identifiers, "computeStructureIdentifiers");
    const result = await exportStructureListSdf(document);
    const records = result.contents.split("$$$$\n").filter(Boolean);
    expect(records).toHaveLength(2);
    const guardCalls = engine.mock.calls.filter(call => call[1] === undefined);
    expect(guardCalls).toHaveLength(4);
    records.forEach((record, index) => {
      const ctab = record.slice(0, record.indexOf("M  END\n") + "M  END\n".length);
      expect(ctab.startsWith(`Named structure ${index + 1}\n`)).toBe(true);
      expect(guardCalls[index * 2 + 1]![0]).toBe(ctab);
      expect(guardCalls[index * 2]![0]).not.toBe(ctab);
      expectAngstromScale(ctab);
    });
    expect(document).toEqual(before);
  });

  it("refuses the whole SDF before any file write when a later named record changes identity", async () => {
    const real = identifiers.computeStructureIdentifiers;
    const engine = vi.spyOn(identifiers, "computeStructureIdentifiers").mockImplementation(async (contents, options) => {
      if (!options && contents.startsWith("Named structure 2\n")) return { smiles: "F/C=C\\F" };
      return real(contents, options);
    });
    const writeFile = vi.fn();
    const exportAndWrite = async () => {
      const result = await exportStructureListSdf(documentWithStructures());
      await writeFile(result.contents);
    };
    await expect(exportAndWrite()).rejects.toThrow(
      "SDF record 2 (Named structure 2) refused: exported coordinates would change the structure (F/C=C/F became F/C=C\\F)."
    );
    expect(engine.mock.calls.some(([contents]) => contents.startsWith("Named structure 1\n"))).toBe(true);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("refuses Copy As when canonical identity cannot be established", async () => {
    const engine = vi.fn<ComputeStructureIdentifiers>().mockResolvedValue(undefined);
    await expect(copyAsMolfileForExport(documentWithStructures(), "v3000", [], engine)).rejects.toThrow(
      "Copy As MOL refused: could not verify the source structure (canonical SMILES unavailable)."
    );
  });

  it("refuses SDF when the final bytes cannot be parsed", async () => {
    const real = identifiers.computeStructureIdentifiers;
    vi.spyOn(identifiers, "computeStructureIdentifiers").mockImplementation(async contents =>
      contents.startsWith("Named structure 1\n") ? undefined : real(contents));
    await expect(exportStructureListSdf(documentWithStructures())).rejects.toThrow(
      "SDF record 1 (Named structure 1) refused: could not verify the exported structure (canonical SMILES unavailable)."
    );
  });

  it("does not treat missing identifiers on both sides as proof of identity", async () => {
    await expect(assertMolfileExportIdentity("raw", "scaled", undefined, "Copy As MOL")).rejects.toThrow(
      "Copy As MOL refused: could not verify the source structure (canonical SMILES unavailable)."
    );
  });
});
