// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "./MainWindow";
import { PaletteWindow } from "./PaletteWindow";
import { PalettePopoverWindow } from "./PalettePopoverWindow";
import { TOOLBAR_FLYOUT_HOLD_MS } from "./ToolPalette";
import { createPhase4Document, insertNativeSingleBondMolecule, selectDocumentObjects } from "./documentWorkflow";
import { getAssistantHistoryPort } from "./assistant/historyPort";
import { MemoryStorage } from "./testSupport/memoryStorage";
import {
  dismissToolsetPopovers, sendPaletteCommand, sendToolsetFlyoutKey, setToolsetPopoverContent,
  type ToolsetPopoverContentPayload, type ToolsetPopoverDismissPayload, type ToolsetFlyoutKey,
  type ToolsetFlyoutSession
} from "./window-manager";

// Keep the real request/snapshot renderers and commands; replace only cross-window IPC.
const native = vi.hoisted(() => ({
  content: new Set<(payload: ToolsetPopoverContentPayload) => void>(),
  keys: new Set<(payload: ToolsetFlyoutKey) => void>(),
  closed: new Set<(payload: ToolsetFlyoutSession) => void>(),
  dismiss: new Set<(payload?: ToolsetPopoverDismissPayload) => void>(),
  show: vi.fn(async () => {}), hide: vi.fn(async () => {}), focus: vi.fn(async () => {})
}));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ hide: native.hide, setFocus: native.focus }) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setFocus: native.focus }) }));
vi.mock("./window-manager", async importOriginal => {
  const actual = await importOriginal<typeof import("./window-manager")>();
  function subscribe<T>(listeners: Set<(payload: T) => void>, listener: (payload: T) => void) {
    listeners.add(listener);
    return Promise.resolve(() => { listeners.delete(listener); });
  }
  return {
    ...actual,
    listenForToolsetPopoverContent: (handler: (payload: ToolsetPopoverContentPayload) => void) => subscribe(native.content, handler),
    listenForToolsetFlyoutKeys: (handler: (payload: ToolsetFlyoutKey) => void) => subscribe(native.keys, handler),
    listenForToolsetFlyoutClosed: (handler: (payload: ToolsetFlyoutSession) => void) => subscribe(native.closed, handler),
    listenForToolsetPopoverDismiss: (handler: (payload?: ToolsetPopoverDismissPayload) => void) => subscribe(native.dismiss, handler),
    setToolsetPopoverContent: vi.fn(async (toolsetId, content, anchor) => {
      native.content.forEach(handler => handler({ toolsetId, ...content, anchor }));
    }),
    sendToolsetFlyoutKey: vi.fn(async payload => { native.keys.forEach(handler => handler(payload)); }),
    notifyToolsetFlyoutClosed: vi.fn(async payload => { native.closed.forEach(handler => handler(payload)); }),
    dismissToolsetPopovers: vi.fn(async requestedAt => { native.dismiss.forEach(handler => handler({ requestedAt })); }),
    sendPaletteCommand: vi.fn(actual.sendPaletteCommand),
    currentWindowLogicalPosition: vi.fn(async () => ({ x: 100, y: 100 })),
    openToolsetPopoverWindow: vi.fn(async () => {}), closeToolsetPopoverWindow: vi.fn(async () => {}),
    setCurrentWindowLogicalSize: vi.fn(async () => {}), setCurrentWindowLogicalPosition: vi.fn(async () => {}),
    showCurrentToolsetPopoverWindow: native.show
  };
});

describe.each(["macos", "windows"] as const)("native flyout keyboard routing (%s)", platform => {
  let root: Root, host: HTMLDivElement, canvas: HTMLElement;
  const current = () => getAssistantHistoryPort().read("initial")!;
  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
    Element.prototype.hasPointerCapture ??= () => false;
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    let initial = insertNativeSingleBondMolecule(createPhase4Document("Native flyout"), { x: 200, y: 200 });
    initial = selectDocumentObjects(initial, initial.pages[0].id, [initial.pages[0].objects[0].id]);
    await act(async () => root.render(<>
      <MainWindow initialDocument={initial} initialPaletteMode="hidden" initialRulersVisible={false}
        initialCrosshairsVisible={false} nativePalette={false} shortcutPlatform={platform} />
      <div data-test-owner><PaletteWindow toolsetId="core.main" platform={platform} /></div>
      <div data-test-popover><PalettePopoverWindow toolsetId="core.main" kind="flyout" prewarm platform={platform} /></div>
    </>));
    canvas = host.querySelector<HTMLElement>(".canvas-region")!;
    await act(async () => canvas.focus());
  });
  afterEach(async () => {
    await act(async () => root.unmount()); host.remove();
    expect(native.content.size + native.keys.size + native.closed.size + native.dismiss.size).toBe(0);
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  async function key(value: string, init: KeyboardEventInit = {}, type = "keydown") {
    const event = new KeyboardEvent(type, { key: value, bubbles: true, cancelable: true, ...init });
    await act(async () => document.activeElement!.dispatchEvent(event));
    return event;
  }
  const highlighted = () => host.querySelector<HTMLButtonElement>('[data-test-popover] [data-keyboard-highlighted="true"]');
  async function mouseOpen() {
    const button = host.querySelector<HTMLButtonElement>('[data-test-owner] [data-command-id="tool.benzene"]')!;
    expect(button).not.toBeNull();
    // DOM pointer events exercise the real hold timer and request/snapshot path.
    // Native nonactivation is represented by retaining the document's actual DOM focus.
    vi.useFakeTimers();
    await act(async () => {
      for (const type of ["pointerdown", "pointerup"]) {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
        Object.defineProperty(event, "pointerId", { value: 1 });
        button.dispatchEvent(event);
        if (type === "pointerdown") await vi.advanceTimersByTimeAsync(TOOLBAR_FLYOUT_HOLD_MS);
      }
    });
    const [toolsetId, content, anchor] = vi.mocked(setToolsetPopoverContent).mock.calls.at(-1)!;
    expect(toolsetId).toBe("core.main");
    if (content.kind !== "flyout") throw new Error("Expected ring flyout snapshot");
    return { toolsetId, ...content, anchor };
  }

  it.each(["Enter", " "])("navigates a mouse-opened ring flyout and activates once with %j", async activation => {
    const before = current();
    const content = await mouseOpen();
    const choices = content.flyout.commands.filter(command => command.enabled);
    expect(highlighted()).toBeNull();
    expect(native.show).toHaveBeenLastCalledWith("preserve", "flyout");
    expect(document.activeElement).toBe(canvas);
    expect((await key("ArrowDown")).defaultPrevented).toBe(true);
    expect(highlighted()?.dataset.commandId).toBe(choices[0].id);
    await key("ArrowDown");
    expect(highlighted()?.dataset.commandId).toBe(choices[1].id);
    await key("ArrowUp");
    expect(highlighted()?.dataset.commandId).toBe(choices[0].id);
    await key("ArrowRight");
    expect(highlighted()?.dataset.commandId).toBe(choices[1].id);
    await key("ArrowLeft");
    await key("ArrowRight", { shiftKey: true });
    expect(highlighted()?.dataset.commandId).toBe(choices[0].id);
    expect(current()).toBe(before);
    expect(document.activeElement).toBe(canvas);
    expect(native.focus).not.toHaveBeenCalled();
    expect((await key(activation)).defaultPrevented).toBe(true);
    expect((await key(activation, { repeat: true })).defaultPrevented).toBe(true);
    expect((await key(activation, {}, "keyup")).defaultPrevented).toBe(true);
    expect(sendPaletteCommand).toHaveBeenCalledExactlyOnceWith(choices[0].id);
    expect(native.hide).toHaveBeenCalledTimes(1);
    expect(current()).toBe(before);
    // A queued IPC activation and stale startup replay cannot invoke or reopen it.
    await act(async () => {
      await sendToolsetFlyoutKey({ toolsetId: content.toolsetId, flyoutId: content.flyout.flyoutId,
        openedAt: content.openedAt!, key: activation });
      await setToolsetPopoverContent(content.toolsetId, content, content.anchor);
    });
    expect(sendPaletteCommand).toHaveBeenCalledTimes(1);
    expect(native.show).toHaveBeenCalledTimes(1);
    const forwards = vi.mocked(sendToolsetFlyoutKey).mock.calls.length;
    await key("ArrowDown");
    expect(sendToolsetFlyoutKey).toHaveBeenCalledTimes(forwards);
  });

  it("navigates Left/Right, skips disabled choices, wraps and refuses stale keys", async () => {
    const opened = await mouseOpen();
    const flyout = { ...opened.flyout, commands: [
      { id: "tool.cyclopropane", title: "First", enabled: true, active: false },
      { id: "tool.cyclobutane", title: "Disabled", enabled: false, active: false, disabledReason: "Unavailable now" },
      { id: "tool.cyclopentane", title: "Last", enabled: true, active: false }
    ] };
    await act(async () => setToolsetPopoverContent(opened.toolsetId, { ...opened, flyout }));
    expect(host.querySelector<HTMLButtonElement>('[data-test-popover] [data-command-id="tool.cyclobutane"]')?.disabled).toBe(true);
    await key("ArrowLeft"); expect(highlighted()?.dataset.commandId).toBe("tool.cyclopentane");
    await key("ArrowRight"); expect(highlighted()?.dataset.commandId).toBe("tool.cyclopropane");
    await key("ArrowRight"); expect(highlighted()?.dataset.commandId).toBe("tool.cyclopentane");
    await key("ArrowDown", { ctrlKey: true }); expect(highlighted()?.dataset.commandId).toBe("tool.cyclopentane");
    await act(async () => sendToolsetFlyoutKey({ toolsetId: opened.toolsetId, flyoutId: flyout.flyoutId,
      openedAt: opened.openedAt! - 1, key: "Enter" }));
    expect(sendPaletteCommand).not.toHaveBeenCalled();
    await key(" ");
    expect(sendPaletteCommand).toHaveBeenCalledExactlyOnceWith("tool.cyclopentane");
    expect(document.activeElement).toBe(canvas);
    expect(native.focus).not.toHaveBeenCalled();
  });

  it("consumes arrows with no enabled choices and never invokes them", async () => {
    const opened = await mouseOpen();
    const before = current();
    await act(async () => setToolsetPopoverContent(opened.toolsetId, { ...opened,
      flyout: { ...opened.flyout, commands: opened.flyout.commands.map(command => ({ ...command, enabled: false })) }
    }));
    for (const value of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", " "]) {
      expect((await key(value)).defaultPrevented).toBe(true);
    }
    expect(highlighted()).toBeNull();
    expect(sendPaletteCommand).not.toHaveBeenCalled();
    expect(current()).toBe(before);
  });

  it("ignores old dismissals and releases routing after click-away", async () => {
    const opened = await mouseOpen();
    await act(async () => dismissToolsetPopovers(opened.openedAt! - 1));
    await key("ArrowDown"); expect(highlighted()).not.toBeNull();
    await act(async () => canvas.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })));
    vi.mocked(sendToolsetFlyoutKey).mockClear();
    await key("ArrowRight");
    expect(sendToolsetFlyoutKey).not.toHaveBeenCalled();
  });
});
