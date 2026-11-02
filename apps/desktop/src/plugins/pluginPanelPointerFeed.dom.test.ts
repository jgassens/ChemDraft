// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LinkedFigureView } from "./LinkedFigureView";
import { installPluginPanelPointerFeed } from "./pluginPanelPointerFeed";

const feed = vi.hoisted(() => ({
  move: undefined as undefined | ((point: { x: number; y: number }) => void),
  leave: undefined as undefined | (() => void),
  unlisten: vi.fn(),
  listen: vi.fn()
}));
vi.mock("../window-manager", () => ({
  listenForPalettePointer: async (label: string, handler: typeof feed.move) => {
    feed.listen(label); feed.move = handler; return feed.unlisten;
  },
  listenForPalettePointerLeave: async (_label: string, handler: typeof feed.leave) => {
    feed.leave = handler; return feed.unlisten;
  },
  isDesktopRuntime: () => false
}));
let cleanup: (() => void) | undefined;
let root: Root | undefined;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  act(() => cleanup?.()); cleanup = undefined;
  act(() => root?.unmount()); root = undefined;
  document.body.replaceChildren();
  Reflect.deleteProperty(document, "elementFromPoint");
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks();
});

function mountSpectrum(): { svg: SVGSVGElement; peak: Element; atom: Element; moveTo: (target: Element, x?: number) => void } {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(createElement(LinkedFigureView, {
    spectrum: { nucleus: "1H", domain: { min: 0, max: 8 }, reversed: true,
      peaks: [{ id: "p1", ppm: 7.2, intensity: 1, label: "7.20", atomIndices: [0] }] },
    structure: { atoms: [{ index: 0, x: 0, y: 0, element: "C" }], bonds: [] }
  })));
  const svg = container.querySelector<SVGSVGElement>(".lf-spectrum")!;
  const peak = container.querySelector(".lf-peak")!;
  const atom = container.querySelector(".lf-atom")!;
  const hitTest = vi.fn((): Element => svg);
  Object.defineProperty(document, "elementFromPoint", { value: hitTest, configurable: true });
  cleanup = installPluginPanelPointerFeed("panel.test");
  return { svg, peak, atom, moveTo: (target, x = 100) => {
    hitTest.mockReturnValue(target);
    act(() => feed.move!({ x, y: 40 }));
  } };
}

it("drives LinkedFigureView's existing mouse enter/leave highlighting in a non-key panel", async () => {
  const { svg, peak, atom, moveTo } = mountSpectrum();
  await Promise.resolve();
  moveTo(peak);
  expect(atom.classList.contains("is-active")).toBe(true);
  moveTo(svg);
  expect(atom.classList.contains("is-active")).toBe(false);
  moveTo(atom);
  expect(peak.classList.contains("is-active")).toBe(true);
  act(() => feed.leave!());
  expect(peak.classList.contains("is-active")).toBe(false);
});

it("preserves related targets so crossing a peak does not end a spectrum drag", async () => {
  const { svg, peak, moveTo } = mountSpectrum();
  await Promise.resolve();
  const out = vi.fn();
  svg.addEventListener("pointerout", out);
  moveTo(svg);
  // Zoom leaves room to pan. Exercise LinkedFigureView's real React pointerleave/endDrag handler.
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click());
  vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ left: 0, width: 640 } as DOMRect);
  let frame: FrameRequestCallback | undefined;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frame = callback; return 1; });
  const before = peak.querySelector(".lf-hit")!.getAttribute("x");
  act(() => svg.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 100 })));
  moveTo(peak, 110);
  expect((out.mock.calls[0]![0] as PointerEvent).relatedTarget).toBe(peak);
  expect(frame).toBeDefined();
  act(() => frame!(0));
  expect(peak.querySelector(".lf-hit")!.getAttribute("x")).not.toBe(before);
});

it("routes motion to pointer capture and defers boundary events until capture is released", async () => {
  const { svg, peak, atom, moveTo } = mountSpectrum();
  await Promise.resolve();
  moveTo(svg);
  const move = vi.fn(); const out = vi.fn();
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerout", out);
  const captureEvent = (type: string): void => {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, "pointerId", { value: 7 });
    svg.dispatchEvent(event);
  };
  captureEvent("gotpointercapture");
  moveTo(peak, 110);
  moveTo(atom, 120);
  act(() => feed.leave!());
  expect(out).not.toHaveBeenCalled();
  expect(move).toHaveBeenCalledTimes(2);
  expect((move.mock.calls[1]![0] as PointerEvent).target).toBe(svg);
  expect((move.mock.calls[1]![0] as PointerEvent).pointerId).toBe(7);
  act(() => captureEvent("lostpointercapture"));
  expect(out).toHaveBeenCalledOnce();
  expect((out.mock.calls[0]![0] as PointerEvent).relatedTarget).toBeNull();
});

it("keeps hover and chart pointer motion working in a non-key panel, without requesting focus", async () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  const button = document.createElement("button");
  document.body.append(button);
  const hitTest = vi.fn(() => button);
  Object.defineProperty(document, "elementFromPoint", { value: hitTest, configurable: true });
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  const move = vi.fn(); const over = vi.fn(); const out = vi.fn();
  button.addEventListener("pointermove", move);
  button.addEventListener("pointerover", over);
  button.addEventListener("pointerout", out);
  cleanup = installPluginPanelPointerFeed("panel.test");
  await Promise.resolve();
  expect(feed.listen).toHaveBeenCalledWith("plugin-panel-panel:test");
  feed.move!({ x: 30, y: 40 });
  expect(over).toHaveBeenCalledOnce(); expect(move).toHaveBeenCalledOnce();
  expect(move.mock.calls[0]![0].clientX).toBe(30);
  expect(button.classList.contains("panel-synthetic-hover")).toBe(true);
  feed.leave!();
  expect(out).toHaveBeenCalledOnce();
  expect(button.classList.contains("panel-synthetic-hover")).toBe(false);
});

it("does not duplicate pointer events while the input has native keyboard focus", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const hitTest = vi.fn();
  Object.defineProperty(document, "elementFromPoint", { value: hitTest, configurable: true });
  cleanup = installPluginPanelPointerFeed("panel.test");
  await Promise.resolve();
  feed.move!({ x: 30, y: 40 });
  expect(hitTest).not.toHaveBeenCalled();
});
