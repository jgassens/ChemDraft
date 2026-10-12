// @vitest-environment jsdom
import { applyPatch, type GraphicObject } from "@chemdraft/chem-core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeArtGraphicObject } from "./documentWorkflow";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("square-corner radius and resize handles", () => {
  let container: HTMLDivElement;
  let root: Root;
  let objectId: string;
  const pointerDescriptors = new Map<string, PropertyDescriptor | undefined>();

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0));
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => window.clearTimeout(handle));
    for (const name of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) {
      pointerDescriptors.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value: () => false });
    }
    window.history.replaceState(null, "", "/?agentBridge=1&artStyleQa=0");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    for (const [name, descriptor] of pointerDescriptors) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, name);
    }
    vi.unstubAllGlobals();
  });

  function page() { return container.querySelector<HTMLElement>(".page")!; }
  function graphic(): GraphicObject {
    const result = window.__CHEMDRAFT_AGENT__!.debugArtObject(objectId);
    if (!result.ok) throw new Error(result.error);
    return result.object;
  }
  function radiusHandle() { return container.querySelector<HTMLButtonElement>("[data-graphic-corner-radius-handle]")!; }
  function dispatch(target: EventTarget, type: string, point: { x: number; y: number }, pointerId = 1) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: point.x, clientY: point.y });
    Object.defineProperties(event, { pointerId: { value: pointerId }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
    target.dispatchEvent(event);
  }
  async function render(width = 100, rotation = 0) {
    const inserted = insertNativeArtGraphicObject(createPhase4Document("Square corner"), { x: 220, y: 180 }, "tool.art.rect");
    objectId = inserted.selection.objectIds[0];
    const document = applyPatch(inserted, { op: "updateObject", objectId, changes: { width, height: 100, rotation } });
    await act(async () => root.render(createElement(MainWindow, { initialDocument: document, initialCrosshairsVisible: false, initialRulersVisible: false, initialPaletteMode: "hidden", nativePalette: true })));
    page().getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: 792, height: 612, right: 792, bottom: 612, toJSON: () => ({}) });
  }
  function handlePoint() {
    const object = graphic();
    const localX = Number(radiusHandle().style.left.match(/calc\(([-\d.]+)px/)![1]);
    const angle = object.rotation * Math.PI / 180;
    const dx = localX - object.width / 2;
    const dy = -object.height / 2;
    return { x: object.x + object.width / 2 + dx * Math.cos(angle) - dy * Math.sin(angle), y: object.y + object.height / 2 + dx * Math.sin(angle) + dy * Math.cos(angle) };
  }

  it("leaves the top-left resize target centre clear and starts a resize there", async () => {
    await render();
    const before = graphic();
    const radius = handlePoint();
    const centre = { x: before.x + 1, y: before.y + 1 }; // -8px offset + 18px / 2
    expect(radius.x - 4.5).toBeGreaterThan(before.x + 10);
    expect(Math.abs(radius.x - centre.x)).toBeGreaterThan(4.5);
    // jsdom does not hit-test CSS. The geometry assertion above checks that
    // the higher-z radius target cannot take this coordinate in a webview.
    const resize = container.querySelector<HTMLButtonElement>('[data-object-resize-corner="top-left"]')!;
    expect(resize).not.toBeNull();
    await act(async () => dispatch(resize, "pointerdown", centre));
    await act(async () => dispatch(page(), "pointermove", { x: centre.x - 12, y: centre.y - 12 }));
    await act(async () => dispatch(page(), "pointerup", { x: centre.x - 12, y: centre.y - 12 }));
    expect(graphic().width).toBeGreaterThan(before.width);
    expect(graphic().data.cornerRadiusPx ?? 0).toBe(0);
  });

  it.each([[100, 0], [10, 0], [100, 37], [10, 37]])("edits from the displaced target without a jump (width %s, rotation %s)", async (width, rotation) => {
    await render(width, rotation);
    const start = handlePoint();
    const before = graphic();
    await act(async () => dispatch(radiusHandle(), "pointerdown", start));
    expect(graphic().data.cornerRadiusPx ?? 0).toBe(0);
    expect(container.textContent).toContain("Adjust selected rectangle corner radius");
    await act(async () => dispatch(page(), "pointermove", start));
    expect(graphic().data.cornerRadiusPx ?? 0).toBe(0);
    const angle = rotation * Math.PI / 180;
    // Stay away from the existing 1px snap band at the maximum radius (5px
    // for the small rectangle), so this checks the exact displacement mapping.
    const end = { x: start.x + 3 * Math.cos(angle), y: start.y + 3 * Math.sin(angle) };
    await act(async () => dispatch(page(), "pointermove", end));
    expect(graphic().data.cornerRadiusPx).toBeCloseTo(3);
    await act(async () => dispatch(page(), "pointerup", end));
    expect(graphic().data.cornerRadiusPx).toBeCloseTo(3);
    expect(graphic().width).toBe(before.width);
    expect(graphic().rotation).toBe(before.rotation);
  });
});
