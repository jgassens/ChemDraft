import { applyPatch } from "@chemdraft/chem-core";
import { defaultCases, bondDepiction, insertionDocument, expectDrawingDefaults } from "../drawingDefaults.testHelpers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateSmiles2DMolfile } from "@chemdraft/rdkit-adapter";
import { depictInWorker } from "../depiction2d/depict";
import { depictSmilesOffThread } from "../depiction2d/client";
import * as ocl from "@chemdraft/ocl-adapter";
import * as workflow from "@chemdraft/document-workflow-core";
import { createPhase4Document } from "../documentWorkflow";
import { RESERVED_PLUGIN_OBJECT_IDS, structureFromSmilesForPlugin } from "./pluginChemistry";
import { createPasteIdentityInspector, SmilesIdentityEngineUnavailableError } from "../smilesPasteIdentity";
import { IdentityWorkerUnavailableError } from "../depiction2d/identityWorkerClient";
import { ensureRdkit } from "../../../../packages/rdkit-adapter/src/conformer";
import { installRealRdkitModuleLoader } from "../../../../packages/rdkit-adapter/src/testing";

vi.mock("../depiction2d/client", () => ({ depictSmilesOffThread: vi.fn() }));
vi.mock("../rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@chemdraft/document-workflow-core", async original => ({
  ...await original<typeof import("@chemdraft/document-workflow-core")>()
}));
vi.mock("@chemdraft/rdkit-adapter", () => ({
  generateSmiles2DMolfile: vi.fn().mockRejectedValue(new Error("WASM unavailable")),
  ensureRdkit: () => ensureRdkit()
}));

beforeAll(async () => { installRealRdkitModuleLoader(); await ocl.ensureOclResources(); });
beforeEach(() => {
  vi.mocked(depictSmilesOffThread).mockImplementation((smiles) => depictInWorker(smiles, generateSmiles2DMolfile, () => {}));
});
afterEach(() => { vi.restoreAllMocks(); });

describe("plugin template identity verification", () => {
  const template = workflow.resolveStructureTemplateName("beta-cyclodextrin")!;

  it("verifies the built template once and returns its layout without coordinate generation", async () => {
    const document = createPhase4Document();
    const construction = vi.spyOn(workflow, "structureTemplateMolecule");
    const coordinateEngine = vi.spyOn(ocl, "depictSmiles2D");
    vi.mocked(depictSmilesOffThread).mockClear();
    vi.mocked(generateSmiles2DMolfile).mockClear();
    const inspect = vi.fn(createPasteIdentityInspector());

    const result = await structureFromSmilesForPlugin({ smiles: template.smiles }, () => document, undefined, inspect);

    expect(result).toMatchObject({ available: true, built: true });
    if (!result.available || !result.built) throw new Error("Template was not built");
    expect(construction).toHaveBeenCalledOnce();
    expect(result.object).toBe(construction.mock.results[0]!.value);
    expect(result.object.style.source).toBe(`structure-template:${template.id}`);
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(inspect).toHaveBeenNthCalledWith(1, "smiles", template.smiles);
    expect(inspect).toHaveBeenNthCalledWith(2, "molfile", expect.any(String), expect.any(String));
    expect(coordinateEngine).not.toHaveBeenCalled();
    expect(depictSmilesOffThread).not.toHaveBeenCalled();
    expect(generateSmiles2DMolfile).not.toHaveBeenCalled();
    expect(document.pages[0]!.objects).toHaveLength(0);
  });

  it.each(["refused", "unavailable"])("handles a %s inspector like the non-template path", async mode => {
    const document = createPhase4Document();
    const reservedBefore = new Set(RESERVED_PLUGIN_OBJECT_IDS);
    const realInspect = createPasteIdentityInspector();
    const unavailable = new SmilesIdentityEngineUnavailableError(new Error("test WASM unavailable"));
    const inspect = vi.fn<workflow.InspectChemicalIdentity>(async (format, value, stereoReference) => {
      if (format === "molfile") {
        if (mode === "unavailable") throw unavailable;
        return { valid: false, reason: "test identity refusal" };
      }
      return realInspect(format, value, stereoReference);
    });
    const construction = vi.spyOn(workflow, "structureTemplateMolecule");
    const coordinateEngine = vi.spyOn(ocl, "depictSmiles2D");
    vi.mocked(depictSmilesOffThread).mockClear();
    vi.mocked(generateSmiles2DMolfile).mockClear();

    const checkFailure = async (smiles: string) => {
      const result = await structureFromSmilesForPlugin({ smiles }, () => document, undefined, inspect);
      expect(result).toEqual(mode === "unavailable"
        ? { available: false, reason: unavailable.message }
        : { available: true, built: false,
          reason: `No 2D structure could be generated for "${smiles}": test identity refusal` });
      expect(RESERVED_PLUGIN_OBJECT_IDS).toEqual(reservedBefore);
      expect(document.pages[0]!.objects).toHaveLength(0);
    };

    await checkFailure(template.smiles);
    expect(construction).toHaveBeenCalledOnce();
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(coordinateEngine).not.toHaveBeenCalled();
    expect(depictSmilesOffThread).not.toHaveBeenCalled();
    expect(generateSmiles2DMolfile).not.toHaveBeenCalled();

    vi.mocked(depictSmilesOffThread).mockResolvedValueOnce({ depiction: ocl.depictSmiles2D("CCO"), stereoCount: 0 });
    await checkFailure("CCO");
    expect(inspect).toHaveBeenCalledTimes(4);
  });
});

describe("plugin chemistry SMILES failure reasons", () => {
  it("reports an unavailable identity engine rather than a structure refusal", async () => {
    vi.mocked(depictSmilesOffThread).mockResolvedValueOnce({
      depiction: ocl.depictSmiles2D("CCO"), stereoCount: 0
    });
    const inspect = createPasteIdentityInspector(async () => {
      throw new IdentityWorkerUnavailableError("test WASM unavailable");
    });
    const document = createPhase4Document();
    const result = await structureFromSmilesForPlugin({ smiles: "CCO" }, () => document, undefined, inspect);
    expect(result).toEqual({ available: false,
      reason: "the structure could not be verified because the RDKit engine did not load: " +
        "test WASM unavailable" });
    expect(document.pages[0].objects).toHaveLength(0);
  });

  it("keeps a depiction deadline warning in the built object's compatibility data", async () => {
    const warning = "2D depiction exceeded its 2000 ms layout deadline; used the standard layout.";
    vi.mocked(depictSmilesOffThread).mockResolvedValueOnce({ depiction: ocl.depictSmiles2D("CCO"), stereoCount: 0, warnings: [warning] });
    const result = await structureFromSmilesForPlugin({ smiles: "CCO" }, () => createPhase4Document());
    expect(result).toMatchObject({ built: true });
    if (result.available && result.built) {
      expect(result.object.compatibility?.warnings.some((entry) => entry.message.includes(warning))).toBe(true);
    }
  });

  it("forwards cancellation to the shared depiction queue", async () => {
    const controller = new AbortController(); controller.abort();
    vi.mocked(depictSmilesOffThread).mockRejectedValueOnce(Object.assign(new Error("2D depiction cancelled."), { name: "AbortError" }));
    const result = await structureFromSmilesForPlugin({ smiles: "CCO" }, () => createPhase4Document(), controller.signal);
    expect(depictSmilesOffThread).toHaveBeenLastCalledWith("CCO", { signal: controller.signal });
    expect(result).toMatchObject({ built: false, reason: expect.stringContaining("2D depiction cancelled") });
  });
  it.each(["n1cccc1", "c1cccc1"])("names %s and the specific chemistry refusal for the plugin", async (smiles) => {
    const document = createPhase4Document();
    const result = await structureFromSmilesForPlugin({ smiles }, () => document);
    expect(result).toEqual({
      available: true,
      built: false,
      reason: `No 2D structure could be generated for "${smiles}": ${new ocl.UnrequestedSmilesRadicalError(smiles).message}`
    });
    expect(document.pages[0].objects).toHaveLength(0);
  });

  it("names an invented-hydrogen refusal in full for the plugin", async () => {
    const smiles = "O=[N]=O";
    const document = createPhase4Document();
    const result = await structureFromSmilesForPlugin({ smiles }, () => document);
    const refusal = new ocl.UnrequestedSmilesHydrogenError(smiles, { bracket: "[N]", atomNumber: 2, written: 0, parsed: 1 });
    expect(result).toEqual({
      available: true,
      built: false,
      reason: `No 2D structure could be generated for "${smiles}": ${refusal.message}`
    });
    expect(document.pages[0].objects).toHaveLength(0);
  });

  it("keeps a multi-line chemistry refusal whole", async () => {
    const refusal = new ocl.UnrequestedSmilesHydrogenError("C");
    Object.defineProperty(refusal, "message", { value: "first line\nsecond line" });
    vi.spyOn(ocl, "depictSmiles2D").mockImplementation(() => { throw refusal; });
    const result = await structureFromSmilesForPlugin({ smiles: "C" }, () => createPhase4Document());
    expect(result).toMatchObject({ built: false, reason: "No 2D structure could be generated for \"C\": first line\nsecond line" });
  });

  it("keeps only the first line of an OCL parser exception", async () => {
    vi.spyOn(ocl, "depictSmiles2D").mockImplementation(() => {
      throw new Error("Class$S19: SmilesParser could not parse the input\nat parser stack frame");
    });
    const result = await structureFromSmilesForPlugin({ smiles: "C1" }, () => createPhase4Document());
    expect(result).toEqual({
      available: true,
      built: false,
      reason: "No 2D structure could be generated for \"C1\": Class$S19: SmilesParser could not parse the input"
    });
  });
});


it.each(defaultCases)("plugin structures use $bondLengthPx px document defaults without changing existing objects", async style => {
  const document = insertionDocument(style);
  const existing = structuredClone(document.pages[0]!.objects);
  vi.mocked(depictSmilesOffThread).mockResolvedValueOnce({ depiction: bondDepiction, stereoCount: 0, warnings: [] });
  const result = await structureFromSmilesForPlugin({ smiles: "CO" }, () => document);
  expect(result).toMatchObject({ available: true, built: true });
  if (!result.available || !result.built) throw new Error("Structure was not built");
  expectDrawingDefaults(result.object, style);
  const next = applyPatch(document, { op: "addObject", pageId: document.pages[0]!.id, object: result.object });
  expect(next.pages[0]!.objects.slice(0, 2)).toEqual(existing);
  expect(document.pages[0]!.objects).toEqual(existing);
});
