import { createEmptyDocument } from "@chemdraft/chem-core";
import { validatePluginManifest, type RecognizedStructureResult } from "@chemdraft/plugin-api";
import { PluginHost } from "@chemdraft/plugin-host";
import { describe, expect, it } from "vitest";
import {
  createMolScribeOcsrCommandHandler,
  createMolScribeOcsrPanelState,
  mockSourceImageRef,
  molscribeOcsrCommandId,
  molscribeOcsrManifest,
  runMolScribeOcsrMockRecognition
} from "./index";

const timestamp = "2026-05-29T00:00:00.000Z";

describe("molscribeOcsrManifest", () => {
  it("validates as an optional plugin manifest without heavy inference permissions", () => {
    const result = validatePluginManifest(molscribeOcsrManifest);

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(molscribeOcsrManifest.permissions).not.toContain("native.execute");
    expect(molscribeOcsrManifest.permissions).not.toContain("network.fetch");
    expect(molscribeOcsrManifest.permissions).not.toContain("model.load");
    expect(molscribeOcsrManifest.permissions).not.toContain("model.download");
  });
});

describe("runMolScribeOcsrMockRecognition", () => {
  it("returns a fixture-backed recognition result with source-image context and warnings", () => {
    const result = runMolScribeOcsrMockRecognition({
      sourceImageRef: mockSourceImageRef,
      pageId: "page_001",
      insertion: { x: 144, y: 160 }
    });
    const panel = createMolScribeOcsrPanelState(result);

    expect(result.sourceImageRef).toBe(mockSourceImageRef);
    expect(result.proposedSmiles).toBe("c1ccccc1");
    expect(result.warnings.map((warning) => warning.code)).toContain("mock-output");
    expect(result.proposedPatch?.requiresUserApproval).toBe(true);
    expect(result.proposedPatch?.patch).toMatchObject({
      op: "addObject",
      pageId: "page_001",
      object: {
        id: "mol_molscribe_mock_benzene",
        x: 144,
        y: 160,
        structure: "c1ccccc1"
      }
    });
    expect(panel).toMatchObject({
      sourceImageRef: mockSourceImageRef,
      proposedSmiles: "c1ccccc1",
      confidencePercent: 91,
      canAccept: true,
      proposedPatchReason: "molscribe-ocsr.mock-recognition"
    });
  });
});

describe("createMolScribeOcsrCommandHandler", () => {
  it("queues a proposed patch through plugin-host and accepts it through chem-core", async () => {
    const host = new PluginHost({ now: () => timestamp });
    host.registerPlugin(molscribeOcsrManifest, {
      commandHandlers: {
        [molscribeOcsrCommandId]: createMolScribeOcsrCommandHandler(() => ({
          sourceImageRef: mockSourceImageRef,
          pageId: "page_001"
        }))
      }
    });

    const result = await host.invokeCommand<RecognizedStructureResult>(molscribeOcsrCommandId);
    const pendingPatches = host.listProposedPatches("pending");

    expect(result.sourceImageRef).toBe(mockSourceImageRef);
    expect(pendingPatches).toHaveLength(1);
    expect(pendingPatches[0].proposal.requiresUserApproval).toBe(true);
    await expect(host.getStorage(molscribeOcsrManifest.id).get("lastSourceImageRef")).resolves.toBe(
      mockSourceImageRef
    );

    const document = createEmptyDocument({ now: timestamp });
    const updated = host.acceptProposedPatch(pendingPatches[0].id, document, { now: timestamp });

    expect(updated.pages[0].objects).toHaveLength(1);
    expect(updated.pages[0].objects[0]).toMatchObject({
      id: "mol_molscribe_mock_benzene",
      type: "molecule",
      structure: "c1ccccc1"
    });
  });
});
