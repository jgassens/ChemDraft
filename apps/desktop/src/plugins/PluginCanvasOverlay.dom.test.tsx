// @vitest-environment jsdom
import { act, createRef, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginCanvasOverlayContributionSchema } from "@chemdraft/plugin-api";
import type { PluginOverlayTranscriptEntry } from "@chemdraft/plugin-api";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { PluginCanvasOverlay } from "./PluginCanvasOverlay";
import type { PluginPanelActionHandler } from "./pluginPanelActionTypes";
import { MemoryStorage } from "../testSupport/memoryStorage";
import { createPluginRuntime, type DesktopPluginRuntime } from "./createPluginRuntime";

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
let showPanelLink: boolean | undefined;
let panelTitle: string | undefined;
let platform: ShortcutPlatform;
let maxLength: number;
let requestPending: boolean;
let documentState: object;
let contentSource: ComponentProps<typeof PluginCanvasOverlay>["contentSource"];
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
class CanvasOverlayTranscriptSource {
  private readonly transcripts = new Map<string, readonly PluginOverlayTranscriptEntry[]>();
  private readonly listeners = new Set<() => void>();
  getCanvasOverlayTranscripts = () => this.transcripts;
  subscribeCanvasOverlayTranscript = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  set(entries: PluginOverlayTranscriptEntry[]) {
    this.transcripts.set(overlay.id, entries);
    this.listeners.forEach(listener => listener());
  }
  get subscriberCount() { return this.listeners.size; }
}
let transcriptSource: CanvasOverlayTranscriptSource;
let contentRuntime: DesktopPluginRuntime;
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
  await act(async () => root.render(<PluginCanvasOverlay overlay={{ ...overlay, showPanelLink, prompt: { ...overlay.prompt, maxLength } }} viewportRef={viewportRef}
    overlayLayerRef={overlayLayerRef} statusRowRef={statusRowRef}
    gestureActive={gestureActive} status={status} onAction={action} windowId={windowId} shortcutPlatform={platform}
    requestPending={requestPending} documentState={documentState}
    statusSource={statusSource}
    transcriptSource={transcriptSource}
    contentSource={contentSource ?? contentRuntime} openSource={contentRuntime}
    onOpenPanel={withPanel ? openPanel : undefined} panelTitle={panelTitle} onFocusDrawing={() => drawing.focus()} />));
}
async function expand(): Promise<void> {
  await act(async () => container.querySelector<HTMLButtonElement>(".plugin-canvas-overlay-icon")!.click());
}
function widget(): HTMLDivElement { return container.querySelector(".plugin-canvas-overlay")!; }

describe("PluginCanvasOverlay", () => {
  beforeEach(async () => {
    maxLength = 20; contentSource = undefined; requestPending = false; documentState = {};
    showPanelLink = undefined;
    contentRuntime = createPluginRuntime({ getActiveDocument: () => undefined });
    contentRuntime.registerPlugin({ id: "widget", name: "Widget", version: "0", apiVersion: "^0.1.12", entry: "test.js",
      permissions: ["ui.canvas"], contributes: { canvasOverlays: [overlay], commands: [{ id: overlay.commandId, title: "Open" }] }
    }, { commandHandlers: { [overlay.commandId]: ctx => ctx.overlays!.open({ overlayId: overlay.id, focus: ctx.input?.text === "focus" }) } });
    vi.stubGlobal("localStorage", new MemoryStorage()); gestureActive = false; status = ""; withPanel = false; panelTitle = undefined; platform = "macos";
    statusSource = new CanvasOverlayStatusSource();
    transcriptSource = new CanvasOverlayTranscriptSource();
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
      const height = this.dataset.expanded === "true" ? Math.min(Number.parseFloat(this.style.height) || 220,
        Number.parseFloat(this.style.maxHeight) || Infinity) : 36;
      return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON() {} };
    });
    await render();
  });
  afterEach(async () => { await act(async () => root.unmount()); contentRuntime.unregisterPlugin("widget"); viewport.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each([false, true])("restores an empty composer after batched content replacements, exactly once and without sending (empty: %s)", async empty => {
    await expand();
    const api = contentRuntime.host.createCommandContext("widget").overlays!;
    await act(async () => {
      await Promise.all([
        api.setContent({ overlayId: overlay.id, sections: [], prompt: { restoreDraft: "Draw aspirin" } }),
        api.setContent({ overlayId: overlay.id, sections: empty ? [] : [{ kind: "text", body: "Ready" }] })
      ]);
    });
    expect(container.querySelector("textarea")!.value).toBe("Draw aspirin");
    expect(action).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    root = createRoot(container); await render(); await expand();
    await act(async () => api.setContent({ overlayId: overlay.id, sections: [] }));
    expect(container.querySelector("textarea")!.value).toBe("");
    expect(action).not.toHaveBeenCalled();
  });

  it("drops a pending restoration when the user types before Send settles, even if they erase that typing", async () => {
    await expand();
    let finish!: (result: { ok: true }) => void;
    action.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => enterText("Original request"));
    await act(async () => container.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    const api = contentRuntime.host.createCommandContext("widget").overlays!;
    await act(async () => api.setContent({ overlayId: overlay.id, sections: [], prompt: { restoreDraft: "Original request" } }));
    await act(async () => enterText("New draft"));
    await act(async () => enterText(""));
    await act(async () => finish({ ok: true }));
    expect(container.querySelector("textarea")!.value).toBe("");
    await act(async () => api.setContent({ overlayId: overlay.id, sections: [] }));
    expect(container.querySelector("textarea")!.value).toBe("");
    expect(action).toHaveBeenCalledTimes(1); // Only the user's original Send.
  });

  it.each(["macos", "windows"] as const)("keeps the resize header below palettes and resets it on double click on %s", async targetPlatform => {
    platform = targetPlatform;
    await act(async () => root.unmount());
    window.localStorage.setItem(`${storageKey}:height`, "2000");
    window.localStorage.setItem(expandedKey, JSON.stringify({ x: 150, y: 32 }));
    root = createRoot(container); await render(); await expand();
    expect(widget().style.height).toBe("272px");
    expect(widget().style.top).toBe("104px");
    expect(window.localStorage.getItem(`${storageKey}:height`)).toBe("272");
    const header = container.querySelector(".plugin-canvas-overlay-header")!;
    await act(async () => { pointer(header, "pointerdown", 180, 104); pointer(header, "pointermove", 180, 150); pointer(header, "pointerup", 180, 150); });
    expect(widget().style.height).toBe("226px");
    expect(widget().style.top).toBe("150px");
    await act(async () => { pointer(header, "pointerdown", 180, 150); pointer(header, "pointermove", 180, -2000); pointer(header, "pointerup", 180, -2000); });
    expect(widget().style.height).toBe("272px");
    expect(widget().style.top).toBe("104px");
    await act(async () => header.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(widget().style.height).toBe("272px");
    expect(widget().style.top).toBe("104px");
    expect(window.localStorage.getItem(`${storageKey}:height`)).toBe("272");
    viewportHeight = 300;
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(widget().style.height).toBe("172px");
    expect(widget().style.top).toBe("104px");
    expect(window.localStorage.getItem(`${storageKey}:height`)).toBe("172");
    viewportHeight = 400;
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(widget().style.height).toBe("172px");
    await act(async () => root.unmount()); root = createRoot(container); await render(); await expand();
    expect(widget().style.height).toBe("172px");
  });

  it.each(["macos", "windows"] as const)("preserves over-limit overlay drafts and explains both refused send paths on %s", async targetPlatform => {
    platform = targetPlatform; maxLength = 4000; await render(); await expand();
    const textarea = container.querySelector("textarea")!;
    expect(textarea.hasAttribute("maxlength")).toBe(false);
    await act(async () => enterText("x".repeat(4256)));
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await act(async () => container.querySelector<HTMLButtonElement>(".plugin-report-action-primary")!.click());
    expect(action).not.toHaveBeenCalled();
    expect(textarea.value).toBe("x".repeat(4256));
    expect(container.textContent).toContain("4,256 / 4,000");
    expect(container.querySelector("[role=alert]")?.textContent)
      .toBe("Your request is 4,256 characters; the limit is 4,000. Shorten it to send.");
  });

  it("allows shrinking and resetting a chat even when long plugin content wants to grow", async () => {
    viewportHeight = 800; await render(); await expand();
    await act(async () => { await contentRuntime.host.createCommandContext("widget").overlays!.setContent({ overlayId: overlay.id,
      sections: [{ kind: "text", body: "Long setup explanation. ".repeat(150) }] }); });
    Object.defineProperty(container.querySelector(".plugin-canvas-overlay-content")!.firstElementChild!, "scrollHeight", { value: 1000 });
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(widget().style.height).toBe("520px");
    const header = container.querySelector(".plugin-canvas-overlay-header")!;
    await act(async () => { pointer(header, "pointerdown", 300, 256); pointer(header, "pointermove", 300, 356); pointer(header, "pointerup", 300, 356); });
    expect(widget().style.height).toBe("420px");
    await act(async () => header.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(widget().style.height).toBe("280px");
    expect(window.localStorage.getItem(`${storageKey}:height`)).toBe("280");
  });

  it.each(["macos", "windows"] as const)("refuses concurrent or plugin-disabled sends inline without losing focus or drafts on %s", async targetPlatform => {
    platform = targetPlatform; await render(); await expand();
    const textarea = container.querySelector("textarea")!;
    const send = container.querySelector<HTMLButtonElement>(".plugin-report-action-primary")!;
    const enter = () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    let finish!: (result: { ok: true }) => void;
    action.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => enterText("First"));
    await act(async () => enter());
    await act(async () => enterText("Next"));
    await act(async () => enter());
    expect(container.textContent).toContain("Wait for the current request to finish, or press Stop.");
    await act(async () => send.click());
    expect(action).toHaveBeenCalledOnce();
    expect(textarea.value).toBe("Next");
    expect(textarea.disabled).toBe(false);
    expect(document.activeElement).toBe(textarea);
    await act(async () => finish({ ok: true }));
    expect(textarea.value).toBe("Next");
    expect(container.querySelector("[role=alert]")).toBeNull();
    // The plugin owns live prompt state; host content must update the one composer in place.
    await act(async () => contentRuntime.host.createCommandContext("widget").overlays!.setContent({
      overlayId: overlay.id, sections: [], prompt: { disabled: true }
    }));
    expect(container.querySelectorAll("textarea")).toHaveLength(1);
    expect(container.querySelector("textarea")).toBe(textarea);
    await act(async () => enter());
    await act(async () => send.click());
    expect(action).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Wait for the current request to finish, or press Stop.");
    expect(textarea.value).toBe("Next");
    expect(textarea.disabled).toBe(false);
    await act(async () => contentRuntime.host.createCommandContext("widget").overlays!.setContent({
      overlayId: overlay.id, sections: []
    }));
    expect(container.querySelector("[role=alert]")).toBeNull();
    await act(async () => enter());
    expect(action).toHaveBeenCalledTimes(2);
    expect(textarea.value).toBe("");
  });

  it.each(["macos", "windows"] as const)("clears a busy hint independently on host completion, prompt re-enable, or document change on %s", async targetPlatform => {
    platform = targetPlatform; await render(); await expand();
    const api = contentRuntime.host.createCommandContext("widget").overlays!;
    const textarea = container.querySelector("textarea")!;
    await act(async () => enterText("Next request"));
    for (const reason of ["host completion", "prompt re-enabled", "document changed"]) {
      requestPending = true; await render();
      await act(async () => api.setContent({ overlayId: overlay.id, sections: [], prompt: { disabled: true } }));
      await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
      expect(container.querySelector("[role=alert]")?.textContent).toBe("Wait for the current request to finish, or press Stop.");
      if (reason === "host completion") { requestPending = false; await render(); }
      else if (reason === "prompt re-enabled") await act(async () => api.setContent({ overlayId: overlay.id, sections: [] }));
      else { documentState = {}; await render(); }
      expect(container.querySelector("[role=alert]")).toBeNull();
      expect(textarea.value).toBe("Next request");
      expect(action).not.toHaveBeenCalled();
    }
  });

  it.each(["macos", "windows"] as const)("returns action focus unless the user clicks outside the overlay on %s", async targetPlatform => {
    platform = targetPlatform; await render(); await expand();
    await act(async () => { await contentRuntime.host.createCommandContext("widget").overlays!.setContent({ overlayId: overlay.id, sections: [
      { kind: "actions", id: "primary", buttons: [{ id: "new", label: "New conversation", commandId: overlay.commandId }] },
      { kind: "actions", id: "secondary", buttons: [{ id: "setup", label: "Setup", commandId: overlay.commandId }] }
    ] }); });
    for (const selector of [".plugin-canvas-overlay-primary-actions button", ".plugin-canvas-overlay-content button"]) {
      const button = container.querySelector<HTMLButtonElement>(selector)!;
      let finish!: (result: { ok: true }) => void;
      action.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      await act(async () => { button.focus(); button.click(); });
      expect(document.activeElement).toBe(button);
      await act(async () => { drawing.focus(); finish({ ok: true }); });
      expect(document.activeElement).toBe(container.querySelector("textarea"));
      action.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      await act(async () => { button.focus(); button.click(); pointer(drawing, "pointerdown", 0, 0); drawing.focus(); });
      await act(async () => finish({ ok: true }));
      expect(document.activeElement).toBe(drawing);
    }
    const send = container.querySelector<HTMLButtonElement>(".plugin-report-action-primary")!;
    await act(async () => enterText("Next request"));
    await act(async () => { send.focus(); send.click(); });
    expect(document.activeElement).toBe(container.querySelector("textarea"));
  });

  it.each(["macos", "windows"] as const)("keeps focus on a mounted action button through content updates on %s", async targetPlatform => {
    platform = targetPlatform; await render(); await expand();
    const api = contentRuntime.host.createCommandContext("widget").overlays!;
    const update = (body: string) => api.setContent({ overlayId: overlay.id, sections: [
      { kind: "actions", id: "primary", buttons: [{ id: "stop", label: "Stop", commandId: overlay.commandId }] },
      { kind: "text", body }
    ] });
    await act(async () => update("Running"));
    const button = container.querySelector<HTMLButtonElement>(".plugin-canvas-overlay-primary-actions button")!;
    container.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    button.focus(); // jsdom does not perform Tab's default focus navigation.
    await act(async () => update("Still running"));
    expect(button.isConnected).toBe(true);
    expect(document.activeElement).toBe(button);
    expect(action).not.toHaveBeenCalled();

    let finish!: (result: { ok: true }) => void;
    action.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => button.click());
    await act(async () => update("Stopping"));
    expect(button.isConnected).toBe(true);
    expect(document.activeElement).toBe(button);
    await act(async () => finish({ ok: true }));
    expect(document.activeElement).toBe(container.querySelector("textarea"));
  });

  it.each(["macos", "windows"] as const)("does not restore focus when an unactivated action button is removed on %s", async targetPlatform => {
    platform = targetPlatform; await render(); await expand();
    const api = contentRuntime.host.createCommandContext("widget").overlays!;
    await act(async () => api.setContent({ overlayId: overlay.id, sections: [
      { kind: "actions", id: "primary", buttons: [{ id: "stop", label: "Stop", commandId: overlay.commandId }] }
    ] }));
    const button = container.querySelector<HTMLButtonElement>(".plugin-canvas-overlay-primary-actions button")!;
    button.focus();
    await act(async () => api.setContent({ overlayId: overlay.id, sections: [{ kind: "text", body: "Run ended" }] }));
    expect(button.isConnected).toBe(false);
    expect(document.activeElement).toBe(document.body);
    expect(action).not.toHaveBeenCalled();
  });

  it.each(["macos", "windows"] as const)("restores focus after an action button is removed, respecting deliberate focus moves on %s", async targetPlatform => {
    platform = targetPlatform; await render(); await expand();
    const api = contentRuntime.host.createCommandContext("widget").overlays!;
    const otherInput = document.createElement("input"); viewport.append(otherInput);
    const canvas = document.createElement("div"); viewport.append(canvas);
    for (const destination of [undefined, otherInput, drawing, canvas]) {
      await act(async () => api.setContent({ overlayId: overlay.id, sections: [
        { kind: "actions", id: "primary", buttons: [{ id: "stop", label: "Stop", commandId: overlay.commandId }] }
      ] }));
      let finish!: (result: { ok: true }) => void;
      action.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const button = container.querySelector<HTMLButtonElement>(".plugin-canvas-overlay-primary-actions button")!;
      await act(async () => { button.focus(); button.click(); });
      if (destination) {
        destination.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
        destination.focus();
        if (destination === canvas) button.blur(); // A nonfocusable canvas leaves focus on body.
      }
      await act(async () => api.setContent({ overlayId: overlay.id, sections: [{ kind: "text", body: "Run ended" }] }));
      expect(button.isConnected).toBe(false);
      const expected = destination === canvas ? document.body : destination ?? container.querySelector("textarea");
      expect(document.activeElement).toBe(expected);
      await act(async () => finish({ ok: true }));
      expect(document.activeElement).toBe(expected);
    }
  });

  it.each(["macos", "windows"] as const)("restores removed actions despite a programmatic canvas focus grab on %s", async targetPlatform => {
    platform = targetPlatform; await render(); await expand();
    const api = contentRuntime.host.createCommandContext("widget").overlays!;
    for (const label of ["Finish setup", "New conversation", "Stop"]) {
      for (const focusesButton of [true, false]) {
        await act(async () => api.setContent({ overlayId: overlay.id, sections: [
          { kind: "actions", id: "primary", buttons: [{ id: "action", label, commandId: overlay.commandId }] }
        ] }));
        let finish!: (result: { ok: true }) => void;
        action.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const button = container.querySelector<HTMLButtonElement>(".plugin-canvas-overlay-primary-actions button")!;
        await act(async () => {
          pointer(button, "pointerdown", 0, 0);
          if (focusesButton) button.focus(); // macOS pointer activation need not focus a button.
          button.click();
        });
        await act(async () => {
          void api.setContent({ overlayId: overlay.id, sections: [{ kind: "text", body: "Ready" }] });
          drawing.focus(); // Host/native focus fallback, with no user intent to leave.
        });
        expect(button.isConnected).toBe(false);
        expect(document.activeElement).toBe(container.querySelector("textarea"));
        await act(async () => { drawing.focus(); finish({ ok: true }); });
        expect(document.activeElement).toBe(container.querySelector("textarea"));
      }
    }
  });

  it.each(["macos", "windows"] as const)("respects keyboard focus moves during actions and after completion on %s", async targetPlatform => {
    platform = targetPlatform; await render(); await expand();
    const api = contentRuntime.host.createCommandContext("widget").overlays!;
    for (const finishBeforeTab of [false, true]) {
      const sections = [{ kind: "actions" as const, id: "primary", buttons: [
        { id: "new", label: "New conversation", commandId: overlay.commandId },
        { id: "setup", label: "Setup", commandId: overlay.commandId }
      ] }];
      await act(async () => api.setContent({ overlayId: overlay.id, sections }));
      let finish!: (result: { ok: true }) => void;
      action.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const [button, destination] = container.querySelectorAll<HTMLButtonElement>(".plugin-canvas-overlay-primary-actions button");
      await act(async () => { button!.focus(); button!.click(); });
      if (finishBeforeTab) await act(async () => finish({ ok: true }));
      await act(async () => {
        document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
        destination!.focus();
        void api.setContent({ overlayId: overlay.id, sections: [sections[0]!, { kind: "text", body: "Updated" }] });
      });
      if (!finishBeforeTab) await act(async () => finish({ ok: true }));
      expect(document.activeElement).toBe(destination);
    }
  });

  it.each(["macos", "windows"] as const)("defaults to room for three transcript lines and resets within the viewport cap on %s", async targetPlatform => {
    platform = targetPlatform;
    await act(async () => root.unmount());
    window.localStorage.removeItem(`${storageKey}:height`);
    viewportHeight = 800; root = createRoot(container); await render(); await expand();
    expect(widget().style.height).toBe("280px");
    expect(widget().style.maxHeight).toBe("672px");
    expect(container.querySelector('[role="log"]')!.compareDocumentPosition(container.querySelector("textarea")!)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const header = container.querySelector(".plugin-canvas-overlay-header")!;
    await act(async () => { pointer(header, "pointerdown", 300, 416); pointer(header, "pointermove", 300, 516); pointer(header, "pointerup", 300, 516); });
    expect(widget().style.height).toBe("220px");
    await act(async () => header.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(widget().style.height).toBe("280px");
  });

  it("resumes following replies after the reader submits their own prompt", async () => {
    await expand();
    const log = container.querySelector<HTMLElement>('[role="log"]')!;
    let scrollHeight = 200;
    Object.defineProperties(log, { scrollHeight: { get: () => scrollHeight }, clientHeight: { value: 48 } });
    await act(async () => transcriptSource.set([{ role: "assistant", text: "Previous" }]));
    await act(async () => { log.scrollTop = 20; log.dispatchEvent(new Event("scroll")); });
    await act(async () => enterText("Next question"));
    await act(async () => container.querySelector<HTMLButtonElement>(".plugin-report-action-primary")!.click());
    expect(log.scrollTop).toBe(200);
    scrollHeight = 350;
    await act(async () => transcriptSource.set([{ role: "assistant", text: "Newest reply" }]));
    expect(log.scrollTop).toBe(350);
    await act(async () => { log.scrollTop = 20; log.dispatchEvent(new Event("scroll")); });
    await act(async () => transcriptSource.set([{ role: "assistant", text: "Streaming further" }]));
    expect(log.scrollTop).toBe(20);
  });

  it("renders safe inline Markdown in transcript and content without making HTML or URLs executable", async () => {
    await expand();
    const text = '**Bold** *italic* `code` [source](https://example.org/page) <img src=x onerror=alert(1)> [bad](javascript:alert)';
    await act(async () => transcriptSource.set([{ role: "assistant", text }]));
    await act(async () => { await contentRuntime.host.createCommandContext("widget").overlays!.setContent({ overlayId: overlay.id, sections: [{ kind: "text", body: text }] }); });
    for (const selector of ['[role="log"]', '.plugin-canvas-overlay-content']) {
      const element = container.querySelector(selector)!;
      expect([...element.querySelectorAll("strong")].some(node => node.textContent === "Bold")).toBe(true);
      expect(element.querySelector("em")?.textContent).toBe("italic");
      expect(element.querySelector("code")?.textContent).toBe("code");
      expect(element.textContent).toContain("source (https://example.org/page)");
      expect(element.textContent).toContain("<img src=x onerror=alert(1)>");
      expect(element.querySelector("img,script,a")).toBeNull();
    }
  });

  it("keeps the first plugin actions outside scrolling content even when preceded by a long explanation", async () => {
    await expand();
    await act(async () => { await contentRuntime.host.createCommandContext("widget").overlays!.setContent({ overlayId: overlay.id, sections: [
      { kind: "text", body: "Long setup explanation. ".repeat(150) },
      { kind: "actions", id: "primary", buttons: [{ id: "install", label: "Install", commandId: overlay.commandId }] },
      { kind: "actions", id: "secondary", buttons: [{ id: "help", label: "Help", commandId: overlay.commandId }] }
    ] }); });
    const scroll = container.querySelector<HTMLElement>(".plugin-canvas-overlay-content")!;
    const pinned = container.querySelector<HTMLElement>(".plugin-canvas-overlay-primary-actions")!;
    expect(pinned?.textContent).toContain("Install");
    expect(scroll.contains(pinned)).toBe(false);
    expect(scroll.textContent).toContain("Help");
    expect(scroll.textContent).not.toContain("Install");
    await act(async () => pinned.querySelector("button")!.click());
    expect(action).toHaveBeenCalledWith({ sectionId: "primary", control: "button", controlId: "install" });
  });

  it("dispatches exactly one prompt for Enter, concurrent send, and key repeat, and refuses empty sends", async () => {
    await expand(); await act(async () => enterText("Draw benzene"));
    const textarea = container.querySelector("textarea")!;
    const send = container.querySelector<HTMLButtonElement>(".plugin-report-action-primary")!;
    let finish!: (result: { ok: true }) => void;
    action.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => { textarea.dispatchEvent(enter); send.click(); textarea.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(enter.defaultPrevented).toBe(true);
    expect(action).toHaveBeenCalledOnce();
    await act(async () => finish({ ok: true }));
    await act(async () => enterText("Next request"));
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true })));
    expect(action).toHaveBeenCalledOnce();
    expect(textarea.value).toBe("Next request");
    await act(async () => enterText(""));
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(action).toHaveBeenCalledOnce();
    await act(async () => enterText("   "));
    await act(async () => send.click());
    expect(action).toHaveBeenCalledOnce();
  });

  it.each(["macos", "windows"] as const)("opens without focus by default and focuses only on request on %s", async targetPlatform => {
    platform = targetPlatform; await render();
    await act(async () => { await contentRuntime.invokeCommand(overlay.commandId); });
    expect(widget().dataset.expanded).toBe("true");
    expect(document.activeElement).toBe(drawing);
    const focus = () => contentRuntime.invokeCommand(overlay.commandId, { input: {
      source: "overlay", overlayId: overlay.id, sectionId: "message", control: "prompt", text: "focus"
    } });
    await act(async () => { await focus(); });
    expect(document.activeElement).toBe(container.querySelector("textarea"));
    gestureActive = true; await render(); drawing.focus();
    await act(async () => { await focus(); });
    expect(document.activeElement).toBe(drawing);
    gestureActive = false; await render();
    expect(document.activeElement).toBe(container.querySelector("textarea"));
    drawing.focus();
    await act(async () => { await focus(); });
    expect(document.activeElement).toBe(container.querySelector("textarea"));
    await act(async () => container.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(widget().dataset.expanded).toBe("false");
    await render(); // A retained request must not reopen a user-collapsed overlay.
    expect(widget().dataset.expanded).toBe("false");
    await act(async () => { await focus(); });
    expect(document.activeElement).toBe(container.querySelector("textarea"));
  });

  it("renders report content above the transcript, grows within the drawing area, then restores remembered height", async () => {
    viewportHeight = 800;
    await act(async () => root.unmount());
    window.localStorage.setItem(`${storageKey}:height`, "300");
    root = createRoot(container); await render();
    await expand();
    await act(async () => enterText("Draft"));
    const api = contentRuntime.host.createCommandContext("widget").overlays!;
    const remembered = window.localStorage.getItem(`${storageKey}:height`);
    await act(async () => { await api.setContent({ overlayId: overlay.id, sections: [
      { kind: "text", body: "Choose an AI" }, { kind: "keyValue", rows: [{ label: "Status", value: "Ready" }] },
      { kind: "actions", id: "setup", buttons: [{ id: "install", label: "Install", commandId: overlay.commandId }] },
      { kind: "image", alt: "Preview", dataUri: "data:image/png;base64,YQ==" }
    ] }); });
    const content = container.querySelector<HTMLElement>(".plugin-canvas-overlay-content")!;
    expect(content.querySelector(".plugin-report")?.textContent).toContain("Choose an AI");
    expect(content.querySelector("img")?.alt).toBe("Preview");
    expect(content.nextElementSibling?.getAttribute("role")).toBe("log");
    Object.defineProperty(content.firstElementChild!, "scrollHeight", { value: 1000 });
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(widget().style.height).toBe(`${Math.floor((800 - 32 - 24) * 0.7)}px`);
    expect(Number.parseFloat(widget().style.top)).toBeGreaterThanOrEqual(32);
    expect(Number.parseFloat(widget().style.top) + Number.parseFloat(widget().style.height)).toBeLessThanOrEqual(776);
    expect(window.localStorage.getItem(`${storageKey}:height`)).toBe(remembered);
    expect(document.activeElement).toBe(container.querySelector("textarea"));
    await act(async () => container.querySelector<HTMLButtonElement>(".plugin-canvas-overlay-primary-actions button")!.click());
    expect(action).toHaveBeenCalledWith({ sectionId: "setup", control: "button", controlId: "install" });
    await act(async () => { await api.setContent({ overlayId: overlay.id, sections: [] }); });
    expect(widget().style.height).toBe("300px");
    expect(container.querySelector(".plugin-canvas-overlay-content")).toBeNull();
    expect(container.querySelector("textarea")!.value).toBe("Draft");
  });

  it.each(["macos", "windows"] as const)("shrinks below the default, grows upward, clamps and remembers height on %s", async targetPlatform => {
    platform = targetPlatform; await render(); await expand();
    expect(widget().style.height).toBe("272px");
    expect(container.querySelector("textarea")!.rows).toBe(1);
    const handle = container.querySelector(".plugin-canvas-overlay-resize")!;
    const bottom = Number.parseFloat(widget().style.top) + 272;
    await act(async () => { pointer(handle, "pointerdown", 300, 104); pointer(handle, "pointermove", 300, 116); });
    expect(widget().style.height).toBe("260px");
    expect(Number.parseFloat(widget().style.top) + 260).toBe(bottom);
    await act(async () => pointer(handle, "pointermove", 300, -1000));
    expect(widget().style.top).toBe("104px"); expect(widget().style.height).toBe("272px");
    await act(async () => pointer(handle, "pointerup", 300, -1000));
    expect(window.localStorage.getItem(`${storageKey}:height`)).toBe("272");
    await act(async () => container.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await expand(); expect(widget().style.height).toBe("272px");
    await act(async () => root.unmount()); root = createRoot(container); await render(); await expand();
    expect(widget().style.height).toBe("272px");
    await act(async () => root.unmount()); root = createRoot(container); await render("second-window"); await expand();
    expect(widget().style.height).toBe("272px");
    expect(window.localStorage.getItem(`${storageKey}:height`)).toBe("272");
    await act(async () => root.unmount()); root = createRoot(container); await render(); await expand();
    viewportHeight = 300;
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(widget().style.maxHeight).toBe("172px"); expect(widget().style.top).toBe("104px");
    expect(widget().getBoundingClientRect().height).toBe(172);
    viewportHeight = 400;
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(widget().getBoundingClientRect().height).toBe(172);
    const restoredHandle = container.querySelector(".plugin-canvas-overlay-resize")!;
    await act(async () => { pointer(restoredHandle, "pointerdown", 300, 32); pointer(restoredHandle, "pointermove", 300, 1000); pointer(restoredHandle, "pointerup", 300, 1000); });
    expect(widget().style.height).toBe("172px"); expect(widget().style.top).toBe("104px");
  });

  it("renders roles and errors, follows only a reader at the bottom, and keeps focus and drafts", async () => {
    await expand(); await act(async () => enterText("Reply"));
    const textarea = container.querySelector("textarea")!;
    const log = container.querySelector<HTMLElement>('[role="log"]')!;
    let scrollHeight = 200;
    Object.defineProperties(log, { scrollHeight: { get: () => scrollHeight }, clientHeight: { value: 48 } });
    await act(async () => transcriptSource.set([
      { role: "user", text: "Question" }, { role: "tool", text: "Working" },
      { role: "notice", text: "Notice" }, { role: "assistant", text: "Latest reply" }, { role: "error", text: "Failed" }
    ]));
    expect(log.scrollTop).toBe(200);
    expect(log.textContent).toContain("Latest reply");
    expect(log.querySelector('[data-role="error"]')?.classList.contains("plugin-report-composer-error")).toBe(true);
    expect(document.activeElement).toBe(textarea); expect(textarea.value).toBe("Reply");
    await act(async () => { log.scrollTop = 20; log.dispatchEvent(new Event("scroll")); });
    scrollHeight = 300;
    await act(async () => transcriptSource.set([{ role: "assistant", text: "More" }]));
    expect(log.scrollTop).toBe(20);
    await act(async () => { log.scrollTop = 252; log.dispatchEvent(new Event("scroll")); });
    scrollHeight = 400;
    await act(async () => transcriptSource.set([{ role: "assistant", text: "Newest" }]));
    expect(log.scrollTop).toBe(400);
    await act(async () => transcriptSource.set([])); expect(log.textContent).toBe("");
    expect(transcriptSource.subscriberCount).toBe(1);
    await act(async () => root.unmount()); expect(transcriptSource.subscriberCount).toBe(0);
    root = createRoot(container); await render("second-window"); await expand();
    expect(widget().style.height).toBe("272px");
  });

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

  it("resizes vertically from the header and restores the saved place on remount", async () => {
    await expand(); const header = container.querySelector(".plugin-canvas-overlay-header")!;
    await act(async () => { pointer(header, "pointerdown", 310, 180); pointer(header, "pointermove", -1000, -1000); });
    expect(widget().style.left).toBe("284px"); expect(widget().style.top).toBe("104px");
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
    await expand(); expect(widget().style.left).toBe("120px"); expect(widget().style.top).toBe("104px");
    await act(async () => root.unmount()); root = createRoot(container); await render("second-window");
    await expand(); expect(widget().style.left).toBe("284px"); expect(widget().style.top).toBe("104px");
    expect(JSON.parse(window.localStorage.getItem(expandedKey)!)).toEqual({ x: 120, y: 104 });
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
    expect(widget().style.left).toBe("236px"); expect(widget().style.top).toBe("104px");
    const header = container.querySelector(".plugin-canvas-overlay-header")!;
    await act(async () => { pointer(header, "pointerdown", 250, 140); pointer(header, "pointermove", 46, 44); pointer(header, "pointerup", 46, 44); });
    expect(JSON.parse(window.localStorage.getItem(expandedKey)!)).toEqual({ x: 236, y: 104 });
    expect(JSON.parse(window.localStorage.getItem(collapsedKey)!)).toEqual({ x: 236, y: 128 });
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Collapse Assistant"]')!.click());
    expect(widget().style.left).toBe("236px"); expect(widget().style.top).toBe("128px");
    await act(async () => root.unmount()); root = createRoot(container); await render();
    expect(widget().style.left).toBe("236px"); expect(widget().style.top).toBe("128px");
    await expand(); expect(widget().style.left).toBe("236px"); expect(widget().style.top).toBe("104px");
  });

  it("clamps both saved modes on resize, including the hidden icon, and caps the box to the drawing area", async () => {
    await expand();
    viewportWidth = 260; viewportHeight = 250;
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(widget().style.maxWidth).toBe("212px");
    expect(widget().style.maxHeight).toBe("122px");
    expect(widget().style.left).toBe("32px"); expect(widget().style.top).toBe("104px");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Collapse Assistant"]')!.click());
    expect(widget().style.left).toBe("208px"); expect(widget().style.top).toBe("190px");
    expect(JSON.parse(window.localStorage.getItem(collapsedKey)!)).toEqual({ x: 208, y: 190 });
    expect(JSON.parse(window.localStorage.getItem(expandedKey)!)).toEqual({ x: 32, y: 104 });
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
    showPanelLink = false; await render();
    expect(container.querySelector(".plugin-canvas-overlay-panel")).toBeNull();
  });

  it("uses a generic panel label when no title is supplied", async () => {
    withPanel = true; await render(); await expand();
    expect(container.querySelector(".plugin-canvas-overlay-panel")?.textContent).toBe("Open panel");
  });

  it("works outside Tauri when storage is unavailable or malformed", async () => {
    await act(async () => root.unmount());
    window.localStorage.setItem(collapsedKey, '{"x":"bad","y":null}');
    window.localStorage.setItem(expandedKey, "not JSON");
    window.localStorage.setItem(`${storageKey}:height`, '"invalid"');
    root = createRoot(container); await render(); expect(widget().style.left).toBe("536px");
    await expand(); expect(widget().style.height).toBe("272px");
    await act(async () => root.unmount());
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => { throw new Error("Storage blocked"); });
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("Storage blocked"); });
    root = createRoot(container); await render(); await expand(); const header = container.querySelector(".plugin-canvas-overlay-header")!;
    await act(async () => { pointer(header, "pointerdown", 0, 0); pointer(header, "pointermove", 10, 10); pointer(header, "pointerup", 10, 10); });
    expect(widget().hidden).toBe(false);
  });
});
