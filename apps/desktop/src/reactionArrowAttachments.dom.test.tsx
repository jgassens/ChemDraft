// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { applyPatches } from "@chemdraft/chem-core";
import { graphicPathEditPoints } from "@chemdraft/art-engine";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNativeArtLineGraphicObject, createPhase4Document, groupSelectedDocumentObjects, selectDocumentObjects } from "./documentWorkflow";
import { MainWindow } from "./MainWindow";
import { saveCompoundLayoutSettings } from "./compoundLayoutSettings";
import { broadcastCompoundLayoutSettings, DOM_COMMAND_EVENT } from "./window-manager";
import { MemoryStorage } from "./testSupport/memoryStorage";
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  saveCompoundLayoutSettings({ enabled: true, offshootArrows: true, formattedReactionConditions: true });
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
function type(text: string) {
  const field = container.querySelector(".reaction-conditions-form textarea")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}
it('updates independent feature gates live, refuses routed commands, and closes a disabled conditions editor without editing',async()=>{
  const id=await mount();await menu(id);
  const before=snapshot();
  await act(async()=>broadcastCompoundLayoutSettings({enabled:true,offshootArrows:false,formattedReactionConditions:true}));
  expect(container.querySelector('[data-context-submenu="offshoot"]')).toBeNull();
  expect(container.querySelector('[data-command-id="arrow.conditions"]')).not.toBeNull();
  await route('arrow.attachOffshoot.above');expect(snapshot()).toEqual(before);
  expect(container.textContent).toContain('Enable Offshoot Arrows in Settings');
  await clickCommand('arrow.conditions');expect(container.querySelector('.reaction-conditions-form')).not.toBeNull();
  await act(async()=>broadcastCompoundLayoutSettings({enabled:true,offshootArrows:true,formattedReactionConditions:false}));
  expect(container.querySelector('.reaction-conditions-form')).toBeNull();
  await menu(id);expect(container.querySelector('[data-command-id="arrow.conditions"]')).toBeNull();
  expect(container.querySelector('[data-context-submenu="offshoot"]')).not.toBeNull();
  await route('arrow.conditions');expect(snapshot()).toEqual(before);
  expect(container.textContent).toContain('Enable Formatted Reaction Conditions in Settings');
  await act(async()=>broadcastCompoundLayoutSettings({enabled:false,offshootArrows:true,formattedReactionConditions:true}));
  await menu(id);expect(container.querySelector('[data-context-submenu="offshoot"]')).toBeNull();
  await route('arrow.attachOffshoot.above');expect(snapshot()).toEqual(before);
});
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
it('conditions target the branch shaft even when an overlapping parent DOM frame receives the click',async()=>{
  const id=await mount();await menu(id);await clickCommand('arrow.attachOffshoot.below');
  const branch=snapshot().pages[0].objects.find(o=>o.arrowAttachment?.kind==='offshoot')!;
  if(branch.type!=='graphic')throw new Error('fixture');
  const point=graphicPathEditPoints(branch)!.end;
  const scale=(window.__CHEMDRAFT_AGENT__!.snapshot().viewport as {scale:number}).scale;
  const page=container.querySelector<HTMLElement>('.page')!;
  vi.spyOn(page,'getBoundingClientRect').mockReturnValue({x:0,y:0,left:0,top:0,width:816*scale,height:1056*scale,right:816*scale,bottom:1056*scale,toJSON:()=>({})});
  const parent=container.querySelector<SVGElement>(`[data-object-id="${id}"]`)!;
  await act(async()=>parent.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:point.x*scale,clientY:point.y*scale})));
  await clickCommand('arrow.conditions');await act(async()=>type('THF, 2 h'));
  await act(async()=>container.querySelector('form.reaction-conditions-form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  expect(snapshot().pages[0].objects.find(o=>o.type==='text')?.arrowAttachment?.parentObjectId).toBe(branch.id);
});
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
