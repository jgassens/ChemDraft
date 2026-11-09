// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { applyPatches } from "@chemdraft/chem-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNativeArtLineGraphicObject, createPhase4Document, groupSelectedDocumentObjects, selectDocumentObjects } from "./documentWorkflow";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { getAssistantHistoryPort } from "./assistant/historyPort";
import { AssistantTransactions } from "./assistant/assistantTransaction";
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
async function mount(grouped = false) {
  let document = createPhase4Document("Conditions drawing");
  const arrow = createNativeArtLineGraphicObject(document, { x: 100, y: 250 }, { x: 340, y: 250 }, "tool.art.reactionArrow")!;
  document = applyPatches(document, [{ op: "addObject", pageId: document.pages[0].id, object: arrow }]);
  if (grouped) {
    document = applyPatches(document, [{ op: "addObject", pageId: document.pages[0].id,
      object: { id: "box", type: "graphic", graphicKind: "rect", x: 100, y: 300, width: 50, height: 30, rotation: 0, style: {}, data: {} } }]);
    document = groupSelectedDocumentObjects(selectDocumentObjects(document, document.pages[0].id, [arrow.id, "box"]));
  }
  await act(async () => root.render(createElement(MainWindow, { initialDocument: document, initialActiveToolCommandId: "tool.select", nativePalette: false,
    initialRulersVisible: false, initialCrosshairsVisible: false, initialPaletteMode: "floating" })));
  return arrow.id;
}
async function menu(id: string) {
  const target = container.querySelector<SVGElement>(`[data-object-id="${id}"]`)!;
  await act(async () => target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 150, clientY: 250 })));
}
async function clickCommand(id: string) {
  const button = container.querySelector<HTMLButtonElement>(`[role="menu"] [data-command-id="${id}"]`)!;
  expect(button).not.toBeNull(); expect(button.disabled).toBe(false);
  await act(async () => button.click());
}
function type(text: string) {
  const field = container.querySelector(".reaction-conditions-form textarea")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}
it("conditions Save commits once, Cancel does not edit, and double-click reopens its form", async () => {
  const id = await mount(); await menu(id); await clickCommand("arrow.conditions");
  expect(container.querySelector('.reaction-conditions-form')).not.toBeNull();
  await act(async () => type("K₂CO₃\n80 °C, 2 h"));
  const form = container.querySelector('form.reaction-conditions-form')!;
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(container.querySelector('.reaction-conditions-form')).toBeNull();
  const label = snapshot().pages[0].objects.find(object => object.type === "text")!;
  expect(label.type === "text" && label.text).toBe("K₂CO₃\n80 °C, 2 h");
  expect(snapshot().selection.objectIds).toEqual([label.id]);
  const target = container.querySelector<SVGElement>(`[data-page-svg-object-visual="${label.id}"] text`)!;
  await act(async () => target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })));
  expect(container.querySelector<HTMLTextAreaElement>('.reaction-conditions-form textarea')?.value).toBe("K₂CO₃\n80 °C, 2 h");
  await act(async () => type("changed"));
  const cancel = [...container.querySelectorAll<HTMLButtonElement>('.reaction-conditions-form button')].find(button => button.textContent === "Cancel")!;
  await act(async () => cancel.click());
  expect(snapshot().pages[0].objects.find(object => object.id === label.id)).toEqual(label);
  await route("edit.undo"); expect(snapshot().pages[0].objects).toHaveLength(1);
});

it("double-click invokes arrow.conditions and blank Save removes the label in one undo entry", async () => {
  const calls=vi.spyOn(CommandRegistry.prototype,"invoke");
  try {
    const id=await mount(); await menu(id); await clickCommand("arrow.conditions");
    await act(async()=>type("80 °C"));
    await act(async()=>container.querySelector("form.reaction-conditions-form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
    const label=snapshot().pages[0].objects.find(o=>o.type==="text")!;
    const target=container.querySelector('[data-page-svg-object-visual="'+label.id+'"] text')!;
    calls.mockClear();
    await act(async()=>target.dispatchEvent(new MouseEvent("dblclick",{bubbles:true,cancelable:true})));
    expect(calls).toHaveBeenCalledWith("arrow.conditions");
    await act(async()=>type(""));
    await act(async()=>container.querySelector("form.reaction-conditions-form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
    expect(snapshot().pages[0].objects).toHaveLength(1);
    await route("edit.undo");
    expect(snapshot().pages[0].objects.find(o=>o.type==="text")).toEqual(label);
  } finally {calls.mockRestore();}
});
it("keeps existing labels painted and moving while all authoring entry points are disabled", async () => {
  const id=await mount();await menu(id);await clickCommand("arrow.conditions");
  await act(async()=>type("THF"));
  await act(async()=>container.querySelector("form.reaction-conditions-form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
  const label=snapshot().pages[0].objects.find(o=>o.type==="text")!;
  await act(async()=>broadcastCompoundLayoutSettings({enabled:true,formattedReactionConditions:false}));
  await menu(id);expect(container.querySelector('[data-command-id="arrow.conditions"]')).toBeNull();
  await route("arrow.conditions");expect(container.querySelector(".reaction-conditions-form")).toBeNull();
  const visual=container.querySelector('[data-page-svg-object-visual="'+label.id+'"] text')!;
  expect(visual.textContent).toBe("THF");
  await act(async()=>visual.dispatchEvent(new MouseEvent("dblclick",{bubbles:true,cancelable:true})));
  expect(container.querySelector(".reaction-conditions-form")).toBeNull();
  const port=getAssistantHistoryPort();
  const {moveDocumentObjects,normalizeCommittedDocument}=await import("./documentWorkflow");
  await act(async()=>port.push("initial",port.read("initial")!,normalizeCommittedDocument(moveDocumentObjects(port.read("initial")!,[id],20,30)),"Move arrow"));
  const after=snapshot().pages[0].objects.find(o=>o.id===label.id)!;
  expect(after.x).toBeCloseTo(label.x+20);expect(after.y).toBeCloseTo(label.y+30);
  expect(container.querySelector('[data-page-svg-object-visual="'+label.id+'"] text')?.textContent).toBe("THF");
});
it("targets the right-clicked ordinary arrow inside a selected group", async () => {
  const id=await mount(true);await menu(id);await clickCommand("arrow.conditions");
  await act(async()=>type("hν"));
  await act(async()=>container.querySelector("form.reaction-conditions-form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
  expect(snapshot().pages[0].objects.find(o=>o.type==="text")?.arrowAttachment?.parentObjectId).toBe(id);
});
it("closes a disabled editor without editing and refuses a stale Save", async () => {
  const id=await mount();await menu(id);await clickCommand("arrow.conditions");
  const before=snapshot();await act(async()=>type("not saved"));
  await act(async()=>broadcastCompoundLayoutSettings({enabled:true,formattedReactionConditions:false}));
  expect(container.querySelector(".reaction-conditions-form")).toBeNull();expect(snapshot()).toEqual(before);
  await act(async()=>broadcastCompoundLayoutSettings({enabled:true,formattedReactionConditions:true}));
  await menu(id);await clickCommand("arrow.conditions");await act(async()=>type("stale"));
  const port=getAssistantHistoryPort();
  await act(async()=>port.push("initial",port.read("initial")!,applyPatches(port.read("initial")!,[{op:"updateObject",objectId:id,changes:{style:{strokeColor:"#abcdef"}}}]),"Recolor"));
  await act(async()=>container.querySelector("form.reaction-conditions-form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
  expect(container.textContent).toContain("Drawing changed");expect(snapshot().pages[0].objects).toHaveLength(1);
});
it("notifies assistant edits on inactive-tab Save so the next assistant write starts a new undo entry", async () => {
  const id=await mount(),port=getAssistantHistoryPort(),transactions=new AssistantTransactions(port);
  const notify=vi.fn(),stop=port.onUserEdit(notify),push=vi.spyOn(port,"push"),amend=vi.spyOn(port,"amend");
  try {
    const tx=transactions.beginAssistantTransaction({pluginId:"assistant",runId:"request",label:"Edit drawing",tabId:"initial",sendSelection:{objectIds:[id]}});
    await act(async()=>transactions.writeAssistantTransaction(tx,applyPatches(port.read("initial")!,[{op:"updateObject",objectId:id,changes:{style:{strokeColor:"#123456"}}}]),[id]));
    await menu(id);await clickCommand("arrow.conditions");await act(async()=>type("80 °C"));
    await route("document.new");notify.mockClear();push.mockClear();amend.mockClear();
    await act(async()=>container.querySelector("form.reaction-conditions-form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
    expect(notify).toHaveBeenCalledExactlyOnceWith("initial");
    const userState=port.read("initial")!;
    expect(userState.pages[0].objects.some(o=>o.type==="text")).toBe(true);
    expect(snapshot().pages[0].objects).toHaveLength(0);
    await act(async()=>transactions.writeAssistantTransaction(tx,applyPatches(userState,[{op:"updateObject",objectId:id,changes:{style:{strokeColor:"#654321"}}}]),[id]));
    expect(push).toHaveBeenCalledOnce();expect(amend).not.toHaveBeenCalled();
    expect(push.mock.calls[0][1]).toEqual(userState);
    expect(transactions.endAssistantTransaction(tx,{touchedIds:[id]}).split).toBe(true);
  } finally {stop();transactions.dispose();push.mockRestore();amend.mockRestore();}
});

it("does not create conditions by double-clicking a bare ordinary arrow",async()=>{
  const id=await mount();
  const target=container.querySelector('[data-object-id="'+id+'"]')!;
  await act(async()=>target.dispatchEvent(new MouseEvent("dblclick",{bubbles:true,cancelable:true})));
  expect(container.querySelector(".reaction-conditions-form")).toBeNull();
  expect(snapshot().pages[0].objects).toHaveLength(1);
});
