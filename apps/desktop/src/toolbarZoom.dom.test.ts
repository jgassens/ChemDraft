// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "./MainWindow";
import { PaletteWindow } from "./PaletteWindow";
import { createPhase4Document } from "./documentWorkflow";
import { DocumentZoomControls } from "./toolbars/DocumentZoomControls";
import { ToolbarWidgetStateContext } from "./toolbars/toolbarWidgets";
import { DOM_COMMAND_EVENT, TOOLSET_ZOOM_EVENT, broadcastToolsetZoom, listenForToolsetZoom,
  listenForToolsetZoomRequests, requestToolsetZoom } from "./window-manager";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@scena/react-ruler", () => ({ default: () => null }));
describe("document zoom toolbar", () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    localStorage.clear(); window.history.replaceState(null, "", "/?agentBridge=1");
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); delete window.__CHEMDRAFT_AGENT__;
    window.history.replaceState(null, "", "/"); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear();
  });
  const select = () => container.querySelector<HTMLSelectElement>('[aria-label="Document zoom percentage"]')!;
  const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  async function choose(value: string) {
    await act(async () => { select().value = value; select().dispatchEvent(new Event("change", { bubbles: true })); });
  }
  async function command(commandId: string) {
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })));
  }
  async function mountMain(nativePalette = false, rulersVisible = false) {
    await act(async () => root.render(createElement(MainWindow, { initialDocument: createPhase4Document("Zoom test"),
      initialPaletteMode: nativePalette ? "hidden" : "floating", nativePalette,
      initialRulersVisible: rulersVisible, initialCrosshairsVisible: false })));
  }
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();

  it.each([false, true])("keeps the visible center fixed after scrolling, with rulers=%s", async rulers => {
    const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.set(++frameId, callback); return frameId; });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
    await mountMain(false, rulers);
    const canvas = container.querySelector<HTMLElement>('[aria-label="Document workspace"]')!;
    Object.defineProperties(canvas, { clientLeft: { value: 2 }, clientTop: { value: 3 },
      clientWidth: { value: 1000 }, clientHeight: { get: () =>
        (snapshot().viewport as { scale: number }).scale > 1.5 ? 685 : 700 } });
    const rect = (left: number, top: number, width: number, height: number) =>
      ({ left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) });
    canvas.getBoundingClientRect = () => rect(140, 90, 1019, 718);
    canvas.scrollLeft = 180; canvas.scrollTop = 240;
    const page = container.querySelector<HTMLElement>(".page")!;
    const stage = container.querySelector<HTMLElement>(".page-stage")!;
    // Model the actual page-stage CSS: centered page, minimum stage width, asymmetric ruler padding.
    page.getBoundingClientRect = () => {
      const scale = Number(stage.style.getPropertyValue("--page-scale"));
      const tx = parseFloat(stage.style.getPropertyValue("--page-translate-x")) || 0;
      const ty = parseFloat(stage.style.getPropertyValue("--page-translate-y")) || 0;
      const width = 816 * scale, height = 1056 * scale;
      const stageWidth = Math.max(1000, 900, width + 136);
      return rect(142 + (stageWidth - width) / 2 + (rulers ? 16 : 0) - canvas.scrollLeft + tx,
        93 + (rulers ? 76 : 44) - canvas.scrollTop + ty, width, height);
    };
    const focalPagePoint = () => {
      const pageRect = page.getBoundingClientRect();
      const scale = (snapshot().viewport as { scale: number }).scale;
      const centerX = rulers ? 658 : 642;
      const centerY = 93 + canvas.clientHeight / 2 + (rulers ? 16 : 0);
      return { x: (centerX - pageRect.left) / scale, y: (centerY - pageRect.top) / scale };
    };
    const anchor = focalPagePoint(); const original = snapshot().document;
    for (const action of ["view.zoomIn", "view.zoomOut", "view.zoomPercent.400", "view.zoomPercent.200"]) {
      await command(action);
      const pending = [...frames.values()]; frames.clear();
      await act(async () => pending.forEach(callback => callback(0)));
      expect(focalPagePoint().x).toBeCloseTo(anchor.x, 6);
      expect(focalPagePoint().y).toBeCloseTo(anchor.y, 6);
      expect(snapshot().viewport).toMatchObject({ translateX: 0, translateY: 0 });
      expect(snapshot().document).toEqual(original);
    }
    expect(canvas.scrollLeft).toBeGreaterThan(180);
  });

  it("invokes buttons and exact preset commands once and displays intermediate percentages", async () => {
    const invoke = vi.fn();
    const render = async (scale: number) => act(async () => root.render(createElement(ToolbarWidgetStateContext.Provider,
      { value: { currentZoom: { scale, minZoom: 0.25, maxZoom: 8.5 }, onInvoke: invoke } }, createElement(DocumentZoomControls))));
    await render(1.25);
    expect(select().selectedOptions[0].textContent).toBe("125%");
    expect(Array.from(select().options).filter(option => !option.disabled).map(option => option.textContent))
      .toEqual(["25%", "50%", "75%", "100%", "200%", "400%"]);
    await act(async () => {
      button("Zoom In").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
      button("Zoom In").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      button("Zoom In").click();
    });
    await act(async () => button("Zoom Out").click());
    await choose("25");
    expect(invoke.mock.calls).toEqual([["view.zoomIn"], ["view.zoomOut"], ["view.zoomPercent.25"]]);
    await render(0.25); expect(button("Zoom Out").disabled).toBe(true);
    await render(8.5); expect(button("Zoom In").disabled).toBe(true);
  });

  it("zooms Main through all presets without changing the document or undo history", async () => {
    await mountMain();
    const original = snapshot().document;
    for (const percent of [25, 50, 75, 100, 200, 400]) {
      await choose(String(percent));
      expect((snapshot().viewport as { scale: number }).scale).toBe(percent / 100);
      expect(select().value).toBe(String(percent));
      expect(snapshot().document).toEqual(original);
      expect(snapshot().file.dirty).toBe(false);
    }
    await act(async () => button("Zoom In").click());
    expect((snapshot().viewport as { scale: number }).scale).toBe(6);
    expect(select().selectedOptions[0].textContent).toBe("600%");
    await act(async () => button("Zoom Out").click()); expect(select().value).toBe("400");
    await command("edit.undo"); expect(snapshot().document).toEqual(original);
  });

  it("tracks wheel zoom and active tab changes", async () => {
    await mountMain(); await choose("200");
    const canvas = container.querySelector('[aria-label="Document workspace"]')!;
    await act(async () => canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true,
      ctrlKey: true, deltaY: -100, clientX: 200, clientY: 200 })));
    const scale = (snapshot().viewport as { scale: number }).scale;
    expect(scale).toBeGreaterThan(2);
    expect(scale).toBeCloseTo(2 * Math.exp(0.2), 9);
    expect(select().selectedOptions[0].textContent).toBe(`${Number((scale * 100).toFixed(1))}%`);
    await command("document.new"); expect(select().value).toBe("100");
    const tabs = container.querySelectorAll<HTMLButtonElement>('button[role="tab"]');
    await act(async () => tabs[0].click());
    expect((snapshot().viewport as { scale: number }).scale).toBe(scale);
  });

  it("steps 100 → 125 → 150 → 200 and reverses, keeping the dropdown presets unchanged", async () => {
    await mountMain();
    for (const percent of [125, 150, 200]) {
      await act(async () => button("Zoom In").click());
      expect((snapshot().viewport as { scale: number }).scale).toBe(percent / 100);
      expect(select().selectedOptions[0].textContent).toBe(`${percent}%`);
    }
    for (const percent of [150, 125, 100]) {
      await act(async () => button("Zoom Out").click());
      expect((snapshot().viewport as { scale: number }).scale).toBe(percent / 100);
    }
    expect(Array.from(select().options).map(option => option.textContent))
      .toEqual(["25%", "50%", "75%", "100%", "200%", "400%"]);
  });

  it("initializes a detached palette on request and follows validated zoom broadcasts", async () => {
    const answer = vi.fn(() => { void broadcastToolsetZoom({ scale: 0.75, minZoom: 0.25, maxZoom: 8.5 }); });
    const stopRequest = await listenForToolsetZoomRequests(answer);
    try {
      await act(async () => root.render(createElement(PaletteWindow, { toolsetId: "core.main" })));
      expect(answer).toHaveBeenCalled(); expect(select().value).toBe("75");
      await act(async () => broadcastToolsetZoom({ scale: 2, minZoom: 0.25, maxZoom: 8.5 }));
      expect(select().value).toBe("200");
      await act(async () => window.dispatchEvent(new CustomEvent(TOOLSET_ZOOM_EVENT,
        { detail: { scale: NaN, minZoom: 0.25, maxZoom: 8.5 } })));
      expect(select().value).toBe("200");
    } finally { stopRequest(); }
  });

  it("cleans up zoom listeners and replies to requests with the current main view", async () => {
    await mountMain(true); await command("view.zoomPercent.25");
    const receive = vi.fn(); const stop = await listenForToolsetZoom(receive);
    await act(async () => requestToolsetZoom());
    expect(receive).toHaveBeenLastCalledWith({ scale: 0.25, minZoom: 0.25, maxZoom: 8.5 });
    stop(); receive.mockClear(); await act(async () => requestToolsetZoom()); expect(receive).not.toHaveBeenCalled();
  });
});
