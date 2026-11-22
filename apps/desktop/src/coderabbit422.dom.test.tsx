// @vitest-environment jsdom
// CodeRabbit review of the 1.2.2 PR (#422), the gesture items: real DOM pointer events through MainWindow.
// A claim that reproduces is `it.fails` (the fix removes `.fails`).
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatch, applyPatches, type ChemDraftDocument, type ElectronMarkObject } from "@chemdraft/chem-core";
import { transformPointForObject } from "@chemdraft/layout-engine";
import { phase4Timestamp } from "@chemdraft/document-workflow-core";
import { MainWindow } from "./MainWindow";
import * as workflow from "./documentWorkflow";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { dropMark, dropMolecule, electronMarkDropFixture } from "./testSupport/electronMarkDropFixture";
import { MemoryStorage } from "./testSupport/memoryStorage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

describe.each(["macos", "windows"] as const)("CodeRabbit #422 gesture items on %s", platform => {
  let container: HTMLDivElement, root: Root;
  let frames: Map<number, FrameRequestCallback>, frameId: number;
  const captureMethods = { set: Element.prototype.setPointerCapture,
    release: Element.prototype.releasePointerCapture, has: Element.prototype.hasPointerCapture };
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
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
      initialRulersVisible: false, initialCrosshairsVisible: false, shortcutPlatform: platform })));
    container.querySelector<HTMLElement>(".page")!.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0,
      right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) });
  }
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot().document;
  const status = () => container.querySelector("[data-status-message]")?.textContent;
  const page = () => container.querySelector(".page")!;
  function pointer(target: EventTarget, type: string, point: { x: number; y: number }) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
      buttons: type === "pointerup" ? 0 : 1, clientX: point.x, clientY: point.y });
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
    target.dispatchEvent(event);
  }
  async function move(target: EventTarget, point: { x: number; y: number }) {
    await act(async () => {
      pointer(target, "pointermove", point);
      const pending = [...frames.values()]; frames.clear();
      pending.forEach(callback => callback(performance.now()));
    });
  }
  async function drag(objectId: string, from: { x: number; y: number }, to: { x: number; y: number }, onTarget = false) {
    const target = container.querySelector(`.native-molecule-object[data-object-id="${objectId}"]`)!;
    expect(target).not.toBeNull();
    await act(async () => pointer(target, "pointerdown", from));
    const before = snapshot();
    // Two moves: past the drag threshold, then to the release point.
    const receiver = onTarget ? target : page();
    await move(receiver, { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
    await move(receiver, to);
    await act(async () => pointer(receiver, "pointerup", to));
    return before;
  }
  async function command(commandId: string) {
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })));
  }

  // -------------------------------------------------------------------------------------------
  // E: documentWorkflow.ts:8500 — whole-molecule drag leaves a bond/object-anchored + behind
  // -------------------------------------------------------------------------------------------
  it.fails.each(["bond", "object"] as const)(
    "E: dragging the whole selected molecule keeps its %s-anchored + on N (or refuses the move)", async kind => {
      const { document, nitrogen, saturatedCarbon } = electronMarkDropFixture();
      const molecule = dropMolecule(document), mark = dropMark(document);
      const bond = molecule.bonds.find(candidate => candidate.fromAtomId === nitrogen.id || candidate.toAtomId === nitrogen.id)!;
      const anchor: ElectronMarkObject["anchor"] = kind === "bond"
        ? { kind, objectId: molecule.id, bondId: bond.id } : { kind, objectId: molecule.id };
      // A legacy-anchored + on N, as 1.2.2 commit normalization keeps it (and saves and reopens it).
      const drawing = workflow.normalizeCommittedDocument(applyPatch(document, { op: "updateObject", objectId: mark.id, changes: {
        anchor, atomAssociation: undefined, x: nitrogen.x - mark.width / 2, y: nitrogen.y - mark.height / 2 } }, { now: phase4Timestamp }));
      expect(dropMolecule(drawing).atoms.find(atom => atom.id === nitrogen.id)).toMatchObject({ formalCharge: 1, markCharge: 1 });
      await mount(workflow.selectDocumentObjects(drawing, drawing.pages[0].id, [molecule.id]));
      const before = await drag(molecule.id, saturatedCarbon, { x: saturatedCarbon.x + 150, y: saturatedCarbon.y + 200 }, true);
      const after = snapshot();
      const refused = after === before || JSON.stringify(after) === JSON.stringify(before);
      // The gesture must have been the whole-molecule move: every atom shifted by the same delta.
      if (!refused) {
        const moved = dropMolecule(after);
        expect(moved.atoms.find(atom => atom.id === saturatedCarbon.id)!.x).not.toBe(saturatedCarbon.x);
        expect(moved.atoms.find(atom => atom.id === nitrogen.id)!.x - nitrogen.x)
          .toBeCloseTo(moved.atoms.find(atom => atom.id === saturatedCarbon.id)!.x - saturatedCarbon.x);
      }
      if (refused) return;
      // Silent loss is the bug: the move committed and N lost its +.
      expect({ charge: dropMolecule(after).atoms.find(atom => atom.id === nitrogen.id)!.formalCharge, status: status() })
        .toMatchObject({ charge: 1 });
      await command("edit.undo");
    });

  // -------------------------------------------------------------------------------------------
  // I: electronMarkDrop.dom.test.ts:886 — a part drag on a rotated molecule does not follow the pointer
  // -------------------------------------------------------------------------------------------
  it.fails("I: an atom dragged on a 90°-rotated molecule is drawn at the release point", async () => {
    const { document, hydroxylOxygen } = electronMarkDropFixture();
    const molecule = dropMolecule(document);
    const rotated = applyPatches(document, [
      { op: "removeObject", objectId: dropMark(document).id },
      { op: "updateObject", objectId: molecule.id, changes: { rotation: 90 } }
    ], { now: phase4Timestamp });
    await mount(workflow.selectDocumentObjects(rotated, rotated.pages[0].id, []));
    const start = transformPointForObject(dropMolecule(rotated), hydroxylOxygen);
    const end = { x: start.x + 60, y: start.y };
    await drag(molecule.id, start, end);
    const moved = dropMolecule(snapshot());
    const oxygen = moved.atoms.find(atom => atom.id === hydroxylOxygen.id)!;
    expect(oxygen).not.toEqual(hydroxylOxygen);
    const drawn = transformPointForObject(moved, oxygen);
    // The drag snap may adjust the drop by a few px; a raw-frame delta misses by ~85 px at 90°.
    expect(Math.hypot(drawn.x - end.x, drawn.y - end.y)).toBeLessThan(12);
  });
});
