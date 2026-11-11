// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyAnalysisRun } from "@chemdraft/analysis-core";
import { sourceInterpretation } from "@chemdraft/rdkit-adapter/constants";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeSingleBondMolecule, selectDocumentObjects } from "./documentWorkflow";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { ANALYSIS_WINDOW_OWNER_ID, MOLECULAR_INSPECTOR_WINDOW_ID, PLUGIN_PANEL_WINDOW_CLOSED_EVENT,
  PLUGIN_PANEL_REQUEST_EVENT, pluginPanelWindowLabel } from "./plugins/panelBridge";

const host = vi.hoisted(() => ({ analyze: vi.fn(), open: vi.fn(), publish: vi.fn(), cancel: vi.fn() }));
vi.mock("./analysisClient", () => ({ analysisClient: () => ({ analyze: host.analyze, cancel: host.cancel }) }));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("./window-manager", async original => ({ ...await original<typeof import("./window-manager")>(), isDesktopRuntime: () => true }));
vi.mock("./plugins/panelBridge", async original => ({ ...await original<typeof import("./plugins/panelBridge")>(),
  openPluginPanelWindow: host.open, broadcastAnalysisWindowSnapshot: host.publish }));

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  host.open.mockResolvedValue(undefined); host.publish.mockResolvedValue(undefined);
  host.analyze.mockImplementation(async (_slot, spec) => emptyAnalysisRun({ runId: crypto.randomUUID(),
    startedAt: "2026-11-10T00:00:00Z", interpretation: sourceInterpretation(spec.format, spec.value), status: "unsupported",
    warnings: [{ code: "test.unsupported", severity: "info", message: "Test result", affectedResultIds: [] }] }));
  window.history.replaceState(null, "", "/?agentBridge=1");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); delete window.__CHEMDRAFT_AGENT__;
  window.history.replaceState(null, "", "/");
});
async function command(id: string) { await act(async () => { await window.__CHEMDRAFT_AGENT__!.command(id); }); }
describe.each(["MacIntel", "Win32"])("inspector selection (%s)", platform => {
  it("analyzes a selection made after opening, then follows document edits without reopening", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    const inserted = insertNativeSingleBondMolecule(createPhase4Document("Inserted structure"), { x: 300, y: 300 });
    const initialDocument = selectDocumentObjects(inserted, inserted.pages[0]!.id, []);
    await act(async () => root.render(createElement(MainWindow, { initialDocument, initialActiveToolCommandId: "tool.select",
      initialPaletteMode: "hidden", initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: true })));
    await command("analyze.molecularProperties");
    expect(host.analyze).not.toHaveBeenCalled();
    await command("edit.selectAll");
    expect(host.analyze).toHaveBeenCalledTimes(1);
    expect(host.publish.mock.calls.at(-1)?.[0]).toMatchObject({ pluginId: ANALYSIS_WINDOW_OWNER_ID,
      panelId: MOLECULAR_INSPECTOR_WINDOW_ID, content: { kind: "molecularInspector", busy: false, stale: false, report: expect.any(Object) } });
    await command("edit.deleteHoveredNativeTarget");
    await command("edit.undo");
    expect(host.analyze).toHaveBeenCalledTimes(2);
    expect(host.open).toHaveBeenCalledTimes(1);
    await act(async () => window.dispatchEvent(new CustomEvent(PLUGIN_PANEL_WINDOW_CLOSED_EVENT,
      { detail: pluginPanelWindowLabel({ pluginId: ANALYSIS_WINDOW_OWNER_ID, panelId: MOLECULAR_INSPECTOR_WINDOW_ID }) })));
    await command("edit.deleteHoveredNativeTarget");
    await command("edit.undo");
    expect(host.analyze).toHaveBeenCalledTimes(2);
  });

  it("publishes and replays the current analysis when opened immediately after insertion", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    const initialDocument = insertNativeSingleBondMolecule(createPhase4Document("Selected insertion"), { x: 300, y: 300 });
    await act(async () => root.render(createElement(MainWindow, { initialDocument, initialActiveToolCommandId: "tool.select",
      initialPaletteMode: "hidden", initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: true })));
    await command("analyze.molecularProperties");
    expect(host.analyze).toHaveBeenCalledTimes(1);
    host.publish.mockClear();
    await act(async () => window.dispatchEvent(new CustomEvent(PLUGIN_PANEL_REQUEST_EVENT,
      { detail: { pluginId: ANALYSIS_WINDOW_OWNER_ID, panelId: MOLECULAR_INSPECTOR_WINDOW_ID } })));
    expect(host.publish.mock.calls.at(-1)?.[0]).toMatchObject({ content: { kind: "molecularInspector", busy: false,
      stale: false, report: expect.any(Object) } });
  });
});
