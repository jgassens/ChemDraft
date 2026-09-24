import {
  RecognizedStructureResultSchema,
  validatePluginManifest,
  type PluginImageRequestResult,
  type PluginPanelReport
} from "@chemdraft/plugin-api";
import { PluginHost } from "@chemdraft/plugin-host";
import { describe, expect, it, vi } from "vitest";

import {
  createMolScribeOcsrCommandHandler,
  molscribeOcsrCommandId,
  molscribeOcsrManifest,
  molscribeOcsrPanelId
} from "./index";

// Recognition fixtures remain test-only until a real engine exists.
const mockRecognitionFixture = RecognizedStructureResultSchema.parse({
  sourceImageRef: "fixture://molscribe-ocsr/benzene.png",
  proposedSmiles: "c1ccccc1",
  confidence: 0.91,
  warnings: [{ code: "mock-output", message: "Test-only recognition fixture." }]
});

describe("molscribeOcsrManifest", () => {
  it("targets API 0.1.5 and requests only image/menu/panel permissions", () => {
    expect(validatePluginManifest(molscribeOcsrManifest)).toMatchObject({ ok: true, errors: [] });
    expect(molscribeOcsrManifest.apiVersion).toBe("^0.1.5");
    expect(molscribeOcsrManifest.permissions).toEqual(["image.read", "ui.menu", "ui.panel"]);
    expect(mockRecognitionFixture.proposedSmiles).toBe("c1ccccc1");
  });
});

describe("createMolScribeOcsrCommandHandler", () => {
  it("requests a real image, reports that no engine exists, and inserts/proposes nothing", async () => {
    const reports: PluginPanelReport[] = [];
    const applyDocumentPatch = vi.fn();
    const requestImage = vi.fn(async (): Promise<PluginImageRequestResult> => ({
      status: "provided",
      image: {
        mediaType: "image/png",
        bytes: new Uint8Array([137, 80, 78, 71]),
        width: 640,
        height: 480,
        source: "screenRegion"
      }
    }));
    const host = new PluginHost({
      requestImage,
      applyDocumentPatch,
      showPanelReport: (_pluginId, panelId, report) => {
        expect(panelId).toBe(molscribeOcsrPanelId);
        reports.push(report);
      }
    });
    host.registerPlugin(molscribeOcsrManifest, {
      commandHandlers: { [molscribeOcsrCommandId]: createMolScribeOcsrCommandHandler() }
    });

    await expect(host.invokeCommand(molscribeOcsrCommandId)).resolves.toMatchObject({
      status: "provided",
      image: { width: 640, height: 480, source: "screenRegion" }
    });
    expect(requestImage).toHaveBeenCalledOnce();
    expect(reports).toHaveLength(1);
    expect(reports[0].sections).toEqual([
      {
        kind: "text",
        body:
          "No recognition engine is installed yet — the image was received (640×480, screenRegion) but cannot be converted to a structure."
      }
    ]);
    expect(host.listProposedPatches()).toEqual([]);
    expect(applyDocumentPatch).not.toHaveBeenCalled();
  });

  it("is silent when image acquisition is cancelled", async () => {
    const showPanelReport = vi.fn();
    const host = new PluginHost({
      requestImage: async () => ({ status: "cancelled" }),
      showPanelReport
    });
    host.registerPlugin(molscribeOcsrManifest, {
      commandHandlers: { [molscribeOcsrCommandId]: createMolScribeOcsrCommandHandler() }
    });

    await expect(host.invokeCommand(molscribeOcsrCommandId)).resolves.toEqual({ status: "cancelled" });
    expect(showPanelReport).not.toHaveBeenCalled();
    expect(host.listProposedPatches()).toEqual([]);
  });
});
