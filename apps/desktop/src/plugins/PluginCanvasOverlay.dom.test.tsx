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
let drawing: HTMLButtonElement;
let action: ReturnType<typeof vi.fn<PluginPanelActionHandler>>;
let openPanel: ReturnType<typeof vi.fn>;
let gestureActive: boolean;
let status: string;
let withPanel: boolean;
let platform: ShortcutPlatform;
const viewportRef = createRef<HTMLElement>();

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
    viewport = document.createElement("div"); viewportRef.current = viewport;
    container = document.createElement("div"); drawing = document.createElement("button"); drawing.textContent = "Drawing";
    viewport.append(container, drawing); document.body.append(viewport); drawing.focus(); root = createRoot(container);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const width = this === viewport ? 600 : this.dataset.expanded === "true" ? 300 : 36;
      const height = this === viewport ? 400 : this.dataset.expanded === "true" ? 220 : 36;
      return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON() {} };
    });
    await render();
  });
  afterEach(async () => { await act(async () => root.unmount()); viewport.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("starts collapsed at the declared corner, expands on click, and Esc restores drawing focus and preserves the draft", async () => {
    expect(document.activeElement).toBe(drawing);
    expect(widget().style.left).toBe("552px"); expect(widget().style.top).toBe("352px");
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
    expect(widget().style.left).toBe("0px"); expect(widget().style.top).toBe("0px");
    await act(async () => pointer(header, "pointermove", 2000, 2000));
    expect(widget().style.left).toBe("300px"); expect(widget().style.top).toBe("180px");
    await act(async () => pointer(header, "pointerup", 2000, 2000));
    expect(JSON.parse(window.localStorage.getItem(storageKey)!)).toEqual({ x: 300, y: 180 });
    await act(async () => root.unmount()); root = createRoot(container); await render();
    expect(widget().style.left).toBe("300px"); expect(widget().style.top).toBe("180px");
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
    expect(action).toHaveBeenCalledWith({ sectionId: overlay.id, control: "prompt", text: "Draw aspirin", selected: "codex" });
    expect(textarea.value).toBe("Draw aspirin"); expect(textarea.disabled).toBe(false);
    expect(container.querySelector("[role=alert]")?.textContent).toBe("Finish the pending confirmation.");
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(textarea.value).toBe("");
  });

  it("includes a changed choice in Send and catches action rejection inline", async () => {
    await expand(); const select = container.querySelector("select")!;
    await act(async () => { select.value = "claude"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(action).toHaveBeenLastCalledWith({ sectionId: overlay.id, control: "select", controlId: "provider", selected: "claude" });
    action.mockRejectedValueOnce(new Error("No host")); await act(async () => enterText("Try again"));
    await act(async () => container.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(action).toHaveBeenLastCalledWith({ sectionId: overlay.id, control: "prompt", text: "Try again", selected: "claude" });
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
    root = createRoot(container); await render(); expect(widget().style.left).toBe("552px");
    await act(async () => root.unmount());
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => { throw new Error("Storage blocked"); });
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("Storage blocked"); });
    root = createRoot(container); await render(); await expand(); const header = container.querySelector(".plugin-canvas-overlay-header")!;
    await act(async () => { pointer(header, "pointerdown", 0, 0); pointer(header, "pointermove", 10, 10); pointer(header, "pointerup", 10, 10); });
    expect(widget().hidden).toBe(false);
  });
});
