import type { PluginPanelReport } from "@chemdraft/plugin-api";
import { describe, expect, it } from "vitest";

import { isAnalysisWindowActionAuthorized, resolvePluginPanelAction } from "./pluginPanelActions";
import {
  ANALYSIS_WINDOW_OWNER_ID, MOLECULAR_INSPECTOR_WINDOW_ID, PATCH_REVIEW_WINDOW_ID,
  pluginPanelWindowLabel, type AnalysisWindowAction
} from "./panelBridge";

const panelId = "panel.example.chat";
const commands = new Set(["plugin.example.send", "plugin.example.changeProvider", "plugin.example.stop"]);
const report: PluginPanelReport = {
  title: "Assistant",
  sections: [
    {
      kind: "prompt",
      id: "composer",
      commandId: "plugin.example.send",
      maxLength: 5,
      rows: 3,
      submitLabel: "Send",
      disabled: false,
      select: {
        id: "provider",
        label: "Provider",
        value: "codex",
        options: [{ value: "codex", label: "Codex" }],
        commandId: "plugin.example.changeProvider"
      }
    },
    {
      kind: "actions",
      id: "controls",
      buttons: [
        { id: "stop", label: "Stop", commandId: "plugin.example.stop", payload: { stopped: true }, disabled: false, tone: "default" },
        { id: "disabled", label: "Disabled", commandId: "plugin.example.stop", disabled: true, tone: "default" }
      ]
    },
    { kind: "text", body: "A static result" }
  ]
};

describe("resolvePluginPanelAction", () => {
  it("resolves prompt, select, and button inputs from the live report", () => {
    expect(resolvePluginPanelAction(report, { panelId, sectionId: "composer", control: "prompt", text: "draw", selected: "codex" }, commands))
      .toEqual({ ok: true, commandId: "plugin.example.send", input: { source: "panel", panelId, sectionId: "composer", control: "prompt", text: "draw", selected: "codex" } });
    expect(resolvePluginPanelAction(report, { panelId, sectionId: "composer", control: "select", controlId: "provider", selected: "codex" }, commands))
      .toEqual({ ok: true, commandId: "plugin.example.changeProvider", input: { source: "panel", panelId, sectionId: "composer", control: "select", controlId: "provider", selected: "codex" } });
    expect(resolvePluginPanelAction(report, { panelId, sectionId: "controls", control: "button", controlId: "stop", text: "ignored" }, commands))
      .toEqual({ ok: true, commandId: "plugin.example.stop", input: { source: "panel", panelId, sectionId: "controls", control: "button", controlId: "stop", payload: { stopped: true } } });
  });

  it.each([
    [{ panelId, sectionId: "missing", control: "prompt", text: "x" }, commands],
    [{ panelId, sectionId: "composer", control: "button", controlId: "stop" }, commands],
    [{ panelId, sectionId: "controls", control: "prompt", text: "x" }, commands],
    [{ panelId, sectionId: "composer", control: "prompt", text: "too long" }, commands],
    [{ panelId, sectionId: "composer", control: "select", controlId: "provider", selected: "other" }, commands],
    [{ panelId, sectionId: "composer", control: "select", controlId: "other", selected: "codex" }, commands],
    [{ panelId, sectionId: "controls", control: "button", controlId: "missing" }, commands],
    [{ panelId, sectionId: "controls", control: "button", controlId: "disabled" }, commands],
    [{ panelId, sectionId: "composer", control: "prompt", text: "draw" }, new Set<string>()]
  ] as const)("refuses untrusted or unavailable input", (request, owner) => {
    expect(resolvePluginPanelAction(report, request, owner)).toMatchObject({ ok: false });
  });

  it("refuses a disabled prompt section", () => {
    const disabled = { ...report, sections: [{ ...report.sections[0]!, disabled: true }] } as PluginPanelReport;
    expect(resolvePluginPanelAction(disabled, { panelId, sectionId: "composer", control: "prompt", text: "draw" }, commands))
      .toMatchObject({ ok: false });
  });
});

describe("analysis window action ownership", () => {
  type Owner = NonNullable<Parameters<typeof isAnalysisWindowActionAuthorized>[2]>;
  const inspector: Owner = {
    pluginId: ANALYSIS_WINDOW_OWNER_ID, panelId: MOLECULAR_INSPECTOR_WINDOW_ID,
    content: { kind: "molecularInspector", busy: false, stale: false }
  };
  const proposals: Owner = {
    pluginId: ANALYSIS_WINDOW_OWNER_ID, panelId: PATCH_REVIEW_WINDOW_ID,
    content: { kind: "patchReview", proposals: [{ id: "proposal-1", pluginId: "org.example", pluginName: "Example", reason: "Insert", warnings: [] }] }
  };
  const figure: Owner = {
    pluginId: "org.example", panelId: "panel.example.result",
    content: { kind: "report", report: { title: "Spectrum", sections: [{
      kind: "linkedFigure", spectrum: { nucleus: "13C", domain: { min: 0, max: 200 }, peaks: [] }
    }] } }
  };
  const cases: { action: AnalysisWindowAction; owner: Owner }[] = [
    { action: { kind: "close", windowId: MOLECULAR_INSPECTOR_WINDOW_ID }, owner: inspector },
    { action: { kind: "copyMolecularInspector", text: "C6H6" }, owner: inspector },
    { action: { kind: "changeMolecularInterpretation", interpretationId: "drawn" }, owner: inspector },
    { action: { kind: "acceptPluginProposal", proposalId: "proposal-1" }, owner: proposals },
    { action: { kind: "rejectPluginProposal", proposalId: "proposal-1" }, owner: proposals },
    { action: { kind: "copySpectrum", requestId: "copy" }, owner: figure },
    { action: { kind: "saveBinaryFile", requestId: "png" }, owner: figure },
    { action: { kind: "saveTextFile", requestId: "svg" }, owner: figure }
  ];

  it.each(cases)("accepts $action.kind only from its rightful window", ({ action, owner }) => {
    expect(isAnalysisWindowActionAuthorized(action, pluginPanelWindowLabel(owner), owner)).toBe(true);
    const other = { ...owner, panelId: `${owner.panelId}.other` };
    expect(isAnalysisWindowActionAuthorized(action, pluginPanelWindowLabel(other), owner)).toBe(false);
    expect(isAnalysisWindowActionAuthorized(action, pluginPanelWindowLabel(owner), undefined)).toBe(false);
  });

  it.each(cases)("refuses $action.kind when the source has unrelated content", ({ action, owner }) => {
    const unrelated: Owner = { ...owner, content: { kind: "pluginDiagnostics", plugins: [], diagnostics: [] } };
    const changed = action.kind === "close" ? { ...action, windowId: "another-window" } : action;
    expect(isAnalysisWindowActionAuthorized(changed, pluginPanelWindowLabel(unrelated), unrelated)).toBe(false);
  });

  it("keeps chemical-name report copies and binds proposal ids to the displayed queue", () => {
    const name: Owner = { ...figure, content: { kind: "report", report: { title: "Name", sections: [] } } };
    expect(isAnalysisWindowActionAuthorized({ kind: "copyMolecularInspector", text: "ethanol" }, pluginPanelWindowLabel(name), name)).toBe(true);
    for (const kind of ["acceptPluginProposal", "rejectPluginProposal"] as const) {
      expect(isAnalysisWindowActionAuthorized({ kind, proposalId: "unseen" }, pluginPanelWindowLabel(proposals), proposals)).toBe(false);
      const impostor = { ...proposals, pluginId: "org.example" };
      expect(isAnalysisWindowActionAuthorized({ kind, proposalId: "proposal-1" }, pluginPanelWindowLabel(impostor), impostor)).toBe(false);
    }
  });
});
