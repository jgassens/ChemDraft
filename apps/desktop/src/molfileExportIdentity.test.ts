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
import { invalidCarbonDocument, invalidCarbonWarning } from "../../../packages/document-workflow-core/test/invalidStructureFixtures";

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
    await runCommand(document, (current, format, warnings) => {
      warnings?.push("Existing export warning.");
      return copyAsMolfileForExport(current, format, warnings, engine);
    }, writeText, setStatus);
    const label = flavor === "v2000" ? "Copy as MOL V2000" : "Copy as MOL";
    expect(setStatus).toHaveBeenCalledWith(`${label} refused: exported coordinates would change the structure (C[C@H](N)C(=O)O became C[C@@H](N)C(=O)O). — Existing export warning.`);
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

  it.each(["v2000", "v3000"] as const)("checks the final merged %s graph when the identifier engine throws", async flavor => {
    const engine = vi.fn<ComputeStructureIdentifiers>().mockRejectedValue(new Error("WASM unavailable"));
    const document = documentWithStructures();
    const result = await copyAsMolfileForExport(document, flavor, [], engine);
    expect(result).toBe(copyAsMolfile(document, flavor));
    expect(engine).toHaveBeenNthCalledWith(1, copyAsMolfile(document, flavor, [], { coordinateUnits: "raw" }));
    expect(engine).toHaveBeenNthCalledWith(2, result);
  });

  it("refuses SDF when only its exported canonical SMILES is unavailable", async () => {
    const real = identifiers.computeStructureIdentifiers;
    vi.spyOn(identifiers, "computeStructureIdentifiers").mockImplementation(async contents =>
      contents.startsWith("Named structure 1\n") ? undefined : real(contents));
    await expect(exportStructureListSdf(documentWithStructures())).rejects.toThrow(
      "SDF record 1 (Named structure 1) refused: the exported structure could not be verified (canonical SMILES available for only one side)."
    );
  });

  it("exports an SDF title ending in V2000 when both canonical SMILES are unavailable", async () => {
    const document = documentWithStructures();
    const molecule = document.pages[0]!.objects[0] as MoleculeObject;
    molecule.structure = `Sample V2000${molecule.structure.slice(molecule.structure.indexOf("\n"))}`;
    vi.spyOn(identifiers, "computeStructureIdentifiers").mockResolvedValue(undefined);
    const result = await exportStructureListSdf(document);
    expect(result.contents.startsWith("Sample V2000\n")).toBe(true);
    expect(result.contents.match(/\$\$\$\$/g)).toHaveLength(2);
    expectAngstromScale(result.contents);
  });

  it("does not treat missing identifiers on both sides as proof of identity", async () => {
    await expect(assertMolfileExportIdentity("raw", "scaled", undefined, "Copy As MOL")).rejects.toThrow(
      "Copy As MOL refused: the source MOL could not be read back (MOL data is not a supported V2000 or V3000 molfile)."
    );
  });

  it.each(["unknown-order bond", "invalid-valence carbon"])("exports an unavailable-SMILES %s with existing warnings", async kind => {
    const document = invalidCarbonDocument();
    const molecule = document.pages[0]!.objects[0] as MoleculeObject;
    if (kind === "unknown-order bond") {
      molecule.atoms = molecule.atoms.slice(0, 2);
      molecule.bonds = [{ ...molecule.bonds[0]!, order: "unknown" }];
    }
    const before = structuredClone(document);
    vi.spyOn(identifiers, "computeStructureIdentifiers").mockResolvedValue(undefined);
    for (const flavor of ["v2000", "v3000"] as const) {
      const existingWarnings: string[] = [];
      const expected = copyAsMolfile(document, flavor, existingWarnings);
      const warnings: string[] = [];
      const result = await copyAsMolfileForExport(document, flavor, warnings, identifiers.computeStructureIdentifiers);
      expect(result).toBe(expected);
      expect(warnings).toEqual(existingWarnings);
      expect(warnings).toContainEqual(kind === "unknown-order bond"
        ? expect.stringContaining("has an unknown bond order") : invalidCarbonWarning);
      expectAngstromScale(result!);
    }
    const sdf = await exportStructureListSdf(document);
    if (kind === "unknown-order bond") {
      expect(sdf.warnings).toEqual([
        expect.objectContaining({ code: "export.sdf_v2000_loss", message: expect.stringContaining("bond type 8 (any)") }),
        expect.objectContaining({ code: "export.smiles_write_failed", message: "Cannot write SMILES: bond b1 has an unknown bond order." })
      ]);
      expect(parseMolfileGraph(sdf.contents).bonds[0]!.order).toBe("unknown");
    } else {
      expect(sdf.warnings).toEqual([expect.objectContaining({ code: "export.invalid_structure", message: invalidCarbonWarning })]);
      expect(parseMolfileGraph(sdf.contents).atoms).toHaveLength(6);
    }
    expect(document).toEqual(before);
  });

  describe.each(["v2000", "v3000"] as const)("coordinate-free %s fallback", flavor => {
    const mutations: [string, (molecule: MoleculeObject) => void][] = [
      ["atom count", molecule => { molecule.atoms.push({ id: "extra", element: "C", formalCharge: 0, x: 50, y: 50 }); }],
      ["element", molecule => { molecule.atoms[0]!.element = "N"; }],
      ["charge", molecule => { molecule.atoms[0]!.formalCharge = 1; }],
      ["isotope", molecule => { molecule.atoms[0]!.isotope = 13; }],
      ["radical", molecule => { molecule.atoms[0]!.markRadicals = 1; }],
      ["bond count", molecule => { molecule.bonds.pop(); }],
      ["bond endpoint", molecule => { molecule.bonds[0]!.toAtomId = molecule.atoms[2]!.id; }],
      ["bond direction", molecule => {
        const bond = molecule.bonds[0]!;
        [bond.fromAtomId, bond.toAtomId] = [bond.toAtomId, bond.fromAtomId];
      }],
      ["bond order/type", molecule => { molecule.bonds[0]!.order = "unknown"; }],
      ["stereo flag", molecule => {
        const bond = molecule.bonds[0]!;
        bond.display = { bondStyle: bond.display?.bondStyle === "hashed" ? "wedge" : "hashed" };
      }]
    ];
    it.each(mutations)("refuses changed %s when SMILES is unavailable", async (_name, mutate) => {
      const document = documentWithStructures();
      const source = copyAsMolfile(document, flavor, [], { coordinateUnits: "raw" })!;
      mutate(document.pages[0]!.objects[0] as MoleculeObject);
      const exported = copyAsMolfile(document, flavor)!;
      await expect(assertMolfileExportIdentity(source, exported, undefined, "MOL export")).rejects.toThrow(
        "MOL export refused: the exported structure differs from the drawing (coordinate-free MOL atom or bond data differ)."
      );
    });

    it("refuses when only source SMILES is unavailable", async () => {
      const document = documentWithStructures();
      const source = copyAsMolfile(document, flavor, [], { coordinateUnits: "raw" })!;
      const exported = copyAsMolfile(document, flavor)!;
      const engine = vi.fn<ComputeStructureIdentifiers>().mockResolvedValueOnce(undefined).mockResolvedValueOnce({ smiles: "CC" });
      await expect(assertMolfileExportIdentity(source, exported, engine, "MOL export")).rejects.toThrow(
        "MOL export refused: the exported structure could not be verified (canonical SMILES available for only one side)."
      );
      expect(engine).toHaveBeenCalledTimes(2);
    });

    it("distinguishes query bond types that the clipboard parser exposes as unknown", async () => {
      const document = documentWithStructures();
      (document.pages[0]!.objects[0] as MoleculeObject).bonds[0]!.order = "unknown";
      const source = copyAsMolfile(document, flavor)!;
      const exported = flavor === "v2000"
        ? source.replace(/^(\s*\d+\s+\d+)  8/m, "$1  5")
        : source.replace(/^(M  V30 \d+) 8 /m, "$1 5 ");
      expect(exported).not.toBe(source);
      expect(parseMolfileGraph(source).bonds.map(bond => bond.order))
        .toEqual(parseMolfileGraph(exported).bonds.map(bond => bond.order));
      await expect(assertMolfileExportIdentity(source, exported, undefined, "MOL export")).rejects.toThrow(
        "MOL export refused: the exported structure differs from the drawing (coordinate-free MOL atom or bond data differ)."
      );
    });

    it("refuses malformed final bytes when canonical SMILES is unavailable", async () => {
      const source = copyAsMolfile(documentWithStructures(), flavor)!;
      await expect(assertMolfileExportIdentity(source, "invalid", undefined, "MOL export")).rejects.toThrow(
        "MOL export refused: the exported MOL could not be read back (MOL data is not a supported V2000 or V3000 molfile)."
      );
    });
  });
});
