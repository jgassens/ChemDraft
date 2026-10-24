// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { applyPatches } from "@chemdraft/chem-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNativeArtLineGraphicObject, createPhase4Document, groupSelectedDocumentObjects, selectDocumentObjects } from "./documentWorkflow";
import { MainWindow } from "./MainWindow";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { MemoryStorage } from "./testSupport/memoryStorage";
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
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
  if(id.startsWith('arrow.attachOffshoot.')&&!container.querySelector(`[data-command-id="${id}"]`)) {
    await act(async()=>container.querySelector<HTMLButtonElement>('[data-context-submenu="offshoot"]')!.click());
  }
  const button = container.querySelector<HTMLButtonElement>(`[role="menu"] [data-command-id="${id}"]`)!;
  expect(button).not.toBeNull(); expect(button.disabled).toBe(false);
  await act(async () => button.click());
}
it("right-click attaches an offshoot, and one Undo/Redo removes/restores it", async () => {
  const id = await mount(); await menu(id);
  expect(container.textContent).toContain("Attach offshoot");
  expect(container.querySelector('[data-command-id="arrow.attachOffshoot.above"]')).toBeNull();
  await clickCommand("arrow.attachOffshoot.above");
  expect(snapshot().pages[0].objects).toHaveLength(2);
  const branch = snapshot().pages[0].objects[1];
  expect(branch.arrowAttachment?.parentObjectId).toBe(id);
  expect(snapshot().selection.objectIds).toEqual([branch.id]);
  await route("edit.undo"); expect(snapshot().pages[0].objects).toHaveLength(1);
  await route("edit.redo"); expect(snapshot().pages[0].objects).toHaveLength(2);
});
it('navigates the single offshoot submenu and invokes Full curve once with the exact grouped target',async()=>{
  const id=await mount(true);await menu(id);
  const owner=container.querySelector<HTMLButtonElement>('[data-context-submenu="offshoot"]')!;
  expect(owner.getAttribute('aria-controls')).toBeNull();
  await act(async()=>{owner.focus();owner.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));});
  const submenu=container.querySelector('[aria-label="Attach offshoot"][role="menu"]')!;
  expect(owner.getAttribute('aria-controls')).toBe(submenu.id);
  expect(document.activeElement?.getAttribute('data-command-id')).toBe('arrow.attachOffshoot.above');
  for(let i=0;i<2;i++)await act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true})));
  expect(document.activeElement?.getAttribute('data-command-id')).toBe('arrow.attachOffshoot.fullCurve.above');
  const count=snapshot().pages[0].objects.length;
  await act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})));
  expect(snapshot().pages[0].objects).toHaveLength(count+1);
  const branch=snapshot().pages[0].objects.at(-1)!;
  expect(branch.arrowAttachment).toMatchObject({kind:'offshoot',parentObjectId:id,mode:'fullCurve'});
  expect(container.querySelector('[data-graphic-path-handle="start"]')).not.toBeNull();
  expect(container.querySelector('[data-graphic-path-handle="end"]')).not.toBeNull();
  expect(container.querySelector('[data-graphic-path-handle="middle"]')).toBeNull();
  expect(container.querySelector('[data-graphic-path-handle="tether"]')).not.toBeNull();
  await route('edit.undo');expect(snapshot().pages[0].objects).toHaveLength(count);
  await route('edit.redo');expect(snapshot().pages[0].objects.at(-1)).toEqual(branch);
});
it('hides the offshoot submenu for non-arrow ink and refuses the command on a group selection',async()=>{
  await mount(true);const before=snapshot();
  await route('arrow.attachOffshoot.fullCurve.above');expect(snapshot()).toEqual(before);
  const target=container.querySelector('[data-object-id="box"]')!;
  await act(async()=>target.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:315})));
  expect(container.querySelector('[data-context-submenu="offshoot"]')).toBeNull();
});
it('closes the offshoot flyout with Left and preserves its owner focus and target',async()=>{
  const id=await mount();await menu(id);
  const owner=container.querySelector<HTMLButtonElement>('[data-context-submenu="offshoot"]')!;
  await act(async()=>owner.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true})));
  await act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true})));
  expect(document.activeElement).toBe(owner);expect(owner.getAttribute('aria-expanded')).toBe('false');
  await clickCommand('arrow.attachOffshoot.fullCurve.below');
  expect(snapshot().pages[0].objects.at(-1)?.arrowAttachment?.parentObjectId).toBe(id);
});
it("targets the right-clicked arrow inside a selected group", async () => {
  const id = await mount(true); await menu(id); await clickCommand("arrow.attachOffshoot.below");
  expect(snapshot().pages[0].objects.find(object => object.arrowAttachment)?.arrowAttachment?.parentObjectId).toBe(id);
});
