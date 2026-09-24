import type {
  PluginCommandHandler,
  PluginManifest,
  PluginPanelReport,
  PluginRecognitionResult
} from "@chemdraft/plugin-api";

import type { BundledPluginDescriptor } from "../plugins/registerBundledPlugins";

/**
 * Test-only image-to-structure plugin.
 *
 * The real recognizer (MolScribe OCSR) is an official plugin installed from its own repository, so the
 * app no longer bundles one. Host tests still need a plugin that drives the whole recognition path —
 * image request, `recognition.recognizeStructure`, the host install presenter, and a proposal-only
 * insertion — and this is the smallest one that does. It declares exactly the permissions the real
 * plugin declares, so the host's gating is exercised against the same manifest shape.
 */
export const RECOGNITION_FIXTURE_PLUGIN_ID = "org.chemdraft.test.recognition";
export const RECOGNITION_FIXTURE_COMMAND_ID = "plugin.recognitionFixture.recognizeImage";
export const RECOGNITION_FIXTURE_PANEL_ID = "panel.recognitionFixture.review";
export const RECOGNITION_FIXTURE_TITLE = "Recognition Fixture";

export const recognitionFixtureManifest: PluginManifest = {
  id: RECOGNITION_FIXTURE_PLUGIN_ID,
  name: RECOGNITION_FIXTURE_TITLE,
  version: "0.0.0",
  apiVersion: "^0.1.6",
  description: "Test-only recognizer that exercises the host-managed recognition capability.",
  entry: "test:recognition-fixture",
  permissions: [
    "image.read",
    "ml.inference",
    "model.load",
    "native.execute",
    "document.proposePatch",
    "ui.menu",
    "ui.panel"
  ],
  contributes: {
    commands: [
      {
        id: RECOGNITION_FIXTURE_COMMAND_ID,
        title: "Recognize Fixture Image",
        requiredPermissions: [
          "image.read",
          "ml.inference",
          "model.load",
          "native.execute",
          "document.proposePatch",
          "ui.panel"
        ],
        enabled: true
      }
    ],
    menus: [
      {
        id: "menu.recognitionFixture.recognizeImage",
        title: "Recognize Fixture Image",
        commandId: RECOGNITION_FIXTURE_COMMAND_ID,
        location: "analyze",
        requiredPermissions: ["ui.menu"]
      }
    ],
    panels: [
      {
        id: RECOGNITION_FIXTURE_PANEL_ID,
        title: RECOGNITION_FIXTURE_TITLE,
        commandId: RECOGNITION_FIXTURE_COMMAND_ID,
        requiredPermissions: ["ui.panel"]
      }
    ],
    toolbarButtons: [],
    toolsets: [],
    inspectors: [],
    templates: [],
    importers: [],
    exporters: [],
    analyzers: [],
    transformers: [],
    recognizers: [
      {
        id: "recognizer.recognitionFixture.image",
        title: "Recognition Fixture Image Recognizer",
        input: "selected-image",
        commandId: RECOGNITION_FIXTURE_COMMAND_ID,
        requiredPermissions: ["image.read", "ml.inference", "model.load", "native.execute"]
      }
    ]
  }
};

export function createRecognitionFixtureCommandHandler(): PluginCommandHandler<
  PluginRecognitionResult | { status: "cancelled" | "unavailable" }
> {
  return async (context) => {
    const imageResult = await context.images!.requestImage({ title: "Recognize Fixture Image" });
    if (imageResult.status === "cancelled") return imageResult;
    if (imageResult.status === "unavailable") {
      await showMessage(context, `Image input is unavailable: ${imageResult.reason}`);
      return imageResult;
    }

    const recognition = await context.recognition!.recognizeStructure(imageResult.image);
    if (recognition.status === "engineNotInstalled") {
      await showMessage(context, "Recognition needs the local engine.");
      return recognition;
    }
    if (recognition.status === "failed") {
      await showMessage(context, `Recognition failed: ${recognition.message}`);
      return recognition;
    }

    const result = recognition.result;
    if (result.proposedPatch && result.proposedMolfile) {
      await context.documents.proposePatch({
        ...result.proposedPatch,
        requiresUserApproval: true,
        recognition: {
          sourceImageRef: result.sourceImageRef,
          proposedSmiles: result.proposedSmiles,
          proposedMolfile: result.proposedMolfile,
          confidenceTier: "high",
          engine: result.engine,
          elapsedMs: result.elapsedMs
        }
      });
    }
    return recognition;
  };
}

export function recognitionFixtureDescriptor(): BundledPluginDescriptor {
  return {
    manifest: recognitionFixtureManifest,
    options: {
      commandHandlers: { [RECOGNITION_FIXTURE_COMMAND_ID]: createRecognitionFixtureCommandHandler() }
    }
  };
}

async function showMessage(context: Parameters<PluginCommandHandler>[0], body: string): Promise<void> {
  const report: PluginPanelReport = { title: RECOGNITION_FIXTURE_TITLE, sections: [{ kind: "text", body }] };
  await context.panels?.showReport(RECOGNITION_FIXTURE_PANEL_ID, report);
}
