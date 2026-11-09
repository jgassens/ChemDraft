// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { applyPatches } from "@chemdraft/chem-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNativeArtLineGraphicObject, createPhase4Document, groupSelectedDocumentObjects, selectDocumentObjects } from "./documentWorkflow";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { getAssistantHistoryPort } from "./assistant/historyPort";
import { setReactionArrowConditions } from "@chemdraft/document-workflow-core";
import { MainWindow } from "./MainWindow";
import { saveCompoundLayoutSettings } from "./compoundLayoutSettings";
import { broadcastCompoundLayoutSettings, DOM_COMMAND_EVENT } from "./window-manager";
import { MemoryStorage } from "./testSupport/memoryStorage";
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  saveCompoundLayoutSettings({ enabled: true, formattedReactionConditions: true });
  window.history.replaceState(null, "", "/?agentBridge=1");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__; vi.unstubAllGlobals(); });
const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot().document;
const route = async (commandId: string) => { await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } }))); };
async function mount(grouped = false, withConditions = false) {
  let document = createPhase4Document("Conditions drawing");
  const arrow = createNativeArtLineGraphicObject(document, { x: 100, y: 250 }, { x: 340, y: 250 }, "tool.art.reactionArrow")!;
  document = applyPatches(document, [{ op: "addObject", pageId: document.pages[0].id, object: arrow }]);
  if (grouped) {
    document = applyPatches(document, [{ op: "addObject", pageId: document.pages[0].id,
      object: { id: "box", type: "graphic", graphicKind: "rect", x: 100, y: 300, width: 50, height: 30, rotation: 0, style: {}, data: {} } }]);
    document = groupSelectedDocumentObjects(selectDocumentObjects(document, document.pages[0].id, [arrow.id, "box"]));
  }
  if (withConditions) document = setReactionArrowConditions(document, arrow.id, { side: "above", spans: [{ text: "THF", script: "normal" }] });
  await act(async () => root.render(createElement(MainWindow, { initialDocument: document, initialActiveToolCommandId: "tool.select", nativePalette: false,
    initialRulersVisible: false, initialCrosshairsVisible: false, initialPaletteMode: "floating" })));
  return arrow.id;
}
async function menu(id: string) {
  const target = container.querySelector<SVGElement>(`[data-object-id="${id}"]`)!;
  await act(async () => target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 150, clientY: 250 })));
}
it.each([false, true])("removes browser conditions commands including a grouped arrow (%s)", async grouped => {
  const id = await mount(grouped);
  await menu(id);
  const before = snapshot();
  expect(container.querySelector("[data-command-id=\"arrow.conditions\"]")).toBeNull();
  await route("arrow.conditions");
  expect(container.querySelector(".reaction-conditions-form")).toBeNull();
  expect(container.querySelector(".reaction-conditions-browser-window")).toBeNull();
  expect(snapshot()).toEqual(before);
});

it("keeps existing conditions painted and attached with browser authoring removed", async () => {
  const id = await mount(false, true);
  const label = snapshot().pages[0].objects.find(object => object.type === "text")!;
  const visual = container.querySelector(`[data-page-svg-object-visual="${label.id}"] text`)!;
  expect(visual.textContent).toBe("THF");
  const calls = vi.spyOn(CommandRegistry.prototype, "invoke");
  try {
    await act(async () => visual.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })));
    expect(container.querySelector(".reaction-conditions-form")).toBeNull();
    expect(calls).not.toHaveBeenCalledWith("arrow.conditions");
  } finally { calls.mockRestore(); }
  const port = getAssistantHistoryPort();
  const { moveDocumentObjects, normalizeCommittedDocument } = await import("./documentWorkflow");
  await act(async () => port.push("initial", port.read("initial")!, normalizeCommittedDocument(
    moveDocumentObjects(port.read("initial")!, [id], 20, 30)), "Move arrow"));
  const after = snapshot().pages[0].objects.find(object => object.id === label.id)!;
  expect(after.x).toBeCloseTo(label.x + 20);
  expect(after.y).toBeCloseTo(label.y + 30);
  expect(container.querySelector(`[data-page-svg-object-visual="${label.id}"] text`)?.textContent).toBe("THF");
  await act(async () => broadcastCompoundLayoutSettings({ enabled: true, formattedReactionConditions: false }));
  await menu(id);
  expect(container.querySelector("[data-command-id=\"arrow.conditions\"]")).toBeNull();
  expect(snapshot().pages[0].objects.find(object => object.id === label.id)).toEqual(after);
});

it("does not create conditions by double-clicking a bare ordinary arrow", async () => {
  const id = await mount();
  const target = container.querySelector(`[data-object-id="${id}"]`)!;
  await act(async () => target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })));
  expect(container.querySelector(".reaction-conditions-form")).toBeNull();
  expect(snapshot().pages[0].objects).toHaveLength(1);
});
