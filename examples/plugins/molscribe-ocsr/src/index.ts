import type {
  PluginCommandHandler,
  PluginImageRequestResult,
  PluginManifest,
  PluginPanelReport
} from "@chemdraft/plugin-api";

export const molscribeOcsrCommandId = "plugin.molscribeOcsr.recognizeImage";
export const molscribeOcsrPanelId = "panel.molscribeOcsr.review";
export const molscribeOcsrRecognizerId = "recognizer.molscribeOcsr.image";

export const molscribeOcsrManifest: PluginManifest = {
  id: "org.chemdraft.ocsr.molscribe",
  name: "MolScribe OCSR",
  version: "0.0.0",
  apiVersion: "^0.1.5",
  description: "Image-input scaffold for a future optional MolScribe OCSR integration.",
  entry: "dist/plugin.js",
  permissions: ["image.read", "ui.menu", "ui.panel"],
  contributes: {
    commands: [
      {
        id: molscribeOcsrCommandId,
        title: "Recognize Structure from Image",
        category: "Tools",
        description: "Choose an image for the optional MolScribe OCSR integration.",
        requiredPermissions: ["image.read", "ui.panel"],
        enabled: true
      }
    ],
    menus: [
      {
        id: "menu.molscribeOcsr.recognizeImage",
        title: "Recognize Structure from Image",
        commandId: molscribeOcsrCommandId,
        location: "analyze",
        requiredPermissions: ["ui.menu"]
      }
    ],
    panels: [
      {
        id: molscribeOcsrPanelId,
        title: "MolScribe OCSR",
        commandId: molscribeOcsrCommandId,
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
        id: molscribeOcsrRecognizerId,
        title: "MolScribe OCSR Image Recognizer",
        input: "selected-image",
        commandId: molscribeOcsrCommandId,
        requiredPermissions: ["image.read"]
      }
    ]
  }
};

/** The scaffold acquires a real user-selected image but deliberately performs no recognition. */
export function createMolScribeOcsrCommandHandler(): PluginCommandHandler<PluginImageRequestResult> {
  return async (context) => {
    context.requirePermission("image.read");
    context.requirePermission("ui.panel");
    const result = await context.images!.requestImage({
      title: "Recognize Structure from Image"
    });

    if (result.status === "cancelled") return result;
    if (result.status === "unavailable") {
      await context.panels?.showReport(molscribeOcsrPanelId, {
        title: "MolScribe OCSR",
        sections: [{ kind: "text", body: `Image input is unavailable: ${result.reason}` }]
      });
      return result;
    }

    const report: PluginPanelReport = {
      title: "MolScribe OCSR",
      sections: [
        {
          kind: "text",
          body:
            `No recognition engine is installed yet — the image was received ` +
            `(${result.image.width}×${result.image.height}, ${result.image.source}) but cannot be converted to a structure.`
        }
      ]
    };
    await context.panels?.showReport(molscribeOcsrPanelId, report);
    return result;
  };
}
