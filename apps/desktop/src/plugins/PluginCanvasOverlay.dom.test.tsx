// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginCanvasOverlayContributionSchema } from "@chemdraft/plugin-api";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { PluginCanvasOverlay } from "./PluginCanvasOverlay";
import type { PluginPanelActionHandler } from "./pluginPanelActionTypes";
import { MemoryStorage } from "../testSupport/memoryStorage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const overlay = PluginCanvasOverlayContributionSchema.parse({
  id: "overlay.widget.prompt", title: "Assistant", icon: "data:image/png;base64,AA==",
  commandId: "plugin.widget.submit", defaultCorner: "bottom-right",
  prompt: { kind: "prompt", id: "message", commandId: "plugin.widget.submit", label: "Message", maxLength: 20,
    select: { id: "provider", label: "Provider", value: "codex", options: [
      { value: "codex", label: "Codex" }, { value: "claude", label: "Claude" }
    ] } }
});
const storageKey = `chemdraft:canvas-overlay:main:${overlay.id}`;
const collapsedKey = `${storageKey}:collapsed`;
const expandedKey = `${storageKey}:expanded`;
let container: HTMLDivElement;
let root: Root;
let viewport: HTMLDivElement;
let statusRow: HTMLDivElement;
let rulerLeft: HTMLDivElement;
let rulerTop: HTMLDivElement;
let drawing: HTMLButtonElement;
let action: ReturnType<typeof vi.fn<PluginPanelActionHandler>>;
let openPanel: ReturnType<typeof vi.fn>;
let gestureActive: boolean;
let status: string;
let withPanel: boolean;
let panelTitle: string | undefined;
let platform: ShortcutPlatform;
class CanvasOverlayStatusSource {
  private readonly statuses = new Map<string, string>();
  private readonly listeners = new Set<() => void>();

  getCanvasOverlayStatuses = (): ReadonlyMap<string, string> => this.statuses;
  subscribeCanvasOverlayStatus = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  setStatus(overlayId: string, value: string): void {
    this.statuses.set(overlayId, value);
    this.emit();
  }
  unregister(overlayId: string): void {
    this.statuses.delete(overlayId);
    this.emit();
  }
  get subscriberCount(): number { return this.listeners.size; }
  private emit(): void { this.listeners.forEach(listener => listener()); }
}
let statusSource: CanvasOverlayStatusSource;
const viewportRef = createRef<HTMLElement>();
const overlayLayerRef = createRef<HTMLElement>();
const statusRowRef = createRef<HTMLElement>();
let viewportWidth: number;
let viewportHeight: number;

function pointer(target: Element, type: string, x: number, y: number): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
  Object.defineProperty(event, "pointerId", { value: 1 });
  target.dispatchEvent(event);
}
function enterText(value: string): void {
  const textarea = container.querySelector("textarea")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}
async function render(windowId = "main"): Promise<void> {
  await act(async () => root.render(<PluginCanvasOverlay overlay={overlay} viewportRef={viewportRef}
    overlayLayerRef={overlayLayerRef} statusRowRef={statusRowRef}
    gestureActive={gestureActive} status={status} onAction={action} windowId={windowId} shortcutPlatform={platform}
    statusSource={statusSource}
    onOpenPanel={withPanel ? openPanel : undefined} panelTitle={panelTitle} onFocusDrawing={() => drawing.focus()} />));
}
async function expand(): Promise<void> {
  await act(async () => container.querySelector<HTMLButtonElement>(".plugin-canvas-overlay-icon")!.click());
}
function widget(): HTMLDivElement { return container.querySelector(".plugin-canvas-overlay")!; }

describe("PluginCanvasOverlay", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", new MemoryStorage()); gestureActive = false; status = ""; withPanel = false; panelTitle = undefined; platform = "macos";
    statusSource = new CanvasOverlayStatusSource();
    action = vi.fn<PluginPanelActionHandler>().mockResolvedValue({ ok: true }); openPanel = vi.fn();
    viewportWidth = 600; viewportHeight = 400;
    viewport = document.createElement("div"); viewportRef.current = viewport; overlayLayerRef.current = viewport;
    statusRow = document.createElement("div"); statusRowRef.current = statusRow;
    rulerLeft = document.createElement("div"); rulerLeft.className = "ruler-left";
    rulerTop = document.createElement("div"); rulerTop.className = "ruler-top";
    container = document.createElement("div"); drawing = document.createElement("button"); drawing.textContent = "Drawing";
    viewport.append(rulerLeft, rulerTop, container, drawing, statusRow); document.body.append(viewport); drawing.focus(); root = createRoot(container);
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, get: () => viewportWidth - 16 },
      clientHeight: { configurable: true, get: () => viewportHeight }
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === viewport) return { x: 0, y: 0, left: 0, top: 0, right: viewportWidth, bottom: viewportHeight,
        width: viewportWidth, height: viewportHeight, toJSON() {} };
      if (this === statusRow) return { x: 0, y: viewportHeight - 24, left: 0, top: viewportHeight - 24,
        right: viewportWidth, bottom: viewportHeight, width: viewportWidth, height: 24, toJSON() {} };
      if (this === rulerLeft) return { x: 0, y: 0, left: 0, top: 0, right: 32, bottom: viewportHeight,
        width: 32, height: viewportHeight, toJSON() {} };
      if (this === rulerTop) return { x: 0, y: 0, left: 0, top: 0, right: viewportWidth - 16, bottom: 32,
        width: viewportWidth - 16, height: 32, toJSON() {} };
      const width = this.dataset.expanded === "true" ? 300 : 36;
      const height = this.dataset.expanded === "true" ? 220 : 36;
      return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON() {} };
    });
    await render();
  });
  afterEach(async () => { await act(async () => root.unmount()); viewport.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("starts collapsed at the declared corner, expands on click, and Esc restores drawing focus and preserves the draft", async () => {
    expect(document.activeElement).toBe(drawing);
    // The 16 px scrollbar, 24 px status strip, and measured rulers are outside the drawing area.
    expect(widget().style.left).toBe("536px"); expect(widget().style.top).toBe("328px");
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Assistant");
    expect(widget().dataset.expanded).toBe("false"); await expand();
    const textarea = container.querySelector("textarea")!;
    expect(document.activeElement).toBe(textarea); expect(widget().dataset.expanded).toBe("true");
    await act(async () => enterText("Keep this"));
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(widget().dataset.expanded).toBe("false"); expect(document.activeElement).toBe(drawing);
    await expand(); expect(textarea.value).toBe("Keep this");
  });

  it("clamps header drags to every viewport edge and restores the saved place on remount", async () => {
    await expand(); const header = container.querySelector(".plugin-canvas-overlay-header")!;
    await act(async () => { pointer(header, "pointerdown", 310, 180); pointer(header, "pointermove", -1000, -1000); });
    expect(widget().style.left).toBe("32px"); expect(widget().style.top).toBe("32px");
    await act(async () => pointer(header, "pointermove", 2000, 2000));
    expect(widget().style.left).toBe("284px"); expect(widget().style.top).toBe("156px");
    await act(async () => pointer(header, "pointerup", 2000, 2000));
    expect(JSON.parse(window.localStorage.getItem(expandedKey)!)).toEqual({ x: 284, y: 156 });
    await act(async () => root.unmount()); root = createRoot(container); await render();
    expect(widget().style.left).toBe("536px"); expect(widget().style.top).toBe("328px");
    await expand();
    expect(widget().style.left).toBe("284px"); expect(widget().style.top).toBe("156px");
  });

  it("re-clamps a remembered position on load and when the visible drawing area resizes", async () => {
    await act(async () => root.unmount()); window.localStorage.setItem(collapsedKey, JSON.stringify({ x: 900, y: 900 }));
    root = createRoot(container); await render();
    expect(widget().style.left).toBe("548px"); expect(widget().style.top).toBe("340px");
    viewportWidth = 500; viewportHeight = 300;
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(widget().style.left).toBe("448px"); expect(widget().style.top).toBe("240px");
  });

  it("migrates old header positions to the box without moving the icon, and scopes them to the window", async () => {
    await act(async () => root.unmount());
    window.localStorage.setItem(storageKey, JSON.stringify({ x: 120, y: 80 }));
    root = createRoot(container); await render();
    expect(widget().style.left).toBe("536px"); expect(widget().style.top).toBe("328px");
    await expand(); expect(widget().style.left).toBe("120px"); expect(widget().style.top).toBe("80px");
    await act(async () => root.unmount()); root = createRoot(container); await render("second-window");
    await expand(); expect(widget().style.left).toBe("284px"); expect(widget().style.top).toBe("156px");
    expect(JSON.parse(window.localStorage.getItem(expandedKey)!)).toEqual({ x: 120, y: 80 });
  });

  it("drags the collapsed icon beyond a threshold, suppresses the drag click, and anchors expansion nearby", async () => {
    const icon = container.querySelector<HTMLButtonElement>(".plugin-canvas-overlay-icon")!;
    await act(async () => {
      pointer(icon, "pointerdown", 550, 340);
      pointer(icon, "pointermove", 250, 140);
      pointer(icon, "pointerup", 250, 140);
      icon.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    expect(widget().dataset.expanded).toBe("false");
    expect(widget().style.left).toBe("236px"); expect(widget().style.top).toBe("128px");
    expect(JSON.parse(window.localStorage.getItem(collapsedKey)!)).toEqual({ x: 236, y: 128 });
    await act(async () => {
      pointer(icon, "pointerdown", 250, 140); pointer(icon, "pointermove", 252, 141);
      pointer(icon, "pointerup", 252, 141); icon.click();
    });
    expect(widget().dataset.expanded).toBe("true");
    expect(widget().style.left).toBe("236px"); expect(widget().style.top).toBe("128px");
    const header = container.querySelector(".plugin-canvas-overlay-header")!;
    await act(async () => { pointer(header, "pointerdown", 250, 140); pointer(header, "pointermove", 46, 44); pointer(header, "pointerup", 46, 44); });
    expect(JSON.parse(window.localStorage.getItem(expandedKey)!)).toEqual({ x: 32, y: 32 });
    expect(JSON.parse(window.localStorage.getItem(collapsedKey)!)).toEqual({ x: 236, y: 128 });
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Collapse Assistant"]')!.click());
    expect(widget().style.left).toBe("236px"); expect(widget().style.top).toBe("128px");
    await act(async () => root.unmount()); root = createRoot(container); await render();
    expect(widget().style.left).toBe("236px"); expect(widget().style.top).toBe("128px");
    await expand(); expect(widget().style.left).toBe("32px"); expect(widget().style.top).toBe("32px");
  });

  it("clamps both saved modes on resize, including the hidden icon, and caps the box to the drawing area", async () => {
    await expand();
    viewportWidth = 260; viewportHeight = 250;
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(widget().style.maxWidth).toBe("212px");
    expect(widget().style.maxHeight).toBe("194px");
    expect(widget().style.left).toBe("32px"); expect(widget().style.top).toBe("32px");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Collapse Assistant"]')!.click());
    expect(widget().style.left).toBe("208px"); expect(widget().style.top).toBe("190px");
    expect(JSON.parse(window.localStorage.getItem(collapsedKey)!)).toEqual({ x: 208, y: 190 });
    expect(JSON.parse(window.localStorage.getItem(expandedKey)!)).toEqual({ x: 32, y: 32 });
  });

  it("stops overlay pointer and keyboard events before they reach the canvas", async () => {
    const seen = vi.fn(); viewport.addEventListener("pointerdown", seen); viewport.addEventListener("keydown", seen);
    await expand();
    await act(async () => pointer(container.querySelector("textarea")!, "pointerdown", 10, 10));
    await act(async () => container.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true })));
    expect(seen).not.toHaveBeenCalled();
  });

  it("blocks webview reload chords while the prompt owns focus", async () => {
    platform = "windows"; await render(); await expand();
    for (const init of [{ key: "F5" }, { key: "r", ctrlKey: true }, { key: "r", ctrlKey: true, shiftKey: true }]) {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      await act(async () => container.querySelector("textarea")!.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
    }
    platform = "macos"; await render();
    const event = new KeyboardEvent("keydown", { key: "F5", bubbles: true, cancelable: true });
    await act(async () => container.querySelector("textarea")!.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
  });

  it("hides for a canvas gesture and shows the status without taking focus on updates", async () => {
    await expand(); drawing.focus(); gestureActive = true; await render(); expect(widget().hidden).toBe(true);
    gestureActive = false; status = "Drawing 3 structures…"; await render(); expect(widget().hidden).toBe(false);
    expect(container.querySelector("[role=status]")?.textContent).toBe(status); expect(document.activeElement).toBe(drawing);
  });

  it("re-renders status-source updates without a parent render", async () => {
    expect(container.querySelector("[role=status]")?.textContent).toBe("");
    await act(async () => statusSource.setStatus(overlay.id, "Drawing 3 structures…"));
    expect(container.querySelector("[role=status]")?.textContent).toBe("Drawing 3 structures…");
  });

  it("clears an old status when its plugin unregisters before an overlay id is reused", async () => {
    await act(async () => statusSource.setStatus(overlay.id, "Working…"));
    expect(container.querySelector("[role=status]")?.textContent).toBe("Working…");
    await act(async () => statusSource.unregister(overlay.id));
    expect(container.querySelector("[role=status]")?.textContent).toBe("");
  });

  it("unsubscribes from the status source when unmounted", async () => {
    expect(statusSource.subscriberCount).toBe(1);
    await act(async () => root.unmount());
    expect(statusSource.subscriberCount).toBe(0);
    root = createRoot(container);
    await render();
  });

  it("sends Enter with the choice, leaves Shift+Enter and IME alone, and keeps refused drafts", async () => {
    action.mockResolvedValueOnce({ ok: false, message: "Finish the pending confirmation." });
    await expand(); const textarea = container.querySelector("textarea")!;
    await act(async () => enterText("Draw aspirin"));
    for (const init of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
      await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...init })));
    }
    expect(action).not.toHaveBeenCalled();
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(action).toHaveBeenCalledWith({ sectionId: overlay.prompt.id, control: "prompt", text: "Draw aspirin", selected: "codex" });
    expect(textarea.value).toBe("Draw aspirin"); expect(textarea.disabled).toBe(false);
    expect(container.querySelector("[role=alert]")?.textContent).toBe("Finish the pending confirmation.");
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(textarea.value).toBe("");
  });

  it("includes a changed choice in Send and catches action rejection inline", async () => {
    await expand(); const select = container.querySelector("select")!;
    await act(async () => { select.value = "claude"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(action).toHaveBeenLastCalledWith({ sectionId: overlay.prompt.id, control: "select", controlId: "provider", selected: "claude" });
    action.mockRejectedValueOnce(new Error("No host")); await act(async () => enterText("Try again"));
    await act(async () => container.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(action).toHaveBeenLastCalledWith({ sectionId: overlay.prompt.id, control: "prompt", text: "Try again", selected: "claude" });
    expect(container.querySelector("[role=alert]")?.textContent).toBe("The action could not be completed.");
    expect(container.querySelector("textarea")!.value).toBe("Try again");
  });

  it("only shows the panel link for a contributed panel and invokes its open path", async () => {
    await expand(); expect(container.querySelector(".plugin-canvas-overlay-panel")).toBeNull(); withPanel = true; panelTitle = "Assistant panel"; await render();
    expect(container.querySelector(".plugin-canvas-overlay-panel")?.textContent).toBe("Open Assistant panel");
    await act(async () => container.querySelector<HTMLButtonElement>(".plugin-canvas-overlay-panel")!.click());
    expect(openPanel).toHaveBeenCalledOnce();
  });

  it("uses a generic panel label when no title is supplied", async () => {
    withPanel = true; await render(); await expand();
    expect(container.querySelector(".plugin-canvas-overlay-panel")?.textContent).toBe("Open panel");
  });

  it("works outside Tauri when storage is unavailable or malformed", async () => {
    await act(async () => root.unmount());
    window.localStorage.setItem(collapsedKey, '{"x":"bad","y":null}');
    window.localStorage.setItem(expandedKey, "not JSON");
    root = createRoot(container); await render(); expect(widget().style.left).toBe("536px");
    await act(async () => root.unmount());
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => { throw new Error("Storage blocked"); });
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("Storage blocked"); });
    root = createRoot(container); await render(); await expand(); const header = container.querySelector(".plugin-canvas-overlay-header")!;
    await act(async () => { pointer(header, "pointerdown", 0, 0); pointer(header, "pointermove", 10, 10); pointer(header, "pointerup", 10, 10); });
    expect(widget().hidden).toBe(false);
  });
});
