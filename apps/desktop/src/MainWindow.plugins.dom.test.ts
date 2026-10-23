// @vitest-environment jsdom
import { PluginPanelReportSchema, type PluginCommandContext, type PluginPanelReport } from "@chemdraft/plugin-api";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MainWindow } from "./MainWindow";
import { DOM_COMMAND_EVENT } from "./window-manager";
import type { DesktopPluginRuntime } from "./plugins/createPluginRuntime";
import {
  PLUGIN_PANEL_ACTION_EVENT,
  requestPluginPanelAction,
  type PluginPanelActionResult
} from "./plugins/panelBridge";
import * as panelBridge from "./plugins/panelBridge";
import type { PluginPanelActionRequest } from "./plugins/pluginPanelActionTypes";
import {
  createFixturePluginOptions, fixturePluginManifest, FIXTURE_PLUGIN_CHAT_COMMAND_ID,
  FIXTURE_PLUGIN_CHAT_PANEL_ID, FIXTURE_PLUGIN_CLEAR_COMMAND_ID, FIXTURE_PLUGIN_SUBMIT_COMMAND_ID
} from "./plugins/fixturePlugin";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
const captured = vi.hoisted(() => ({ runtime: undefined as DesktopPluginRuntime | undefined }));
vi.mock("./plugins/createPluginRuntime", async original => {
  const actual = await original<typeof import("./plugins/createPluginRuntime")>();
  return { ...actual, createPluginRuntime: (options: import("./plugins/createPluginRuntime").DesktopPluginRuntimeOptions) => {
    captured.runtime = actual.createPluginRuntime(options);
    return captured.runtime;
  } };
});

const pluginId = "org.chemdraft.panelInputTest";
const panelId = "panel.panelInputTest.chat";
const openId = "plugin.panelInputTest.open";
const submitId = "plugin.panelInputTest.submit";
const stopId = "plugin.panelInputTest.stop";
const disabledId = "plugin.panelInputTest.disabled";
const foreignId = "plugin.otherPanelInput.run";
const submit = vi.fn<(context: PluginCommandContext) => Promise<void>>();
const stop = vi.fn<(context: PluginCommandContext) => Promise<void>>();
const disabled = vi.fn();
let report: PluginPanelReport;
let root: Root;
let container: HTMLDivElement;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

async function showReport(next: PluginPanelReport): Promise<void> {
  report = next;
  await act(async () => { await captured.runtime!.invokeCommand(openId); });
}

async function action(request: PluginPanelActionRequest): Promise<PluginPanelActionResult> {
  let result!: PluginPanelActionResult;
  await act(async () => { result = await requestPluginPanelAction({ panelId, ...request }); });
  return result;
}

describe("MainWindow panel input dispatch", () => {
  beforeEach(async () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    HTMLElement.prototype.setPointerCapture ??= () => {};
    HTMLElement.prototype.releasePointerCapture ??= () => {};
    HTMLElement.prototype.hasPointerCapture ??= () => false;
    submit.mockReset().mockResolvedValue(undefined);
    stop.mockReset().mockResolvedValue(undefined);
    disabled.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialPaletteMode: "hidden", initialRulersVisible: false, nativePalette: false
      }));
    });
    await act(async () => {
      captured.runtime!.registerPlugin({
        id: pluginId, name: "Panel input test", version: "0.1.0", apiVersion: "^0.1.10",
        entry: "test.js", permissions: ["ui.panel"], contributes: {
          commands: [
            { id: openId, title: "Open" }, { id: submitId, title: "Send" },
            { id: stopId, title: "Stop" }, { id: disabledId, title: "Disabled", enabled: false }
          ],
          panels: [{ id: panelId, title: "Chat", commandId: openId, preferredWindowSize: { width: 440, height: 620 } }]
        }
      }, { commandHandlers: {
        [openId]: context => context.panels!.showReport(panelId, report),
        [submitId]: submit, [stopId]: stop, [disabledId]: disabled
      } });
    });
    await showReport(PluginPanelReportSchema.parse({ title: "Chat", sections: [
      { kind: "prompt", id: "message", commandId: submitId, maxLength: 50 },
      { kind: "actions", id: "actions", buttons: [
        { id: "stop", label: "Stop", commandId: stopId, payload: { trusted: true } },
        { id: "disabled", label: "Disabled", commandId: disabledId }
      ] }
    ] }));
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    captured.runtime = undefined;
    Reflect.deleteProperty(window, "__TAURI__");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("delivers prompt input through the owning command context", async () => {
    expect(await action({ sectionId: "message", control: "prompt", text: "Draw aspirin" })).toEqual({ ok: true });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]![0].input).toEqual({
      source: "panel", panelId, sectionId: "message", control: "prompt", text: "Draw aspirin"
    });
  });

  it("accepts a pending submit immediately and runs Stop alongside it using trusted button data", async () => {
    let finish!: () => void;
    submit.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    try {
      expect(await action({ sectionId: "message", control: "prompt", text: "Long request" })).toEqual({ ok: true });
      // An extra command id/payload in the webview message cannot redirect the invocation.
      expect(await action({ sectionId: "actions", control: "button", controlId: "stop",
        commandId: foreignId, payload: { trusted: false } } as PluginPanelActionRequest)).toEqual({ ok: true });
      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop.mock.calls[0]![0].input).toEqual({
        source: "panel", panelId, sectionId: "actions", control: "button", controlId: "stop", payload: { trusted: true }
      });
    } finally {
      await act(async () => { finish?.(); });
    }
  });

  it("refuses unknown sections, disabled controls, and commands currently disabled in the registry", async () => {
    expect(await action({ sectionId: "missing", control: "prompt", text: "No" })).toEqual({ ok: false, reason: 'Unknown panel section "missing".' });
    expect(await action({ sectionId: "actions", control: "button", controlId: "disabled" })).toEqual({ ok: false, reason: "This command is disabled." });
    await showReport(PluginPanelReportSchema.parse({ title: "Disabled", sections: [
      { kind: "prompt", id: "message", commandId: submitId, disabled: true },
      { kind: "actions", id: "actions", buttons: [{ id: "stop", label: "Stop", commandId: stopId, disabled: true }] }
    ] }));
    expect(await action({ sectionId: "message", control: "prompt", text: "No" })).toEqual({ ok: false, reason: "This prompt is disabled." });
    expect(await action({ sectionId: "actions", control: "button", controlId: "stop" })).toEqual({ ok: false, reason: "This action button is disabled." });
    expect(submit).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(disabled).not.toHaveBeenCalled();
  });

  it("refuses a report control naming another plugin's command", async () => {
    const foreign = vi.fn();
    await act(async () => {
      captured.runtime!.registerPlugin({ id: "org.chemdraft.otherPanelInput", name: "Other", version: "0.1.0",
        apiVersion: "^0.1.10", entry: "test.js", permissions: [],
        contributes: { commands: [{ id: foreignId, title: "Other command" }] }
      }, { commandHandlers: { [foreignId]: foreign } });
      // Bypass the host's report ownership gate to exercise MainWindow's independent boundary.
      captured.runtime!.panels.showReport(pluginId, panelId, PluginPanelReportSchema.parse({ title: "Forged", sections: [
        { kind: "prompt", id: "message", commandId: foreignId }
      ] }));
    });
    expect(await action({ sectionId: "message", control: "prompt", text: "No" })).toEqual({ ok: false, reason: "This command is not owned by the panel's plugin." });
    expect(foreign).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
  });

  it("uses the latest displayed limits and refuses actions after the panel closes", async () => {
    await showReport(PluginPanelReportSchema.parse({ title: "Updated", sections: [
      { kind: "prompt", id: "message", commandId: submitId, maxLength: 2 }
    ] }));
    expect(await action({ sectionId: "message", control: "prompt", text: "Too long" })).toEqual({ ok: false, reason: "Text exceeds the 2-character limit." });
    await act(async () => { captured.runtime!.panels.closePanel(); });
    expect(await action({ sectionId: "message", control: "prompt", text: "No" })).toEqual({ ok: false, reason: "This panel is no longer open." });
    expect(submit).not.toHaveBeenCalled();
  });

  it("dispatches detached input against the retained report and rejects ambiguous panel owners", async () => {
    await act(async () => { captured.runtime!.panels.detachPanel(pluginId, panelId); });
    expect(await action({ sectionId: "message", control: "prompt", text: "Detached" })).toEqual({ ok: true });
    expect(submit.mock.calls[0]![0].input?.text).toBe("Detached");
    await act(async () => {
      captured.runtime!.registerPlugin({ id: "org.chemdraft.otherPanelInput", name: "Other", version: "0.1.0",
        apiVersion: "^0.1.10", entry: "test.js", permissions: ["ui.panel"],
        contributes: { commands: [{ id: foreignId, title: "Other command" }], panels: [{ id: panelId, title: "Other chat" }] }
      }, { commandHandlers: { [foreignId]: vi.fn() } });
      captured.runtime!.panels.showReport("org.chemdraft.otherPanelInput", panelId, report);
    });
    expect(await action({ sectionId: "message", control: "prompt", text: "Ambiguous" })).toEqual({ ok: false, reason: "The panel owner is ambiguous." });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("registers once across re-renders and removes the listener on unmount", async () => {
    // Remount with the spies installed before MainWindow's subscription effect.
    await act(async () => { root.unmount(); });
    const listen = vi.spyOn(panelBridge, "listenForPluginPanelActions");
    const remove = vi.spyOn(window, "removeEventListener");
    await act(async () => {
      root = createRoot(container);
      root.render(createElement(MainWindow, { initialPaletteMode: "hidden", initialRulersVisible: false, nativePalette: false }));
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "document.new" } }));
    });
    expect(listen).toHaveBeenCalledTimes(1);
    await act(async () => { root.unmount(); });
    expect(remove.mock.calls.filter(([name]) => name === PLUGIN_PANEL_ACTION_EVENT)).toHaveLength(1);
    // Leave a live root for shared cleanup.
    root = createRoot(container);
  });

  it("passes preferred dimensions when opening a native panel", async () => {
    const open = vi.spyOn(panelBridge, "openPluginPanelWindow").mockResolvedValue();
    Reflect.set(window, "__TAURI__", {});
    await act(async () => { captured.runtime!.panels.detachPanel(pluginId, panelId); });
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ pluginId, panelId, width: 440, height: 620, focus: false }));
  });

  it("exercises the DEV chat fixture transcript and clear button", async () => {
    await act(async () => {
      // MainWindow already registers the DEV fixture; replace it with isolated transcript state.
      captured.runtime!.unregisterPlugin(fixturePluginManifest.id);
      captured.runtime!.registerPlugin(fixturePluginManifest, createFixturePluginOptions());
      await captured.runtime!.invokeCommand(FIXTURE_PLUGIN_CHAT_COMMAND_ID);
    });
    await act(async () => {
      expect(await requestPluginPanelAction({ panelId: FIXTURE_PLUGIN_CHAT_PANEL_ID,
        sectionId: "message", control: "prompt", text: "Hello fixture"
      })).toEqual({ ok: true });
    });
    expect(captured.runtime!.panels.getOpenPanel()?.report.sections[0]).toMatchObject({ kind: "text", body: "Hello fixture" });
    await act(async () => {
      expect(await requestPluginPanelAction({ panelId: FIXTURE_PLUGIN_CHAT_PANEL_ID,
        sectionId: "actions", control: "button", controlId: "clear"
      })).toEqual({ ok: true });
    });
    expect(captured.runtime!.panels.getOpenPanel()?.report.sections[0]).toMatchObject({ kind: "text", body: "Send a message to try panel input." });
    expect(fixturePluginManifest.contributes.commands.map(command => command.id)).toEqual(expect.arrayContaining([
      FIXTURE_PLUGIN_SUBMIT_COMMAND_ID, FIXTURE_PLUGIN_CLEAR_COMMAND_ID
    ]));
  });
});
