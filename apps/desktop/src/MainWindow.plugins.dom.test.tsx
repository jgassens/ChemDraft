// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginCommandContext } from "@chemdraft/plugin-api";
import { MainWindow } from "./MainWindow";
import type { DesktopPluginRuntime } from "./plugins/createPluginRuntime";
import { MemoryStorage } from "./testSupport/memoryStorage";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
const captured = vi.hoisted(() => ({ runtime: undefined as DesktopPluginRuntime | undefined }));
vi.mock("./plugins/createPluginRuntime", async original => {
  const actual = await original<typeof import("./plugins/createPluginRuntime")>();
  return { ...actual, createPluginRuntime: (options: import("./plugins/createPluginRuntime").DesktopPluginRuntimeOptions) => {
    captured.runtime = actual.createPluginRuntime(options);
    return captured.runtime;
  } };
});
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
const pluginId = "org.chemdraft.overlayTest";
const overlayId = "overlay.overlayTest.prompt";
const commandId = "plugin.overlayTest.submit";
const selectId = "plugin.overlayTest.select";
const foreignId = "plugin.foreignOverlay.run";
const submit = vi.fn<(context: PluginCommandContext) => Promise<void>>();
const select = vi.fn<(context: PluginCommandContext) => Promise<void>>();
let root: Root;
let container: HTMLDivElement;
function input(value: string): void {
  const textarea = container.querySelector(".plugin-canvas-overlay textarea")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}
async function send(): Promise<void> {
  await act(async () => container.querySelector(".plugin-canvas-overlay textarea")!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
}

describe("MainWindow canvas overlays", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", new MemoryStorage()); vi.stubGlobal("ResizeObserver", TestResizeObserver); vi.stubGlobal("CSS", { escape: (value: string) => value });
    HTMLElement.prototype.setPointerCapture ??= () => {};
    HTMLElement.prototype.releasePointerCapture ??= () => {};
    HTMLElement.prototype.hasPointerCapture ??= () => false;
    submit.mockReset().mockResolvedValue(undefined); select.mockReset().mockResolvedValue(undefined);
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root.render(<MainWindow initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
    await act(async () => {
      captured.runtime!.registerPlugin({ id: pluginId, name: "Overlay test", version: "0.1.0", apiVersion: "^0.1.10",
        entry: "test.js", permissions: ["ui.canvas"], contributes: {
          commands: [{ id: commandId, title: "Send" }, { id: selectId, title: "Provider" }],
          canvasOverlays: [{ id: overlayId, title: "Assistant overlay", icon: "data:image/png;base64,AA==", commandId,
            prompt: { kind: "prompt", id: "message", commandId: selectId, label: "Message", select: {
              id: "provider", label: "Provider", value: "codex", commandId: selectId, options: [{ value: "codex", label: "Codex" }]
            } } }]
        }
      }, { commandHandlers: { [commandId]: submit, [selectId]: select } });
    });
    await act(async () => container.querySelector<HTMLButtonElement>(".plugin-canvas-overlay-icon")!.click());
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); captured.runtime = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  it("renders a registered overlay and delivers Enter to its own command with overlay input", async () => {
    expect(container.querySelector(".plugin-canvas-overlay")).not.toBeNull(); expect(container.querySelector(".page .plugin-canvas-overlay")).toBeNull();
    expect(container.querySelector(".plugin-canvas-overlay-panel")).toBeNull();
    await act(async () => input("Draw aspirin")); await send(); expect(submit).toHaveBeenCalledOnce(); expect(select).not.toHaveBeenCalled();
    expect(submit.mock.calls[0]![0].input).toEqual({ source: "overlay", overlayId, sectionId: overlayId,
      control: "prompt", text: "Draw aspirin", selected: "codex" });
    expect(container.querySelector<HTMLTextAreaElement>(".plugin-canvas-overlay textarea")!.value).toBe("");
  });

  it("resolves the live declaration and refuses a foreign command without clearing the draft", async () => {
    const foreign = vi.fn();
    await act(async () => captured.runtime!.registerPlugin({ id: "org.chemdraft.foreignOverlay", name: "Foreign",
      version: "0.1.0", apiVersion: "^0.1.10", entry: "test.js", permissions: [],
      contributes: { commands: [{ id: foreignId, title: "Foreign" }] }
    }, { commandHandlers: { [foreignId]: foreign } }));
    const declarations = captured.runtime!.listCanvasOverlays();
    // Only the host's live declaration changes; the widget still holds its rendered copy.
    vi.spyOn(captured.runtime!, "listCanvasOverlays").mockReturnValue(declarations.map(entry => ({
      ...entry, overlay: { ...entry.overlay, commandId: foreignId }
    })));
    await act(async () => input("Keep this")); await send(); expect(foreign).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
    expect(container.querySelector(".plugin-canvas-overlay [role=alert]")?.textContent).toContain("not owned");
    expect(container.querySelector<HTMLTextAreaElement>(".plugin-canvas-overlay textarea")!.value).toBe("Keep this");
  });

  it("shows runtime status, hides through canvas pointer events, and restores drawing focus on Esc", async () => {
    submit.mockImplementation(async context => { await context.overlays!.setStatus({ overlayId, text: "Working…" }); });
    await act(async () => input("Draw")); await send();
    expect(container.querySelector(".plugin-canvas-overlay [role=status]")?.textContent).toBe("Working…");
    const widget = container.querySelector<HTMLElement>(".plugin-canvas-overlay")!;
    const canvas = container.querySelector<HTMLElement>(".canvas-region")!;
    await act(async () => canvas.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }))); expect(widget.hidden).toBe(true);
    await act(async () => canvas.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }))); expect(widget.hidden).toBe(false);
    await act(async () => widget.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(widget.dataset.expanded).toBe("false"); expect(document.activeElement).toBe(canvas);
  });

  it("acknowledges a long request immediately so the next draft remains editable", async () => {
    let finish!: () => void; submit.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    try {
      await act(async () => input("Long request")); await send();
      const textarea = container.querySelector<HTMLTextAreaElement>(".plugin-canvas-overlay textarea")!;
      expect(submit).toHaveBeenCalledOnce(); expect(textarea.value).toBe(""); expect(textarea.disabled).toBe(false);
      await act(async () => input("Next request")); expect(textarea.value).toBe("Next request");
    } finally { await act(async () => finish?.()); }
  });

  it("keeps the overlay hidden until both wheel and native pinch gestures finish", async () => {
    vi.useFakeTimers();
    try {
      const canvas = container.querySelector<HTMLElement>(".canvas-region")!;
      const widget = container.querySelector<HTMLElement>(".plugin-canvas-overlay")!;
      await act(async () => canvas.dispatchEvent(new Event("gesturestart", { bubbles: true, cancelable: true })));
      await act(async () => canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 10 })));
      expect(widget.hidden).toBe(true);
      await act(async () => vi.advanceTimersByTime(150));
      expect(widget.hidden).toBe(true);
      await act(async () => canvas.dispatchEvent(new Event("gestureend", { bubbles: true, cancelable: true })));
      expect(widget.hidden).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});
