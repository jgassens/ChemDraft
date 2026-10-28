import { beforeAll, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, DocumentStylePreset } from "@chemdraft/chem-core";
import { resolveStructureTemplateName, structureTemplateLayoutMessage, structureTemplateMolecule } from "@chemdraft/document-workflow-core";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import { nameToStructureForPlugin, structureFromSmilesForPlugin } from "./plugins/pluginChemistry";
import { insertPastedSmiles } from "./smilesInsertion";
import { applyClipboardPastePayload } from "./documentWorkflow";
import { invoke } from "@tauri-apps/api/core";
import { templateMoleculeForSmiles } from "./structureTemplateInsertion";

vi.mock("./plugins/rdkitAppLoader", () => ({ loadRdkitWithAppLoader: (load: () => Promise<unknown>) => load() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockRejectedValue(new Error("No native runtime")) }));
beforeAll(() => installNodeRdkitModuleLoader());
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
  it("selects the pasted SMILES and reports the layout", async () => {
    const document = createEmptyDocument();
    const pasted = await insertPastedSmiles(document, { x: 400, y: 400 }, { atoms: [], bonds: [] }, template.smiles);
    const molecule = pasted.document.pages[0]!.objects[0]!;
    expect(pasted.document.selection.objectIds).toEqual([molecule.id]);
    expect(pasted.status).toBe("Used the β-Cyclodextrin template layout");
  });
  it.each([template.smiles.replace("@@", "@"), template.smiles.replaceAll("@", "")])(
    "does not substitute changed/unspecified stereo", async smiles => {
      expect(await templateMoleculeForSmiles(smiles, createEmptyDocument(), { x: 400, y: 400 })).toBeUndefined();
    }
  );
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
