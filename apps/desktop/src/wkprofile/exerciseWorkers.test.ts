import { expect, it } from "vitest";
import { PluginHost } from "@chemdraft/plugin-host";
import { massAnalyzeCommandId, massFragmentPanelId } from "@chemdraft/plugin-mass-fragment";
import { createMassFragmentExerciseManifest } from "./exerciseWorkers";

it("builds a valid mass-fragment exercise manifest with unique permissions and ui.panel", () => {
  const manifest = createMassFragmentExerciseManifest();
  expect(new Set(manifest.permissions).size).toBe(manifest.permissions.length);
  expect(manifest.permissions).toContain("ui.panel");
  expect(manifest.contributes.panels.some(panel => panel.id === massFragmentPanelId)).toBe(true);

  const host = new PluginHost({ getSelection: () => ({ objectIds: [], molecules: [] }), showPanelReport: async () => {} });
  host.registerPlugin(manifest, { commandHandlers: { [massAnalyzeCommandId]: async context => {
    expect(context.panels).toBeDefined();
    return { ok: true };
  } } });
});
