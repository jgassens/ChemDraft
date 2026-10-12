// @vitest-environment jsdom

import { type ChemDraftDocument } from "@chemdraft/chem-core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MainWindow } from "./MainWindow";
import {
  applyNativeTemplateToolAtPoint,
  createMechanismArrowBetween,
  createPhase4Document,
  insertNativeArtGraphicObject
} from "./documentWorkflow";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pageRect = {
  x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612,
  toJSON: () => ({})
} as DOMRect;

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("document switch pointer capture", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof ResizeObserver | undefined;
  const captures = new Map<number, Element>();
  let captureSets: Array<{ owner: Element; pointerId: number }> = [];
  let captureReleases: Array<{ owner: Element; pointerId: number }> = [];
  const originalCaptureMethods = {
    set: Element.prototype.setPointerCapture,
    release: Element.prototype.releasePointerCapture,
    has: Element.prototype.hasPointerCapture
  };

  beforeEach(() => {
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
    captures.clear();
    captureSets = [];
    captureReleases = [];
    // Use Element so the object and button handle owners behave like their browser counterparts.
    Element.prototype.setPointerCapture = function(pointerId) {
      captures.set(pointerId, this);
      captureSets.push({ owner: this, pointerId });
    };
    Element.prototype.releasePointerCapture = function(pointerId) {
      expect(captures.get(pointerId)).toBe(this);
      captures.delete(pointerId);
      captureReleases.push({ owner: this, pointerId });
    };
    Element.prototype.hasPointerCapture = function(pointerId) { return captures.get(pointerId) === this; };
    window.history.replaceState(null, "", "/?agentBridge=1&artStyleQa=0");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Element.prototype.setPointerCapture = originalCaptureMethods.set;
    Element.prototype.releasePointerCapture = originalCaptureMethods.release;
    Element.prototype.hasPointerCapture = originalCaptureMethods.has;
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    if (originalResizeObserver) globalThis.ResizeObserver = originalResizeObserver;
    else Reflect.deleteProperty(globalThis, "ResizeObserver");
  });

  async function render(document: ChemDraftDocument) {
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialDocument: document,
        initialActiveToolCommandId: "tool.select",
        initialCrosshairsVisible: false,
        initialPaletteMode: "hidden",
        initialRulersVisible: false,
        nativePalette: true
      }));
    });
    page().getBoundingClientRect = () => pageRect;
    await act(async () => { await Promise.resolve(); });
  }

  function page(): HTMLElement {
    const result = container.querySelector<HTMLElement>(".page");
    if (!result) throw new Error("Expected rendered page.");
    return result;
  }

  function object(objectId: string): HTMLElement {
    const result = container.querySelector<HTMLElement>(`[data-object-id="${objectId}"]`);
    if (!result) throw new Error("Expected rendered object.");
    return result;
  }

  function activeTab(): HTMLButtonElement {
    const result = container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
    if (!result) throw new Error("Expected active document tab.");
    return result;
  }

  function inactiveTab(): HTMLButtonElement {
    const result = container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="false"]');
    if (!result) throw new Error("Expected inactive document tab.");
    return result;
  }

  function snapshot() {
    const bridge = window.__CHEMDRAFT_AGENT__;
    if (!bridge) throw new Error("Expected agent bridge.");
    return bridge.snapshot().document;
  }

  function canHistory(direction: "undo" | "redo") {
    return container.querySelector(`[data-can-${direction}="true"]`) !== null;
  }

  async function command(id: string) {
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command(id); });
  }

  async function historyStacks() {
    const past: ChemDraftDocument[] = [];
    const future: ChemDraftDocument[] = [];
    while (canHistory("undo")) {
      await command("edit.undo");
      past.push(snapshot());
    }
    for (let index = 0; index < past.length; index += 1) await command("edit.redo");
    while (canHistory("redo")) {
      await command("edit.redo");
      future.push(snapshot());
    }
    for (let index = 0; index < future.length; index += 1) await command("edit.undo");
    return { past, future };
  }

  function dispatchPointer(
    target: EventTarget,
    type: "pointerdown" | "pointermove" | "pointerup",
    point: { x: number; y: number },
    pointerId: number
  ) {
    const event = new MouseEvent(type, {
      bubbles: true, button: 0, buttons: type === "pointerup" ? 0 : 1, cancelable: true,
      clientX: point.x, clientY: point.y
    });
    Object.defineProperties(event, {
      isPrimary: { value: true }, pointerId: { value: pointerId }, pointerType: { value: "mouse" }
    });
    target.dispatchEvent(event);
    if (type === "pointerup") captures.delete(pointerId);
  }

  async function switchToNewTab() {
    const newTab = container.querySelector<HTMLButtonElement>('[aria-label="New tab"]');
    if (!newTab) throw new Error("Expected new tab button.");
    await act(async () => { newTab.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  }

  async function expectSwitchCancelsCapture(
    owner: Element,
    target: Element,
    pointerId: number,
    before: ChemDraftDocument,
    beforeHistory: { past: ChemDraftDocument[]; future: ChemDraftDocument[] }
  ) {
    expect(captures.get(pointerId)).toBe(owner);
    expect(captureSets).toContainEqual({ owner, pointerId });
    await switchToNewTab();
    expect(captures.has(pointerId)).toBe(false);
    expect(captureReleases.filter((release) => release.pointerId === pointerId)).toEqual([{ owner, pointerId }]);

    const secondDocument = snapshot();
    const secondHistory = await historyStacks();
    await act(async () => {
      dispatchPointer(target, "pointermove", { x: 700, y: 500 }, pointerId);
      dispatchPointer(target, "pointerup", { x: 700, y: 500 }, pointerId);
    });
    expect(snapshot()).toEqual(secondDocument);
    expect(await historyStacks()).toEqual(secondHistory);

    await act(async () => { inactiveTab().dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(snapshot()).toEqual(before);
    expect(await historyStacks()).toEqual(beforeHistory);
  }

  it("releases an object move capture when switching tabs", async () => {
    const document = insertNativeArtGraphicObject(createPhase4Document("Move capture"), { x: 220, y: 180 }, "tool.art.rect");
    const objectId = document.selection.objectIds[0]!;
    await render(document);
    await command("layout.rotate90");
    const before = snapshot();
    const beforeHistory = await historyStacks();
    const target = object(objectId);
    const start = { x: 250, y: 210 };
    await act(async () => { dispatchPointer(target, "pointerdown", start, 71); });
    await expectSwitchCancelsCapture(target, target, 71, before, beforeHistory);
  });

  it("releases a direct-edit handle capture when switching tabs", async () => {
    let document = applyNativeTemplateToolAtPoint(createPhase4Document("Handle capture"), { x: 250, y: 260 }, "benzene");
    const molecule = document.pages[0].objects.find((candidate) => candidate.type === "molecule");
    if (!molecule || molecule.type !== "molecule") throw new Error("Expected molecule.");
    document = createMechanismArrowBetween(document, "full-headed",
      { kind: "atom", objectId: molecule.id, atomId: molecule.atoms[0]!.id },
      { kind: "atom", objectId: molecule.id, atomId: molecule.atoms[3]!.id });
    await render(document);
    await command("layout.rotate90");
    const before = snapshot();
    const beforeHistory = await historyStacks();
    const handle = container.querySelector<HTMLButtonElement>('[data-mechanism-handle-index="0"]');
    if (!handle) throw new Error("Expected direct-edit handle.");
    await act(async () => { dispatchPointer(handle, "pointerdown", { x: 250, y: 260 }, 72); });
    await expectSwitchCancelsCapture(handle, handle, 72, before, beforeHistory);
  });

  it("releases a marquee page capture when switching tabs", async () => {
    const document = insertNativeArtGraphicObject(createPhase4Document("Marquee capture"), { x: 220, y: 180 }, "tool.art.rect");
    await render(document);
    await command("layout.rotate90");
    const before = snapshot();
    const beforeHistory = await historyStacks();
    const target = page();
    await act(async () => { dispatchPointer(target, "pointerdown", { x: 80, y: 80 }, 73); });
    await expectSwitchCancelsCapture(target, target, 73, before, beforeHistory);
  });
});
