import type { PluginPanelReport } from "@chemdraft/plugin-api";
import { describe, expect, it } from "vitest";

import { resolvePluginPanelAction } from "./pluginPanelActions";

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
