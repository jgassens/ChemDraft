import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, DocumentStylePreset } from "@chemdraft/chem-core";
import { resolveStructureTemplateName, structureTemplateLayoutMessage, structureTemplateMolecule } from "@chemdraft/document-workflow-core";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import { nameToStructureForPlugin, structureFromSmilesForPlugin } from "./plugins/pluginChemistry";
import { applyClipboardPastePayload } from "./documentWorkflow";
import { invoke } from "@tauri-apps/api/core";
import { templateMoleculeForSmiles } from "./structureTemplateInsertion";
import { depictSmilesForPaste } from "./smilesListPaste";
import { perceiveStereoCentersFromMolfile } from "@chemdraft/ocl-adapter";
import * as workflow from "@chemdraft/document-workflow-core";
import * as ocl from "@chemdraft/ocl-adapter";

vi.mock("./plugins/rdkitAppLoader", () => ({ loadRdkitWithAppLoader: (load: () => Promise<unknown>) => load() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockRejectedValue(new Error("No native runtime")) }));
beforeAll(() => installNodeRdkitModuleLoader());
afterEach(() => vi.restoreAllMocks());
vi.setConfig({ testTimeout: 60_000 });

describe("desktop template input boundaries", () => {
  const template = resolveStructureTemplateName("beta-cyclodextrin")!;
  it("returns template SMILES and engine without querying OPSIN", async () => {
    expect(await nameToStructureForPlugin({ name: "β-CD" })).toEqual({ available: true, parsed: true,
      smiles: template.smiles, engine: { id: "chemdraft-templates", version: "builtin" } });
    expect(invoke).not.toHaveBeenCalled();
  });
  it("builds a plugin molecule with the shared authored layout", async () => {
    const result = await structureFromSmilesForPlugin({ smiles: template.smiles }, () => createEmptyDocument());
    expect(result).toMatchObject({ available: true, built: true,
      object: { style: { source: `structure-template:${template.id}`, bondLengthPx: DocumentStylePreset.drawing.bondLengthPx } } });
  });
  it("prebuilds the template molecule and layout message for SMILES paste", async () => {
    const construction = vi.spyOn(workflow, "structureTemplateMolecule");
    const pasted = await depictSmilesForPaste(template.smiles);
    const molecule = pasted?.molecule;
    expect(molecule).toBeDefined();
    expect(construction).toHaveBeenCalledOnce();
    expect(molecule).toBe(construction.mock.results[0]!.value);
    expect(molecule?.style.source).toBe(`structure-template:${template.id}`);
    expect(structureTemplateLayoutMessage(molecule!)).toBe("Used the β-Cyclodextrin template layout");
  });
  it.each([template.smiles.replace("@@", "@"), template.smiles.replaceAll("@", "")])(
    "does not substitute changed/unspecified stereo", async smiles => {
      expect(await templateMoleculeForSmiles(smiles, createEmptyDocument(), { x: 400, y: 400 })).toBeUndefined();
    }
  );
  it("preserves template stereo metadata during paste parsing", async () => {
    const molecule = structureTemplateMolecule(template, { document: createEmptyDocument(), centre: { x: 0, y: 0 } });
    const expected = perceiveStereoCentersFromMolfile(molecule.structure)
      .filter(centre => centre.isStereoCenter && centre.descriptor !== "unspecified").length;
    const construction = vi.spyOn(workflow, "structureTemplateMolecule");
    const perception = vi.spyOn(ocl, "perceiveStereoCentersFromMolfile");
    const depiction = vi.spyOn(ocl, "depictSmiles2D").mockImplementation(() => { throw new Error("Generic depiction unavailable"); });
    const parsed = await depictSmilesForPaste(template.smiles);
    expect(parsed?.stereoCount).toBe(expected);
    expect(expected).toBeGreaterThan(0);
    expect(construction).toHaveBeenCalledOnce();
    expect(parsed?.molecule).toBe(construction.mock.results[0]!.value);
    expect(perception).toHaveBeenCalledExactlyOnceWith(parsed!.molecule!.structure);
    expect(parsed?.depiction).toEqual(workflow.pastedStructureDepictionFromMolfile(parsed!.molecule!.structure));
    expect(depiction).not.toHaveBeenCalled();
  });
  it("does not substitute the same molecule supplied as a molfile paste", () => {
    const document = createEmptyDocument();
    const molecule = structureTemplateMolecule(template, { document, centre: { x: 400, y: 400 } });
    const pasted = applyClipboardPastePayload(document, { kind: "molfile", text: molecule.structure,
      format: "molfile-v2000", warnings: [] }, { x: 300, y: 300 });
    const object = pasted.document.pages[0]!.objects[0]!;
    expect(object.type).toBe("molecule");
    if (object.type !== "molecule") throw new Error("expected molecule");
    expect(structureTemplateLayoutMessage(object)).toBeUndefined();
    expect(object.compatibility?.sourceFormat).not.toBe("smiles");
    expect(pasted.status).not.toContain("template layout");
  });
});
