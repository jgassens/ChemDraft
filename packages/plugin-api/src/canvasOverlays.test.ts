import { describe, expect, it } from "vitest";
import {
  dangerousPluginPermissions, pluginPermissions, PluginCanvasOverlayContributionSchema,
  PluginManifestSchema, PluginOverlayStatusRequestSchema, PluginPanelPromptSectionSchema
} from "./index";
import { PLUGIN_WORKER_CAPABILITY_METHODS } from "./workerProtocol";

const commandId = "plugin.chat.submit";
const prompt = { kind: "prompt", id: "composer", commandId };
const overlay = { id: "overlay.chat.main", title: "Chat", icon: "data:image/svg+xml;base64,PHN2Zy8+",
  commandId, prompt };
const manifest = {
  id: "org.test.chat", name: "Chat", version: "0", apiVersion: "^0.1.10", entry: "worker.js",
  permissions: ["ui.canvas"], contributes: { commands: [{ id: commandId, title: "Send" }], canvasOverlays: [overlay] }
};

describe("canvas overlay schemas", () => {
  it("reuses the panel prompt schema and supplies overlay defaults", () => {
    expect(PluginCanvasOverlayContributionSchema.shape.prompt).toBe(PluginPanelPromptSectionSchema);
    expect(PluginManifestSchema.parse(manifest).contributes.canvasOverlays).toEqual([{
      ...overlay, prompt: PluginPanelPromptSectionSchema.parse(prompt), defaultCorner: "bottom-right", requiredPermissions: []
    }]);
    for (const defaultCorner of ["bottom-right", "bottom-left", "top-right", "top-left"]) {
      expect(PluginCanvasOverlayContributionSchema.parse({ ...overlay, defaultCorner }).defaultCorner).toBe(defaultCorner);
    }
  });

  it("requires ui.canvas and at most one overlay", () => {
    expect(PluginManifestSchema.safeParse({ ...manifest, permissions: [] }).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...manifest, contributes: {
      ...manifest.contributes, canvasOverlays: [overlay, { ...overlay, id: "overlay.chat.second" }]
    } }).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...manifest, contributes: {
      ...manifest.contributes, canvasOverlays: [{ ...overlay, requiredPermissions: ["document.read"] }]
    } }).success).toBe(false);
    expect(PluginManifestSchema.parse({ ...manifest, contributes: {} }).contributes.canvasOverlays).toBeUndefined();
  });

  it.each(["command", "prompt", "select"])("refuses a foreign %s command", control => {
    const foreignId = "plugin.other.submit";
    const candidate = { ...overlay,
      ...(control === "command" ? { commandId: foreignId } : {}),
      prompt: { ...prompt, ...(control === "prompt" ? { commandId: foreignId } : {}),
        ...(control === "select" ? { select: { id: "provider", label: "Provider", value: "a",
          options: [{ value: "a", label: "A" }], commandId: foreignId } } : {}) }
    };
    expect(PluginManifestSchema.safeParse({ ...manifest, contributes: {
      ...manifest.contributes, canvasOverlays: [candidate]
    } }).success).toBe(false);
  });

  it.each([
    "", "https://example.com/icon.png", "data:image/jpeg;base64,YQ==", "data:image/png,YQ==",
    "data:image/png;base64,", "data:image/png;base64,abc", "data:image/png;base64,Y@==",
    "data:image/png;base64,YQ==\n", `data:image/png;base64,${"a".repeat(64000)}`
  ])("refuses invalid or oversized icon %#", icon => {
    expect(PluginCanvasOverlayContributionSchema.safeParse({ ...overlay, icon }).success).toBe(false);
  });

  it("bounds ids, titles, statuses and control ids", () => {
    expect(PluginCanvasOverlayContributionSchema.safeParse({ ...overlay, icon: "data:image/png;base64,YQ==" }).success).toBe(true);
    for (const invalid of [{ id: "panel.chat.main" }, { title: "" }, { title: "a".repeat(81) },
      { prompt: { ...prompt, select: { id: "composer", label: "Provider", value: "a", options: [{ value: "a", label: "A" }] } } }]) {
      expect(PluginManifestSchema.safeParse({ ...manifest, contributes: {
        ...manifest.contributes, canvasOverlays: [{ ...overlay, ...invalid }]
      } }).success).toBe(false);
    }
    for (const text of ["", "x".repeat(120)]) {
      expect(PluginOverlayStatusRequestSchema.parse({ overlayId: overlay.id, text }).text).toBe(text);
    }
    expect(PluginOverlayStatusRequestSchema.safeParse({ overlayId: overlay.id, text: "x".repeat(121) }).success).toBe(false);
  });

  it("exposes ui.canvas as non-dangerous and whitelists status and transcript updates", () => {
    expect(pluginPermissions).toContain("ui.canvas");
    expect(dangerousPluginPermissions as readonly string[]).not.toContain("ui.canvas");
    expect(PLUGIN_WORKER_CAPABILITY_METHODS.overlays).toEqual(["setStatus", "setTranscript"]);
  });
});
