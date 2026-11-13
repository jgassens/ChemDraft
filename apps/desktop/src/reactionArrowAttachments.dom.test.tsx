// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { applyPatches } from "@chemdraft/chem-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNativeArtLineGraphicObject, createNativeSingleBondMolecule, createPhase4Document, groupSelectedDocumentObjects, selectDocumentObjects } from "./documentWorkflow";
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
async function mount(grouped = false, withConditions = false, withMolecule = false) {
  let document = createPhase4Document("Conditions drawing");
  const arrow = createNativeArtLineGraphicObject(document, { x: 100, y: 250 }, { x: 340, y: 250 }, "tool.art.reactionArrow")!;
  document = applyPatches(document, [{ op: "addObject", pageId: document.pages[0].id, object: arrow }]);
  if (withMolecule) document = applyPatches(document, [{ op: "addObject", pageId: document.pages[0].id,
    object: createNativeSingleBondMolecule(document, { x: 150, y: 400 }) }]);
  if (grouped) {
    document = applyPatches(document, [{ op: "addObject", pageId: document.pages[0].id,
      object: { id: "box", type: "graphic", graphicKind: "rect", x: 100, y: 300, width: 50, height: 30, rotation: 0, style: {}, data: {} } }]);
    document = groupSelectedDocumentObjects(selectDocumentObjects(document, document.pages[0].id, [arrow.id, "box"]));
  }
  if (withConditions) document = setReactionArrowConditions(document, arrow.id, { side: "above", spans: [{ text: "THF", script: "normal" }] });
  if (withMolecule) document = selectDocumentObjects(document, document.pages[0].id,
    [document.pages[0].objects.find(object => object.type === "molecule")!.id]);
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

it.each(["molecule", "arrow"] as const)("moves a %s through all drag frames on a page with conditions, as one undo", async kind => {
  const arrowId = await mount(false, true, true);
  const original = snapshot().pages[0].objects.find(object => kind === "molecule" ? object.type === "molecule" : object.id === arrowId)!;
  const page = container.querySelector<HTMLElement>(".page")!;
  page.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) });
  for (const element of container.querySelectorAll("*")) {
    element.setPointerCapture = () => {}; element.releasePointerCapture = () => {}; element.hasPointerCapture = () => false;
  }
  const target = container.querySelector(`[data-page-svg-object-visual="${original.id}"], [data-object-id="${original.id}"]`)!;
  const start = original.type === "molecule" ? { x: (original.atoms[0]!.x + original.atoms[1]!.x) / 2,
    y: (original.atoms[0]!.y + original.atoms[1]!.y) / 2 } : { x: 220, y: 250 };
  async function pointer(type: string, dx: number, dy: number) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
      buttons: type === "pointerup" ? 0 : 1, clientX: start.x + dx, clientY: start.y + dy });
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
    await act(async () => (container.querySelector(`[data-page-svg-object-visual="${original.id}"], [data-object-id="${original.id}"]`) ?? target).dispatchEvent(event));
  }
  expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
  await pointer("pointerdown", 0, 0);
  await pointer("pointermove", 10, 10);
  await pointer("pointermove", 20, 20);
  await pointer("pointermove", 30, 40);
  await pointer("pointerup", 30, 40);
  const moved = snapshot().pages[0].objects.find(object => object.id === original.id)!;
  expect(moved.x).toBeCloseTo(original.x + 30);
  expect(moved.y).toBeCloseTo(original.y + 40);
  expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("true");
  await route("edit.undo");
  expect(snapshot().pages[0].objects.find(object => object.id === original.id)).toEqual(original);
  expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
});

it.each(["molecule", "arrow"] as const)("cancels a %s drag on a page with conditions without history", async kind => {
  const arrowId = await mount(false, true, true);
  const original = snapshot().pages[0].objects.find(object => kind === "molecule" ? object.type === "molecule" : object.id === arrowId)!;
  const page = container.querySelector<HTMLElement>(".page")!;
  page.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) });
  for (const element of container.querySelectorAll("*")) {
    element.setPointerCapture = () => {}; element.releasePointerCapture = () => {}; element.hasPointerCapture = () => false;
  }
  const target = container.querySelector(`[data-page-svg-object-visual="${original.id}"], [data-object-id="${original.id}"]`)!;
  const start = original.type === "molecule" ? { x: (original.atoms[0]!.x + original.atoms[1]!.x) / 2,
    y: (original.atoms[0]!.y + original.atoms[1]!.y) / 2 } : { x: 220, y: 250 };
  const frame = () => container.querySelector<HTMLElement>(`[data-object-id="${original.id}"]`)!;
  const originalLeft = parseFloat(frame().style.left), originalTop = parseFloat(frame().style.top);
  for (const [type, dx, dy] of [["pointerdown", 0, 0], ["pointermove", 10, 10], ["pointermove", 30, 40], ["pointercancel", 30, 40]] as const) {
    if (type === "pointercancel") {
      // The moved preview is rendered separately; the live document stays safe to save.
      expect(snapshot().pages[0].objects.find(object => object.id === original.id)).toEqual(original);
      expect(parseFloat(frame().style.left)).toBeCloseTo(originalLeft + 30 / snapshot().pages[0].width * 100);
      expect(parseFloat(frame().style.top)).toBeCloseTo(originalTop + 40 / snapshot().pages[0].height * 100);
    }
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === "pointercancel" ? 0 : 1,
      clientX: start.x + dx, clientY: start.y + dy });
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
    await act(async () => (container.querySelector(`[data-page-svg-object-visual="${original.id}"], [data-object-id="${original.id}"]`) ?? target).dispatchEvent(event));
  }
  expect(snapshot().pages[0].objects.find(object => object.id === original.id)).toEqual(original);
  expect(parseFloat(frame().style.left)).toBeCloseTo(originalLeft);
  expect(parseFloat(frame().style.top)).toBeCloseTo(originalTop);
  expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
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

it.each(["object", "page"])("labels dragging reaction conditions released on the %s and restores exact undo/redo states", async release => {
  await mount(false, true);
  const label = snapshot().pages[0].objects.find(object => object.type === "text")!;
  const page = container.querySelector<HTMLElement>(".page")!;
  page.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612,
    width: 792, height: 612, toJSON: () => ({}) });
  for (const element of container.querySelectorAll("*")) {
    element.setPointerCapture = () => {};
    element.releasePointerCapture = () => {};
    element.hasPointerCapture = () => false;
  }
  const target = container.querySelector(`[data-page-svg-object-visual="${label.id}"] text`)!;
  async function pointer(type: string, x: number, y: number) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
      buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y });
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
    const destination = type === "pointerup" && release === "page" ? page
      : container.querySelector(`[data-page-svg-object-visual="${label.id}"] text`) ?? target;
    await act(async () => destination.dispatchEvent(event));
  }
  await pointer("pointerdown", label.x + 5, label.y + 5);
  const before = snapshot();
  await pointer("pointermove", label.x + 15, label.y + 15);
  await pointer("pointermove", label.x + 25, label.y + 35);
  expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
  await pointer("pointerup", label.x + 25, label.y + 35);
  const after = snapshot();
  expect(after).not.toEqual(before);
  expect(container.querySelector("[data-status-message]")?.textContent).toBe("Moved selected object");
  await route("edit.undo");
  expect(container.querySelector("[data-status-message]")?.textContent).toBe("Undid Move Reaction Conditions");
  expect(snapshot()).toEqual(before);
  expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
  await route("edit.redo");
  expect(container.querySelector("[data-status-message]")?.textContent).toBe("Redid Move Reaction Conditions");
  expect(snapshot()).toEqual(after);
});
