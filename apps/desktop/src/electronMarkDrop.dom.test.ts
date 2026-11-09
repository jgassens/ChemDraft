// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatch, type ChemDraftDocument } from "@chemdraft/chem-core";
import { atomDisplayLabel } from "@chemdraft/layout-engine";
import { phase4Timestamp } from "@chemdraft/document-workflow-core";
import { MainWindow } from "./MainWindow";
import * as workflow from "./documentWorkflow";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { saveDirectElectronMarkEditing } from "./electronMarkEditingSettings";
import { dropMark, dropMolecule, electronMarkDropFixture } from "./testSupport/electronMarkDropFixture";
import { MemoryStorage } from "./testSupport/memoryStorage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

describe.each([false, true])("electron-mark drop interaction with direct editing %s", enabled => {
  let container: HTMLDivElement, root: Root;
  let frames: Map<number, FrameRequestCallback>, frameId: number;
  const captureMethods = { set: Element.prototype.setPointerCapture,
    release: Element.prototype.releasePointerCapture, has: Element.prototype.hasPointerCapture };
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    saveDirectElectronMarkEditing(enabled);
    frames = new Map(); frameId = 0;
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.set(++frameId, callback); return frameId; });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    Element.prototype.hasPointerCapture = () => false;
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    Element.prototype.setPointerCapture = captureMethods.set;
    Element.prototype.releasePointerCapture = captureMethods.release;
    Element.prototype.hasPointerCapture = captureMethods.has;
  });
  async function mount(document: ChemDraftDocument) {
    await act(async () => root.render(createElement(MainWindow, { initialDocument: document,
      initialActiveToolCommandId: "tool.select", initialPaletteMode: "hidden", nativePalette: false,
      initialRulersVisible: false, initialCrosshairsVisible: false })));
    container.querySelector<HTMLElement>(".page")!.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0,
      right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) });
  }
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot().document;
  const status = () => container.querySelector("[data-status-message]")?.textContent;
  const highlighted = () => container.querySelector("[data-delete-hover-atom-id]")?.getAttribute("data-delete-hover-atom-id");
  const page = () => container.querySelector(".page")!;
  function pointer(target: EventTarget, type: string, point: { x: number; y: number }) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
      buttons: type === "pointerup" ? 0 : 1, clientX: point.x, clientY: point.y });
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
    target.dispatchEvent(event);
  }
  async function command(commandId: string) {
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })));
  }
  async function start() {
    const mark = dropMark(snapshot());
    // Pick painted ink on both preference paths; a rectangular grab area is optional.
    const target = container.querySelector(`[data-page-svg-object-visual="${mark.id}"] circle`)!;
    expect(target).not.toBeNull();
    await act(async () => pointer(target, "pointerdown", workflow.nativeChargeMarkCenter(mark)));
    return { target, mark };
  }
  async function move(target: EventTarget, point: { x: number; y: number }) {
    await act(async () => {
      pointer(target, "pointermove", point);
      const pending = [...frames.values()]; frames.clear();
      pending.forEach(callback => callback(performance.now()));
    });
  }
  function labels() {
    const molecule = dropMolecule(snapshot());
    return molecule.atoms.map(atom => atomDisplayLabel(atom, molecule.bonds, undefined, molecule.atoms));
  }

  it.each(["object", "page"])("moves charge through the full Boc-glycine sequence with one exact undo/redo step per %s drop", async route => {
    const { document, nitrogen, carbonylOxygen, hydroxylOxygen } = electronMarkDropFixture();
    await mount(document);
    const reporter = vi.spyOn(workflow, "electronMarkChemistryChanges");
    const states = [snapshot()];
    for (const [point, message, expectedLabels] of [
      [carbonylOxygen, "Charge moved from N to O (O now OH, N now NH)", ["NH", "OH", "OH"]],
      [hydroxylOxygen, "Charge moved from O to O (O now OH2, O now O)", ["NH", "O", "OH2"]],
      [nitrogen, "Charge moved from O to N (N now NH2, O now OH)", ["NH2", "O", "OH"]]
    ] as const) {
      const drag = await start(), before = snapshot(), calls = reporter.mock.calls.length;
      await move(drag.target, point);
      expect(snapshot()).toBe(before);
      expect(reporter).toHaveBeenCalledTimes(calls);
      expect(highlighted()).toBe(point.id);
      expect(container.querySelector(".native-atom-hover")).not.toBeNull();
      await act(async () => pointer(route === "page" ? page() : drag.target, "pointerup", point));
      expect(highlighted()).toBeUndefined();
      expect(status()).toBe(message);
      expect(reporter).toHaveBeenCalledTimes(calls + 1);
      expect([labels()[7], labels()[10], labels()[11]]).toEqual(expectedLabels);
      const after = snapshot(); states.push(after);
      await command("edit.undo");
      expect(status()).toBe("Undid Move Charge");
      expect(snapshot()).toEqual(before);
      await command("edit.redo");
      expect(snapshot()).toEqual(after);
      expect(reporter).toHaveBeenCalledTimes(calls + 1);
    }
    for (const state of states.slice(0, -1).reverse()) {
      await command("edit.undo");
      expect(snapshot()).toEqual(state);
    }
    for (const state of states.slice(1)) {
      await command("edit.redo");
      expect(snapshot()).toEqual(state);
    }
  });

  it("keeps the atom and chemistry when dropping into empty space", async () => {
    const { document } = electronMarkDropFixture(); await mount(document);
    const before = snapshot(), drag = await start(), end = { x: 600, y: 500 };
    await move(drag.target, end);
    expect(highlighted()).toBeUndefined();
    await act(async () => pointer(drag.target, "pointerup", end));
    expect(dropMark(snapshot()).anchor).toEqual(dropMark(before).anchor);
    expect(dropMolecule(snapshot())).toEqual(dropMolecule(before));
    expect(status()).toBe("Charge repositioned on N; no atom within capture radius");
    await command("edit.undo"); expect(snapshot()).toEqual(before);
  });

  it("highlights a refused target, reports why, and leaves no undo entry", async () => {
    const { document, saturatedCarbon } = electronMarkDropFixture(); await mount(document);
    const before = snapshot(), drag = await start();
    await move(drag.target, saturatedCarbon);
    expect(highlighted()).toBe(saturatedCarbon.id);
    await act(async () => pointer(drag.target, "pointerup", saturatedCarbon));
    expect(snapshot()).toEqual(before);
    expect(status()).toBe("Cannot move Charge from N to C: C cannot carry formal charge +1 with bond/radical valence 4");
    expect(highlighted()).toBeUndefined();
    await command("edit.undo"); expect(snapshot()).toEqual(before);
  });

  it.each(["Escape", "object cancel", "page cancel"])("clears the attachment highlight and preserves chemistry on %s", async cancel => {
    const { document, carbonylOxygen } = electronMarkDropFixture(); await mount(document);
    const before = snapshot(), drag = await start();
    await move(drag.target, carbonylOxygen);
    expect(highlighted()).toBe(carbonylOxygen.id);
    await act(async () => {
      if (cancel === "Escape") window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      else pointer(cancel === "page cancel" ? page() : drag.target, "pointercancel", carbonylOxygen);
    });
    expect(highlighted()).toBeUndefined();
    expect(snapshot()).toEqual(before);
    await act(async () => pointer(drag.target, "pointerup", carbonylOxygen));
    expect(snapshot()).toEqual(before);
  });

  it.each(["radical-dot", "lone-pair", "unknown"] as const)("attaches a dragged %s through painted ink with either preference", async kind => {
    const fixture = electronMarkDropFixture({ kind: kind === "unknown" ? "lone-pair" : kind });
    const document = kind === "unknown" ? applyPatch(fixture.document, { op: "updateObject",
      objectId: dropMark(fixture.document).id, changes: { markKind: "unknown" } }, { now: phase4Timestamp }) : fixture.document;
    await mount(document);
    const before = snapshot();
    // Unknown marks render as a fallback glyph rather than a dot; their wrapper still owns the drag.
    const mark = dropMark(before);
    const target = container.querySelector(`[data-page-svg-object-visual="${mark.id}"]`)!;
    await act(async () => pointer(target, "pointerdown", workflow.nativeChargeMarkCenter(mark)));
    await move(target, fixture.hydroxylOxygen);
    expect(highlighted()).toBe(fixture.hydroxylOxygen.id);
    await act(async () => pointer(target, "pointerup", fixture.hydroxylOxygen));
    expect(dropMark(snapshot()).anchor.atomId).toBe(fixture.hydroxylOxygen.id);
    expect(dropMolecule(snapshot()).atoms[7].markRadicals ?? 0).toBe(0);
    expect(dropMolecule(snapshot()).atoms[11].markRadicals ?? 0).toBe(kind === "radical-dot" ? 1 : 0);
    await command("edit.undo"); expect(snapshot()).toEqual(before);
  });
});
