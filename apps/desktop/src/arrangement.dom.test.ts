// @vitest-environment jsdom
import { saveCompoundLayoutSettings } from "./compoundLayoutSettings";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { applyPatches, type TextObject } from "@chemdraft/chem-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { createPhase4Document, createNativeSingleBondMolecule, selectDocumentObjects } from "./documentWorkflow";
import { MainWindow } from "./MainWindow";
import { broadcastCompoundLayoutSettings, DOM_COMMAND_EVENT } from "./window-manager";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

describe("auto-arrangement toolbar and history", () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    localStorage.clear();
    saveCompoundLayoutSettings({enabled:true, arrangementArrows:true});
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    vi.unstubAllGlobals();
  });
  function snapshot() { return window.__CHEMDRAFT_AGENT__!.snapshot().document; }
  async function route(commandId: string) {
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })));
  }
  async function render(selected = true, count = 6,includeNote=true) {
    let document = createPhase4Document("Six compounds");
    for (let i = 0; i < count; i++) {
      document = applyPatches(document, [{ op: "addObject", pageId: document.pages[0].id,
        object: createNativeSingleBondMolecule(document, { x: 200 + 100 * (i % 3), y: 220 + 150 * Math.floor(i / 3) }) }]);
    }
    const note: TextObject = { id: "note", type: "text", text: "Unselected conditions", spans: [],
      x: 20, y: 20, width: 160, height: 24, rotation: 0, style: {} };
    const ids = document.pages[0].objects.map((o) => o.id);
    if(includeNote) document = applyPatches(document, [{ op: "addObject", pageId: document.pages[0].id, object: note }]);
    if (selected) document = selectDocumentObjects(document, document.pages[0].id, ids);
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: document, initialActiveToolCommandId: "tool.select", initialRulersVisible: false,
      initialCrosshairsVisible: false, initialPaletteMode: "floating", nativePalette: false
    })));
  }
  it("starts hidden, rejects direct commands, and toggles toolbar/context surfaces live", async () => {
    saveCompoundLayoutSettings({enabled:false}); await render(); const before=snapshot();
    expect(container.querySelector('[data-command-id="layout.arrange.circle"]')).toBeNull();
    await route("layout.arrange.circle"); expect(snapshot()).toEqual(before);
    expect(container.textContent).toContain("Enable Compound layout tools in Settings");
    const target=container.querySelector<HTMLElement>(`[data-object-id="${before.selection.objectIds[0]}"]`)!;
    await act(async()=>target.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:100,clientY:100})));
    expect(container.querySelector('[aria-label="Object layer options"] [data-command-id="layout.arrange.circle"]')).toBeNull();
    await act(async()=>{saveCompoundLayoutSettings({enabled:true, arrangementArrows:true});await broadcastCompoundLayoutSettings({enabled:true, arrangementArrows:true});});
    expect(container.querySelector('[data-command-id="layout.arrange.circle"]')).not.toBeNull();
    const arrange = container.querySelector<HTMLButtonElement>('[data-context-submenu="arrange"]')!;
    expect(arrange.textContent).toContain("Arrange");
    expect(container.querySelector('[aria-label="Object layer options"] [data-command-id="layout.arrange.circle"]')).toBeNull();
    await act(async()=>arrange.click());
    expect(container.querySelector('[aria-label="Object layer options"] [data-command-id="layout.arrange.circle"]')).not.toBeNull();
    await route("layout.adjustArrangementSpacing");expect(container.querySelector('.arrangement-spacing-dialog')).not.toBeNull();
    await act(async()=>{saveCompoundLayoutSettings({enabled:false});await broadcastCompoundLayoutSettings({enabled:false});});
    expect(container.querySelector('.arrangement-spacing-dialog')).toBeNull();
    expect(container.querySelector('[data-command-id="layout.arrange.circle"]')).toBeNull();
    expect(container.querySelector('[data-context-submenu="arrange"]')).toBeNull();
    await route("layout.adjustArrangementSpacing");expect(snapshot()).toEqual(before);
  });
  it("opens Arrange as a context submenu, supports keyboard navigation and invokes one layout", async () => {
    await render(); const before = snapshot();
    const target = container.querySelector<HTMLElement>(`[data-object-id="${before.selection.objectIds[0]}"]`)!;
    await act(async()=>target.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:100,clientY:100})));
    const arrange = container.querySelector<HTMLButtonElement>('[data-context-submenu="arrange"]')!;
    expect(arrange.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[aria-label="Arrange layouts"]')).toBeNull();
    await act(async()=>arrange.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true,cancelable:true})));
    const menu = container.querySelector<HTMLElement>('[aria-label="Arrange layouts"]')!;
    expect([...menu.querySelectorAll('button')].map(button=>button.textContent?.trim())).toEqual([
      "Circle", "Oval", "Grid (Left)", "Grid (Centered)", "Grid (Right)", "Row", "Column", "Arrange with options…"
    ]);
    expect(document.activeElement?.getAttribute("data-command-id")).toBe("layout.arrange.circle");
    await act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true,cancelable:true})));
    expect(document.activeElement?.getAttribute("data-command-id")).toBe("layout.arrange.oval");
    await act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true,cancelable:true})));
    expect(document.activeElement).toBe(arrange);expect(container.querySelector('[aria-label="Arrange layouts"]')).toBeNull();
    await act(async()=>arrange.click());
    await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="Arrange layouts"] [data-command-id="layout.arrange.row"]')!.click());
    expect(snapshot()).not.toEqual(before);expect(container.querySelector('[data-context-submenu="arrange"]')).toBeNull();
    await route("edit.undo");expect(snapshot()).toEqual(before);
  });
  it("invokes the real circle handler from the toolbar once, with one named undo and redo", async () => {
    await render();
    const before = snapshot();
    const button = container.querySelector<HTMLButtonElement>('button[data-command-id="layout.arrange.circle"]')!;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    const after = snapshot();
    expect(after.pages[0].objects[0]).not.toEqual(before.pages[0].objects[0]);
    expect(after.pages[0].objects.find((object) => object.id === "note")).toEqual(before.pages[0].objects.at(-1));
    expect(after.selection).toEqual(before.selection);
    expect(after.pages[0].objects.filter((object) => object.type === "graphic")).toHaveLength(0);
    expect(container.textContent).toContain("Arranged 6 objects in a circle");
    await act(async () => button.click());
    expect(snapshot()).toEqual(after);
    await route("edit.undo");
    expect(snapshot()).toEqual(before);
    await route("edit.redo");
    expect(snapshot()).toEqual(after);
    await route("edit.undo");
    await route("edit.undo");
    expect(snapshot()).toEqual(before);
  });
  it("opens the layout choices by keyboard and arranges a grid from the submenu", async () => {
    await render();
    const button = container.querySelector<HTMLButtonElement>('button[data-command-id="layout.arrange.circle"]')!;
    await act(async () => button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    const menu = container.querySelector<HTMLElement>('[data-command-flyout-menu="layout.arrange.circle.submenu"]')!;
    expect(menu.hidden).toBe(false);
    const choices = menu.querySelectorAll('button[data-command-id^="layout.arrange."]');
    expect(choices).toHaveLength(7);
    expect(new Set([...choices].map((choice) => choice.querySelector("svg")!.outerHTML)).size).toBe(7);
    const before = snapshot();
    await act(async () => menu.querySelector<HTMLButtonElement>('[data-command-id="layout.arrange.grid"]')!.click());
    expect(snapshot()).not.toEqual(before);
    expect(menu.hidden).toBe(true);
    expect(container.textContent).toContain("in a grid");
    expect(snapshot().pages[0].objects.filter((object) => object.type === "graphic")).toHaveLength(0);
  });
  it("disables every layout with no selection, including routed native-palette commands", async () => {
    await render(false);
    const before = snapshot();
    const button = container.querySelector<HTMLButtonElement>('button[data-command-id="layout.arrange.circle"]')!;
    expect(button.disabled).toBe(true);
    for (const layout of ["circle", "oval", "grid", "row", "column"]) await route(`layout.arrange.${layout}`);
    expect(snapshot()).toEqual(before);
  });
  it.each(["left", "center", "right"] as const)("the %s grid flyout aligns a five-compound final row", async (alignment) => {
    await render(true, 5);
    const button = container.querySelector<HTMLButtonElement>('button[data-command-id="layout.arrange.circle"]')!;
    await act(async () => button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    const id = `layout.arrange.grid${alignment === "center" ? "" : `.${alignment}`}`;
    const choice = container.querySelector<HTMLButtonElement>(`[data-command-flyout-menu] button[data-command-id="${id}"]`)!;
    await act(async () => choice.click());
    const document = snapshot();
    expect(container.textContent).toContain(`grid (${alignment})`);
    const molecules = document.pages[0].objects.filter((o) => o.type === "molecule");
    const span = (entries: typeof molecules) => ({ left: Math.min(...entries.map((o) => o.x)), right: Math.max(...entries.map((o) => o.x + o.width)) });
    const top = span(molecules.slice(0, 3)), bottom = span(molecules.slice(3));
    if (alignment === "left") expect(bottom.left).toBeCloseTo(top.left);
    else if (alignment === "right") expect(bottom.right).toBeCloseTo(top.right);
    else expect(bottom.left + bottom.right).toBeCloseTo(top.left + top.right);
    expect(document.pages[0].objects.filter((o) => o.type === "graphic").every((o) => o.data.artPathKind === "line")).toBe(true);
    await route("edit.undo");
    expect(snapshot().pages[0].objects.filter((o) => o.type === "graphic")).toHaveLength(0);
  });
  it("previews optional connecting arrows, cancels unchanged, and saves layout plus arrows in one Undo step", async () => {
    await render(true, 4, false); const before = snapshot();
    await route("layout.arrangeOptions");
    expect(container.textContent).toContain("Arrange selection");
    const form = () => container.querySelector<HTMLFormElement>('.arrangement-spacing-dialog')!;
    const checkbox = () => form().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox().checked).toBe(false); expect(snapshot()).toEqual(before);
    await act(async () => checkbox().click());
    expect(snapshot()).toEqual(before);
    expect(form().querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    await act(async () => form().querySelector<HTMLButtonElement>('button[type="button"]')!.click());
    expect(snapshot()).toEqual(before);
    await route("layout.arrangeOptions"); expect(checkbox().checked).toBe(false);
    await act(async () => checkbox().click());
    await act(async () => form().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!.click());
    await act(async () => form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    const after = snapshot();
    expect(after.pages[0].objects.filter(o => o.type === "graphic")).toHaveLength(4);
    expect(container.querySelector('.arrangement-spacing-dialog')).toBeNull();
    await route("edit.undo"); expect(snapshot()).toEqual(before);
    await route("edit.redo"); expect(snapshot()).toEqual(after);
  });
  it('opens one unified window from either command, retains its draft, and saves layout, arrows and spacing as one Undo',async()=>{
    await render(true,4,false);const before=snapshot();
    await route('layout.adjustArrangementSpacing');
    const form=container.querySelector<HTMLFormElement>('.arrangement-spacing-dialog')!;
    expect(form.querySelector('select')).not.toBeNull();
    const checkbox=form.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async()=>checkbox.click());
    const spacing=form.querySelector<HTMLInputElement>('input[id$="-spacing"]')!;
    const initial=form.querySelector<HTMLImageElement>('img')!.src;
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(spacing,'115');spacing.dispatchEvent(new Event('input',{bubbles:true}));});
    expect(form.querySelector<HTMLImageElement>('img')!.src).not.toBe(initial);
    expect(snapshot()).toEqual(before);
    await route('layout.arrangeOptions');
    expect(container.querySelectorAll('.arrangement-spacing-dialog')).toHaveLength(1);
    expect(spacing.value).toBe('115');expect(checkbox.checked).toBe(true);
    await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    const after=snapshot();expect(after).not.toEqual(before);
    expect(after.pages[0].objects.filter(o=>o.arrangementConnection)).toHaveLength(3);
    for(const original of before.pages[0].objects) {
      const object=after.pages[0].objects.find(o=>o.id===original.id)!;
      expect(object.width).toBe(original.width);expect(object.height).toBe(original.height);
    }
    await route('edit.undo');expect(snapshot()).toEqual(before);
    await route('edit.redo');expect(snapshot()).toEqual(after);
  });
  it('reroutes a saved circle when the quick Grid command is invoked and restores the whole layout in one Undo',async()=>{
    await render(true,4,false);await route('layout.arrangeOptions');
    const form=container.querySelector<HTMLFormElement>('.arrangement-spacing-dialog')!;
    await act(async()=>form.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async()=>form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1].click());
    await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    const circle=snapshot();expect(circle.pages[0].objects.filter(o=>o.arrangementConnection)).toHaveLength(4);
    const launcher=container.querySelector<HTMLButtonElement>('button[data-command-id="layout.arrange.circle"]')!;
    await act(async()=>launcher.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})));
    const choice=container.querySelector<HTMLButtonElement>('[data-command-flyout-menu] [data-command-id="layout.arrange.grid"]')!;
    expect(choice).not.toBeNull();
    await act(async()=>choice.click());
    const grid=snapshot(),arrows=grid.pages[0].objects.filter(o=>o.arrangementConnection);
    expect(arrows).toHaveLength(2);
    expect(arrows.every(o=>o.arrangementConnection!.settings?.layout==='grid')).toBe(true);
    expect(grid.pages[0].objects.filter(o=>o.type==='molecule')).not.toEqual(circle.pages[0].objects.filter(o=>o.type==='molecule'));
    await route('edit.undo');expect(snapshot()).toEqual(circle);
    await route('edit.redo');expect(snapshot()).toEqual(grid);
    await route('layout.arrange.row');
    expect(snapshot().pages[0].objects.filter(o=>o.arrangementConnection).every(o=>o.arrangementConnection!.settings?.layout==='row')).toBe(true);
  });
  it('keeps base layouts available with Arrangement Arrows off, rejects its command and cancels an open preview when disabled',async()=>{
    saveCompoundLayoutSettings({enabled:true});await render(true,4,false);const before=snapshot();
    expect(container.querySelector('[data-command-id="layout.arrange.circle"]')).not.toBeNull();
    await route('layout.arrangeOptions');expect(snapshot()).toEqual(before);
    expect(container.querySelector('.arrangement-spacing-dialog')).toBeNull();
    expect(container.textContent).toContain('Enable Arrangement Arrows in Settings');
    await act(async()=>broadcastCompoundLayoutSettings({enabled:true,arrangementArrows:true}));
    await route('layout.arrangeOptions');expect(container.querySelector('.arrangement-spacing-dialog')).not.toBeNull();
    await act(async()=>broadcastCompoundLayoutSettings({enabled:true,arrangementArrows:false}));
    expect(container.querySelector('.arrangement-spacing-dialog')).toBeNull();expect(snapshot()).toEqual(before);
    await route('layout.adjustArrangementSpacing');expect(container.querySelector('.arrangement-spacing-dialog')).not.toBeNull();
    await act(async()=>broadcastCompoundLayoutSettings({enabled:true,arrangementArrows:false,offshootArrows:true}));
    expect(container.querySelector('.arrangement-spacing-dialog')).not.toBeNull();
    expect(snapshot()).toEqual(before);
  });
  function pointer(target: EventTarget, type: string, x: number, y: number) {
    const event = new MouseEvent(type, {bubbles:true,cancelable:true,button:0,buttons:type === "pointerup" ? 0 : 1,clientX:x,clientY:y});
    Object.defineProperties(event,{pointerId:{value:31},pointerType:{value:"mouse"},isPrimary:{value:true}});
    target.dispatchEvent(event);
  }
  it('reopens checked, previews length without compound moves, cancels unchanged, and removes owned arrows in one Undo',async()=>{
    await render(true,4,false);await route('layout.arrangeOptions');
    const form=()=>container.querySelector<HTMLFormElement>('form.arrangement-spacing-dialog')!;
    const checkbox=()=>form().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const save=async()=>{await act(async()=>form().dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));};
    await act(async()=>checkbox().click());await save();const before=snapshot();
    await route('layout.arrangeOptions');expect(checkbox().checked).toBe(true);
    const initial=form().querySelector<HTMLImageElement>('img')!.src,slider=form().querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(slider).not.toBeNull();
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(slider,'70');slider.dispatchEvent(new Event('input',{bubbles:true}));});
    expect(form().querySelector<HTMLImageElement>('img')!.src).not.toBe(initial);expect(snapshot()).toEqual(before);
    await act(async()=>form().querySelector<HTMLButtonElement>('button[type="button"]')!.click());expect(snapshot()).toEqual(before);
    await route('layout.arrangeOptions');expect(checkbox().checked).toBe(true);
    await act(async()=>checkbox().click());expect(form().querySelector('input[id$="-arrow-length"]')).toBeNull();expect(form().querySelector('input[id$="-spacing"]')).not.toBeNull();await save();
    expect(snapshot().pages[0].objects.some(o=>o.arrangementConnection)).toBe(false);
    await route('edit.undo');expect(snapshot()).toEqual(before);
    await route('edit.redo');expect(snapshot().pages[0].objects.some(o=>o.arrangementConnection)).toBe(false);
  });
  it('can draw after arrangement Save and again after deleting generated arrows',async()=>{
    await render(true,4,false);
    await route('layout.arrangeOptions');
    await act(async()=>container.querySelector<HTMLInputElement>('.arrangement-spacing-dialog input[type="checkbox"]')!.click());
    await act(async()=>container.querySelector('form.arrangement-spacing-dialog')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    const page=container.querySelector<HTMLElement>('.page')!;
    expect(page).not.toBeNull();
    vi.spyOn(page,'getBoundingClientRect').mockReturnValue({x:0,y:0,left:0,top:0,width:816,height:1056,right:816,bottom:1056,toJSON:()=>({})});
    Object.assign(page,{setPointerCapture:vi.fn(),releasePointerCapture:vi.fn(),hasPointerCapture:()=>false});
    await route('object.color.red');
    for(const object of snapshot().pages[0].objects.filter(o=>o.arrangementConnection)) {
      expect(object.style.strokeColor).toBe('#b3261e');
    }
    const draw=async(x:number)=>{
      await route('tool.bond');
      const before=snapshot().pages[0].objects.length;
      await act(async()=>{pointer(page,'pointerdown',x,600);pointer(page,'pointerup',x,600);});
      expect(snapshot().pages[0].objects.length).toBeGreaterThan(before);
    };
    await draw(100);
    const arrows=snapshot().pages[0].objects.filter(o=>o.arrangementConnection);
    for(const arrow of arrows) {
      await route('tool.select');
      const target=container.querySelector<HTMLElement>(`[data-object-id="${arrow.id}"]`)!;
      await act(async()=>target.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:0,clientY:0})));
      await route('edit.deleteHoveredNativeTarget');
    }
    expect(snapshot().pages[0].objects.some(o=>o.arrangementConnection)).toBe(false);
    await draw(300);
  });
  function changeText(input: HTMLTextAreaElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input,value);
    input.dispatchEvent(new Event("input",{bubbles:true}));
  }
  it("refuses to save a preview after the underlying drawing changes", async () => {
    await render(); await route("layout.arrange.circle"); await route("layout.adjustArrangementSpacing");
    expect(container.querySelector('.arrangement-spacing-dialog')).not.toBeNull();
    await route("layout.arrange.row");const changed=snapshot();
    await act(async()=>container.querySelector('form.arrangement-spacing-dialog')!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
    expect(snapshot()).toEqual(changed);expect(container.querySelector('.arrangement-spacing-dialog')).toBeNull();
    expect(container.textContent).toContain("Drawing changed. Reopen Adjust spacing");
  });
  it("previews tighter spacing from the flyout, cancels unchanged and saves one undo step",async()=>{
    saveCompoundLayoutSettings({enabled:true});
    await render(true,5,false);await route("layout.arrange.oval");
    const before=snapshot();
    async function open() {
      const button=container.querySelector<HTMLButtonElement>('[data-command-id="layout.arrange.circle"]')!;
      await act(async()=>button.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true})));
      const choice=container.querySelector<HTMLButtonElement>('[data-command-flyout-menu] [data-command-id="layout.adjustArrangementSpacing"]')!;
      expect(choice).not.toBeNull();await act(async()=>choice.click());
    }
    await open();
    let slider=container.querySelector<HTMLInputElement>('.arrangement-spacing-dialog input[type="range"]')!;
    expect(document.activeElement).toBe(slider);
    const value=Math.ceil((Number(slider.min)+100)/2);
    const initial=container.querySelector<HTMLImageElement>('.arrangement-spacing-preview')!.src;
    async function change() {await act(async()=>{
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(slider,String(value));
      slider.dispatchEvent(new Event("input",{bubbles:true}));
    });}
    await change();
    expect(container.querySelector<HTMLImageElement>('.arrangement-spacing-preview')!.src).not.toBe(initial);
    expect(snapshot()).toEqual(before);
    await act(async()=>slider.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
    expect(snapshot()).toEqual(before);expect(container.querySelector('.arrangement-spacing-dialog')).toBeNull();
    await open();slider=container.querySelector<HTMLInputElement>('.arrangement-spacing-dialog input[type="range"]')!;
    await change();await act(async()=>container.querySelector('.arrangement-spacing-dialog')!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
    const after=snapshot();expect(after).not.toEqual(before);
    for(const old of before.pages[0].objects) if(old.type==="molecule") {
      const next=after.pages[0].objects.find(o=>o.id===old.id)!;
      expect(next.width).toBe(old.width);expect(next.height).toBe(old.height);
    }
    await route("edit.undo");expect(snapshot()).toEqual(before);
    await route("edit.redo");expect(snapshot()).toEqual(after);
  });
});
