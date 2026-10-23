// @vitest-environment jsdom
import { act } from "react";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginPanelReportSchema, type PluginCommandContext } from "@chemdraft/plugin-api";
import { pluginPanelWindowId, requestPluginPanelAction } from "./plugins/panelBridge";
import { MainWindow } from "./MainWindow";
import type { DesktopPluginRuntime } from "./plugins/createPluginRuntime";
import { MemoryStorage } from "./testSupport/memoryStorage";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
const captured = vi.hoisted(() => ({ runtime: undefined as DesktopPluginRuntime | undefined }));
const panelActions = vi.hoisted(() => ({ handler: undefined as Parameters<typeof import("./plugins/panelBridge").listenForPluginPanelActions>[0] | undefined }));
vi.mock("./plugins/panelBridge", async original => {
  const actual = await original<typeof import("./plugins/panelBridge")>();
  return { ...actual, listenForPluginPanelActions: (handler: typeof panelActions.handler) => {
    panelActions.handler = handler;
    return actual.listenForPluginPanelActions(handler!);
  } };
});
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
const overlayId = `overlay.overlayTest.${"long".repeat(20)}`;
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
    expect(submit.mock.calls[0]![0].input).toEqual({ source: "overlay", overlayId, sectionId: "message",
      control: "prompt", text: "Draw aspirin", selected: "codex" });
    expect(container.querySelector<HTMLTextAreaElement>(".plugin-canvas-overlay textarea")!.value).toBe("");
  });

  it("stacks the canvas overlay above the build stamp but below floating panels", () => {
    const css = readFileSync("apps/desktop/src/App.css", "utf8");
    expect(css).toMatch(/--cd-z-canvas-overlay:\s*1100/);
    expect(css).toMatch(/\.plugin-canvas-overlay-layer\s*\{[\s\S]*?z-index:\s*var\(--cd-z-canvas-overlay\)/);
    expect(css).toMatch(/\.status-row\s*\{[\s\S]*?z-index:\s*1000/);
    expect(css).toMatch(/--cd-z-floating-panel:\s*1200/);
  });

  async function openPanel(plugin: string, panelId: string, commandId: string, handler: typeof submit): Promise<void> {
    await act(async () => {
      captured.runtime!.registerPlugin({ id: plugin, name: plugin, version: "0.1.0", apiVersion: "^0.1.10",
        entry: "test.js", permissions: ["ui.panel"], contributes: {
          commands: [{ id: commandId, title: "Send" }], panels: [{ id: panelId, title: "Assistant" }]
        }
      }, { commandHandlers: { [commandId]: handler } });
      captured.runtime!.panels.showReport(plugin, panelId, PluginPanelReportSchema.parse({ title: "Assistant", sections: [
        { kind: "prompt", id: "message", commandId }
      ] }));
    });
  }

  it("refuses panel A forwarding an action naming plugin B's panel", async () => {
    await openPanel("org.panelA", "panel.a.chat", "plugin.a.submit", select);
    await act(async () => captured.runtime!.panels.detachPanel("org.panelA", "panel.a.chat"));
    await openPanel("org.panelB", "panel.b.chat", "plugin.b.submit", submit);
    await act(async () => captured.runtime!.panels.detachPanel("org.panelB", "panel.b.chat"));
    await act(async () => {
      // The native bridge has authenticated A's label; B's claimed panel id is untrusted.
      (panelActions.handler as (...args: unknown[]) => void)("forged", {
        panelId: "panel.b.chat", sectionId: "message", control: "prompt", text: "Run B"
      }, `plugin-panel-${pluginPanelWindowId("org.panelA", "panel.a.chat")}`);
    });
    expect(submit).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it("uses the authenticated owner when two detached plugins share a panel id", async () => {
    const panelId = "panel.shared.chat";
    await openPanel("org.panelA", panelId, "plugin.a.submit", select);
    await act(async () => captured.runtime!.panels.detachPanel("org.panelA", panelId));
    await openPanel("org.panelB", panelId, "plugin.b.submit", submit);
    await act(async () => captured.runtime!.panels.detachPanel("org.panelB", panelId));
    await act(async () => panelActions.handler!("from-a", {
      panelId, sectionId: "message", control: "prompt", text: "Run A"
    }, `plugin-panel-${pluginPanelWindowId("org.panelA", panelId)}`));
    expect(select).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
    await act(async () => {
      // Web CustomEvents cannot claim to come from a detached window.
      expect(await requestPluginPanelAction({ panelId, sectionId: "message", control: "prompt", text: "Forged" }))
        .toMatchObject({ ok: false });
    });
    expect(select).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });

  it("binds CustomEvents to the inline panel MainWindow rendered", async () => {
    await openPanel("org.panelA", "panel.a.chat", "plugin.a.submit", select);
    await act(async () => captured.runtime!.panels.detachPanel("org.panelA", "panel.a.chat"));
    await openPanel("org.panelB", "panel.b.chat", "plugin.b.submit", submit);
    await act(async () => {
      expect(await requestPluginPanelAction({ panelId: "panel.a.chat", sectionId: "message", control: "prompt", text: "Forged" }))
        .toMatchObject({ ok: false });
    });
    expect(select).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    await act(async () => {
      expect(await requestPluginPanelAction({ panelId: "panel.b.chat", sectionId: "message", control: "prompt", text: "Run B" }))
        .toEqual({ ok: true });
    });
    expect(submit).toHaveBeenCalledOnce();
  });

  it.each([false, true])("refuses a synchronously disabled report before React updates (detached=%s)", async detached => {
    const panelId = "panel.live.chat";
    const commandId = "plugin.live.submit";
    await openPanel("org.live", panelId, commandId, submit);
    if (detached) await act(async () => captured.runtime!.panels.detachPanel("org.live", panelId));
    let result: Awaited<ReturnType<typeof requestPluginPanelAction>> | undefined;
    await act(async () => {
      captured.runtime!.panels.showReport("org.live", panelId, PluginPanelReportSchema.parse({ title: "Busy", sections: [
        { kind: "prompt", id: "message", commandId, disabled: true }
      ] }));
      const request = { panelId, sectionId: "message", control: "prompt" as const, text: "Too late" };
      if (detached) {
        (panelActions.handler as (...args: unknown[]) => void)("late", request,
          `plugin-panel-${pluginPanelWindowId("org.live", panelId)}`);
      } else result = await requestPluginPanelAction(request);
    });
    expect(submit).not.toHaveBeenCalled();
    if (!detached) expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("disabled") });
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
