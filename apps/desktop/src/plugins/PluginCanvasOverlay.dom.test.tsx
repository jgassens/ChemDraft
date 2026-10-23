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
let platform: ShortcutPlatform;
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
async function render(): Promise<void> {
  await act(async () => root.render(<PluginCanvasOverlay overlay={overlay} viewportRef={viewportRef}
    overlayLayerRef={overlayLayerRef} statusRowRef={statusRowRef}
    gestureActive={gestureActive} status={status} onAction={action} windowId="main" shortcutPlatform={platform}
    onOpenPanel={withPanel ? openPanel : undefined} onFocusDrawing={() => drawing.focus()} />));
}
async function expand(): Promise<void> {
  await act(async () => container.querySelector<HTMLButtonElement>(".plugin-canvas-overlay-icon")!.click());
}
function widget(): HTMLDivElement { return container.querySelector(".plugin-canvas-overlay")!; }

describe("PluginCanvasOverlay", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", new MemoryStorage()); gestureActive = false; status = ""; withPanel = false; platform = "macos";
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
    expect(JSON.parse(window.localStorage.getItem(storageKey)!)).toEqual({ x: 284, y: 156 });
    await act(async () => root.unmount()); root = createRoot(container); await render();
    expect(widget().style.left).toBe("284px"); expect(widget().style.top).toBe("156px");
  });

  it("re-clamps a remembered position on load and when the visible drawing area resizes", async () => {
    await act(async () => root.unmount()); window.localStorage.setItem(storageKey, JSON.stringify({ x: 900, y: 900 }));
    root = createRoot(container); await render();
    expect(widget().style.left).toBe("548px"); expect(widget().style.top).toBe("340px");
    viewportWidth = 500; viewportHeight = 300;
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(widget().style.left).toBe("448px"); expect(widget().style.top).toBe("240px");
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
    await expand(); expect(container.querySelector(".plugin-canvas-overlay-panel")).toBeNull(); withPanel = true; await render();
    await act(async () => container.querySelector<HTMLButtonElement>(".plugin-canvas-overlay-panel")!.click());
    expect(openPanel).toHaveBeenCalledOnce();
  });

  it("works outside Tauri when storage is unavailable or malformed", async () => {
    await act(async () => root.unmount()); window.localStorage.setItem(storageKey, '{"x":"bad","y":null}');
    root = createRoot(container); await render(); expect(widget().style.left).toBe("536px");
    await act(async () => root.unmount());
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => { throw new Error("Storage blocked"); });
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("Storage blocked"); });
    root = createRoot(container); await render(); await expand(); const header = container.querySelector(".plugin-canvas-overlay-header")!;
    await act(async () => { pointer(header, "pointerdown", 0, 0); pointer(header, "pointermove", 10, 10); pointer(header, "pointerup", 10, 10); });
    expect(widget().hidden).toBe(false);
  });
});
