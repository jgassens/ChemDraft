// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaletteWindow } from "./PaletteWindow";
import { PalettePopoverWindow } from "./PalettePopoverWindow";
import { MemoryStorage } from "./testSupport/memoryStorage";
import {
  sendPaletteCommand, sendToolsetFlyoutKey, setToolsetPopoverContent,
  type ToolsetPopoverContentPayload, type ToolsetPopoverDismissPayload,
  type ToolsetFlyoutKey, type ToolsetFlyoutSession
} from "./window-manager";

// Mount no document window: its router must not mask missing routing in the
// standalone palette. Only the cross-window transport and native reveal are mocked.
const native = vi.hoisted(() => ({
  content: new Set<(payload: ToolsetPopoverContentPayload) => void>(),
  keys: new Set<(payload: ToolsetFlyoutKey) => void>(),
  closed: new Set<(payload: ToolsetFlyoutSession) => void>(),
  dismiss: new Set<(payload?: ToolsetPopoverDismissPayload) => void>(),
  show: vi.fn(async () => {}), hide: vi.fn(async () => {}), focus: vi.fn(async () => {})
}));
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
    sendPaletteCommand: vi.fn(async () => {}),
    currentWindowLogicalPosition: vi.fn(async () => ({ x: 100, y: 100 })),
    openToolsetPopoverWindow: vi.fn(async () => {}), closeToolsetPopoverWindow: vi.fn(async () => {}),
    setCurrentWindowLogicalSize: vi.fn(async () => {}), setCurrentWindowLogicalPosition: vi.fn(async () => {}),
    showCurrentToolsetPopoverWindow: native.show
  };
});

describe.each(["macos", "windows"] as const)("standalone palette flyout keyboard routing (%s)", platform => {
  let root: Root, host: HTMLDivElement, button: HTMLButtonElement;
  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root.render(<>
      <div data-test-owner><PaletteWindow toolsetId="core.main" platform={platform} /></div>
      <div data-test-popover><PalettePopoverWindow toolsetId="core.main" kind="flyout" prewarm platform={platform} /></div>
    </>));
    button = host.querySelector<HTMLButtonElement>('[data-test-owner] [data-command-id="tool.benzene"]')!;
    expect(button).not.toBeNull();
    await act(async () => button.focus());
  });
  afterEach(async () => {
    await act(async () => root.unmount()); host.remove();
    expect(native.content.size + native.keys.size + native.closed.size + native.dismiss.size).toBe(0);
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  async function key(value: string, init: KeyboardEventInit = {}, type = "keydown") {
    const event = new KeyboardEvent(type, { key: value, bubbles: true, cancelable: true, ...init });
    await act(async () => document.activeElement!.dispatchEvent(event));
    return event;
  }
  const highlighted = () => host.querySelector<HTMLButtonElement>('[data-test-popover] [data-keyboard-highlighted="true"]');

  it.each(["Enter", " "])("opens from the focused button, navigates and chooses once with %j", async activation => {
    // Real DOM focus and bubbling keyboard events exercise the palette's own handlers;
    // focus stays here throughout rather than moving to a document canvas.
    expect((await key("ArrowDown")).defaultPrevented).toBe(true);
    await key("ArrowDown", {}, "keyup");
    expect(setToolsetPopoverContent).toHaveBeenCalledTimes(1);
    const [toolsetId, content] = vi.mocked(setToolsetPopoverContent).mock.calls[0]!;
    if (content.kind !== "flyout") throw new Error("Expected ring flyout snapshot");
    const choices = content.flyout.commands.filter(command => command.enabled);
    expect(native.show).toHaveBeenLastCalledWith("preserve", "flyout");
    expect(document.activeElement).toBe(button);
    expect(highlighted()).toBeNull();
    // Activation with no highlight must also be consumed, never invoke the owner.
    expect((await key(activation)).defaultPrevented).toBe(true);
    await key(activation, {}, "keyup");
    expect(sendPaletteCommand).not.toHaveBeenCalled();
    for (const [arrow, index] of [
      ["ArrowDown", 0], ["ArrowRight", 1], ["ArrowLeft", 0],
      ["ArrowUp", choices.length - 1], ["ArrowDown", 0], ["ArrowDown", 1]
    ] as const) {
      expect((await key(arrow)).defaultPrevented).toBe(true);
      expect(highlighted()?.dataset.commandId).toBe(choices[index].id);
      expect(document.activeElement).toBe(button);
    }
    expect(setToolsetPopoverContent).toHaveBeenCalledTimes(1);
    expect(sendToolsetFlyoutKey).toHaveBeenLastCalledWith({
      toolsetId, flyoutId: content.flyout.flyoutId, openedAt: content.openedAt, key: "ArrowDown"
    });
    expect((await key(activation)).defaultPrevented).toBe(true);
    expect((await key(activation, { repeat: true })).defaultPrevented).toBe(true);
    expect((await key(activation, {}, "keyup")).defaultPrevented).toBe(true);
    // WKWebView can synthesize a button click after keyboard activation. The
    // palette's existing hold-open click guard must still suppress its primary.
    await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(sendPaletteCommand).toHaveBeenCalledExactlyOnceWith(choices[1].id);
    expect(native.hide).toHaveBeenCalledTimes(1);
    expect(native.focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
  });
});
