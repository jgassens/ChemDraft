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
  dismissToolsetPopovers, newToolsetPopoverOpening, openToolsetPopoverWindow, sendPaletteCommand, sendToolsetFlyoutKey, setToolsetPopoverContent,
  toolsetPopoverTimestamp,
  type ToolsetPopoverContentPayload, type ToolsetPopoverDismissPayload, type ToolsetFlyoutKey,
  type ToolsetFlyoutSession, type AcceptedToolsetPopoverOpening
} from "./window-manager";

// Keep the real request/snapshot renderers and commands; replace only cross-window IPC.
const native = vi.hoisted(() => ({
  content: new Set<(payload: ToolsetPopoverContentPayload) => void>(),
  opening: new Set<(opening: ToolsetFlyoutSession) => void>(),
  accepted: new Set<(opening: AcceptedToolsetPopoverOpening) => void>(),
  acceptedNotice: vi.fn(),
  release: new Set<(payload: { toolsetId: string; releasedAt: number }) => void>(),
  keys: new Set<(payload: ToolsetFlyoutKey) => void>(),
  closed: new Set<(payload: ToolsetFlyoutSession) => void>(),
  popoverClosed: new Set<(opening: AcceptedToolsetPopoverOpening) => void>(),
  dismiss: new Set<(payload?: ToolsetPopoverDismissPayload) => void>(),
  show: vi.fn(async () => true), hide: vi.fn(async () => {}), focus: vi.fn(async () => {}),
  isVisible: vi.fn(async () => true),
  legacyHandoff: false,
  focusedLabel: vi.fn<() => string | null | Promise<string | null>>(() => null)
}));
vi.mock("@tauri-apps/api/core", async importOriginal => ({
  ...await importOriginal<typeof import("@tauri-apps/api/core")>(),
  invoke: vi.fn(async (command: string, args?: { foregroundOnly?: boolean }) => {
    if (command === "list_toolset_window_states" && args?.foregroundOnly) return native.focusedLabel();
    throw new Error(`Unexpected native invoke: ${command}`);
  })
}));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main", hide: native.hide, setFocus: native.focus }),
  // Both per-window checks can be false during the handoff from flyout to owner.
  Window: { getByLabel: vi.fn(async () => ({ isVisible: native.isVisible })), getFocusedWindow: vi.fn(async () => {
    if (native.legacyHandoff) return null;
    const label = await native.focusedLabel();
    return label === null ? null : { label };
  }) }
}));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setFocus: native.focus }) }));
vi.mock("./window-manager", async importOriginal => {
  const actual = await importOriginal<typeof import("./window-manager")>();
  function subscribe<T>(listeners: Set<(payload: T) => void>, listener: (payload: T) => void) {
    listeners.add(listener);
    return Promise.resolve(() => { listeners.delete(listener); });
  }
  return {
    ...actual,
    isToolsetPopoverVisible: native.isVisible,
    listenForToolsetPopoverContent: (handler: (payload: ToolsetPopoverContentPayload) => void) => subscribe(native.content, handler),
    listenForToolsetFlyoutOpening: (handler: (opening: ToolsetFlyoutSession) => void) => subscribe(native.opening, handler),
    notifyToolsetFlyoutOpening: async (opening: ToolsetFlyoutSession) => native.opening.forEach(handler => handler(opening)),
    listenForAcceptedToolsetPopoverContent: (handler: (opening: AcceptedToolsetPopoverOpening) => void) => subscribe(native.accepted, handler),
    notifyToolsetPopoverContentAccepted: async (opening: AcceptedToolsetPopoverOpening) => {
      native.acceptedNotice(opening);
      native.accepted.forEach(handler => handler(opening));
    },
    listenForToolsetPopoverRelease: (handler: (payload: { toolsetId: string; releasedAt: number }) => void) => subscribe(native.release, handler),
    listenForToolsetFlyoutKeys: (handler: (payload: ToolsetFlyoutKey) => void) => subscribe(native.keys, handler),
    listenForToolsetFlyoutClosed: (handler: (payload: ToolsetFlyoutSession) => void) => subscribe(native.closed, handler),
    listenForToolsetPopoverClosed: (handler: (opening: AcceptedToolsetPopoverOpening) => void) => subscribe(native.popoverClosed, handler),
    notifyToolsetPopoverClosed: async (toolsetId: string, openedAt: number, generation?: number) =>
      native.popoverClosed.forEach(handler => handler({ toolsetId, openedAt, generation })),
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
    native.legacyHandoff = false;
    native.focusedLabel.mockReset();
    native.isVisible.mockReset();
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
    expect(native.content.size + native.opening.size + native.accepted.size + native.release.size + native.keys.size +
      native.closed.size + native.popoverClosed.size + native.dismiss.size).toBe(0);
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  async function key(value: string, init: KeyboardEventInit = {}, type = "keydown") {
    const event = new KeyboardEvent(type, { key: value, bubbles: true, cancelable: true, ...init });
    await act(async () => document.activeElement!.dispatchEvent(event));
    return event;
  }
  const highlighted = () => host.querySelector<HTMLButtonElement>('[data-test-popover] [data-keyboard-highlighted="true"]');
  async function mouseHold(beforeRelease?: () => Promise<void>) {
    const button = host.querySelector<HTMLButtonElement>('[data-test-owner] [data-command-id="tool.benzene"]')!;
    expect(button).not.toBeNull();
    // DOM pointer events exercise the real hold timer and request/snapshot path.
    // Native nonactivation is represented by retaining the document's actual DOM focus.
    vi.useFakeTimers();
    const pointer = (type: string) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
      Object.defineProperty(event, "pointerId", { value: 1 });
      button.dispatchEvent(event);
    };
    await act(async () => {
      pointer("pointerdown");
      await vi.advanceTimersByTimeAsync(TOOLBAR_FLYOUT_HOLD_MS);
    });
    await beforeRelease?.();
    await act(async () => {
      pointer("pointerup");
      if (beforeRelease) {
        // Supply the owner's release IPC in this single-DOM fixture.
        native.release.forEach(handler => handler({ toolsetId: "core.main", releasedAt: toolsetPopoverTimestamp() }));
      }
    });
  }
  async function mouseOpen(beforeRelease?: () => Promise<void>) {
    await mouseHold(beforeRelease);
    const [toolsetId, content, anchor] = vi.mocked(setToolsetPopoverContent).mock.calls.at(-1)!;
    expect(toolsetId).toBe("core.main");
    if (content.kind !== "flyout") throw new Error("Expected ring flyout snapshot");
    return { toolsetId, ...content, anchor };
  }

  it("keeps the ring flyout keyboard route through the three opening blurs and release reported in 1.2.1", async () => {
    const before = current();
    const opened = await mouseOpen(async () => {
      expect(native.acceptedNotice).toHaveBeenCalledOnce();
      vi.stubGlobal("__TAURI__", {});
      const flyoutLabel = "toolset-popover-core-main";
      for (const label of [flyoutLabel, flyoutLabel, platform === "windows" ? "main" : flyoutLabel]) {
        native.focusedLabel.mockReturnValue(label);
        await act(async () => { window.dispatchEvent(new FocusEvent("blur")); });
      }
    });
    expect((await key("ArrowDown")).defaultPrevented).toBe(true);
    expect(sendToolsetFlyoutKey).toHaveBeenCalledWith({
      toolsetId: opened.toolsetId, flyoutId: opened.flyout.flyoutId, openedAt: opened.openedAt,
      generation: opened.generation, key: "ArrowDown"
    });
    expect(highlighted()?.dataset.commandId).toBe(opened.flyout.commands.find(command => command.enabled)?.id);
    expect(current()).toBe(before);
  });

  it.skipIf(platform !== "windows")("holds navigation during the native-open await and only replays the arrow", async () => {
    const before = current();
    let finishOpen!: () => void;
    let finishShow!: (shown: boolean) => void;
    native.show.mockImplementationOnce(() => new Promise(resolve => { finishShow = resolve; }));
    vi.mocked(openToolsetPopoverWindow).mockImplementationOnce(() => new Promise(resolve => { finishOpen = resolve; }));
    const opened = await mouseOpen(async () => {
      // Native open configures the prewarmed HWND and can hand focus back to WebView2
      // before the palette sends its already-stamped flyout content to the document.
      expect(openToolsetPopoverWindow).toHaveBeenCalledOnce();
      expect(setToolsetPopoverContent).not.toHaveBeenCalled();
      vi.stubGlobal("__TAURI__", {});
      native.focusedLabel.mockReturnValue("main");
      await act(async () => window.dispatchEvent(new FocusEvent("blur")));
      for (const value of ["ArrowDown", "Enter", "Home", "End"]) {
        expect((await key(value)).defaultPrevented).toBe(true);
      }
      expect(current()).toBe(before);
      expect(sendToolsetFlyoutKey).not.toHaveBeenCalled();
      expect(setToolsetPopoverContent).not.toHaveBeenCalled();
      await act(async () => finishOpen());
    });
    const first = opened.flyout.commands.find(command => command.enabled)!;
    expect(sendToolsetFlyoutKey).not.toHaveBeenCalled();

    await act(async () => finishShow(true));
    expect(vi.mocked(sendToolsetFlyoutKey).mock.calls.map(([payload]) => payload.key)).toEqual(["ArrowDown"]);
    expect(sendPaletteCommand).not.toHaveBeenCalled();
    expect(highlighted()?.dataset.commandId).toBe(first.id);
    expect((await key("ArrowUp")).defaultPrevented).toBe(true);
    const last = opened.flyout.commands.filter(command => command.enabled).at(-1)!;
    expect(highlighted()?.dataset.commandId).toBe(last.id);
    expect((await key("Enter")).defaultPrevented).toBe(true);
    expect(sendPaletteCommand).toHaveBeenCalledExactlyOnceWith(last.id, { flyoutOpening: {
      toolsetId: opened.toolsetId, flyoutId: opened.flyout.flyoutId, openedAt: opened.openedAt, generation: opened.generation
    } });
    expect(current()).toBe(before);
  });

  it.skipIf(platform !== "windows")("releases held keys when native open rejects", async () => {
    const before = current();
    let refuseOpen!: (reason: Error) => void;
    vi.mocked(openToolsetPopoverWindow).mockImplementationOnce(() => new Promise((_, reject) => { refuseOpen = reject; }));
    await mouseHold(async () => {
      expect(openToolsetPopoverWindow).toHaveBeenCalledOnce();
      expect((await key("ArrowDown")).defaultPrevented).toBe(true);
      expect(current()).toBe(before);
      await act(async () => refuseOpen(new Error("Native open refused")));
    });
    expect(setToolsetPopoverContent).not.toHaveBeenCalled();
    await key("ArrowDown");
    expect(current()).not.toBe(before);
    expect(sendToolsetFlyoutKey).not.toHaveBeenCalled();
    expect(sendPaletteCommand).not.toHaveBeenCalled();
  });

  it.skipIf(platform !== "windows")("releases held keys on timeout and routes fresh keys after late acceptance", async () => {
    const before = current();
    let finishOpen!: () => void;
    vi.mocked(openToolsetPopoverWindow).mockImplementationOnce(() => new Promise(resolve => { finishOpen = resolve; }));
    const opened = await mouseOpen(async () => {
      expect(openToolsetPopoverWindow).toHaveBeenCalledOnce();
      expect((await key("ArrowDown")).defaultPrevented).toBe(true);
      expect((await key("Enter")).defaultPrevented).toBe(true);
      expect(current()).toBe(before);
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      await key("ArrowDown");
      expect(current()).not.toBe(before);
      await act(async () => finishOpen());
    });
    expect(sendToolsetFlyoutKey).not.toHaveBeenCalled();
    expect(sendPaletteCommand).not.toHaveBeenCalled();
    await key("ArrowDown");
    expect(highlighted()?.dataset.commandId).toBe(opened.flyout.commands.find(command => command.enabled)?.id);
  });

  it.skipIf(platform !== "windows").each([null, "other-document"])("drops queued keys for a replacement stamped before foreground loss (%s)", async label => {
    const opened = await mouseOpen();
    vi.stubGlobal("__TAURI__", {});
    const replacement = newToolsetPopoverOpening();
    let resolveFocus!: (label: string | null) => void;
    native.focusedLabel.mockReturnValue(new Promise(resolve => { resolveFocus = resolve; }));
    await act(async () => window.dispatchEvent(new FocusEvent("blur")));
    expect((await key("Enter")).defaultPrevented).toBe(true);

    const flyout = { ...opened.flyout, flyoutId: "replacement" };
    await act(async () => setToolsetPopoverContent(opened.toolsetId, { ...opened, ...replacement, flyout }));
    expect(native.acceptedNotice).toHaveBeenLastCalledWith({ toolsetId: opened.toolsetId, flyoutId: flyout.flyoutId, ...replacement });
    expect((await key("ArrowDown")).defaultPrevented).toBe(true);
    expect((await key("Enter")).defaultPrevented).toBe(true);
    expect(sendToolsetFlyoutKey).not.toHaveBeenCalled();

    await act(async () => resolveFocus(label));
    expect(sendPaletteCommand).not.toHaveBeenCalled();
    expect(sendToolsetFlyoutKey).not.toHaveBeenCalled();
    expect(highlighted()).toBeNull();

    await act(async () => {
      window.dispatchEvent(new FocusEvent("focus"));
      await vi.advanceTimersByTimeAsync(1);
      await setToolsetPopoverContent(opened.toolsetId, { ...opened, ...newToolsetPopoverOpening(), flyout });
    });
    expect(highlighted()).toBeNull();
    await key("ArrowDown");
    expect(highlighted()?.dataset.commandId).toBe(flyout.commands.find(command => command.enabled)?.id);
    expect(sendPaletteCommand).not.toHaveBeenCalled();
  });

  it.skipIf(platform !== "windows")("keeps a flyout opening when its owning palette takes foreground before acceptance", async () => {
    const before = current();
    let finishShow!: (shown: boolean) => void;
    native.show.mockImplementationOnce(() => new Promise(resolve => { finishShow = resolve; }));
    const opened = await mouseOpen(async () => {
      expect(setToolsetPopoverContent).toHaveBeenCalledOnce();
      expect(native.acceptedNotice).not.toHaveBeenCalled();
      vi.stubGlobal("__TAURI__", {});
      native.focusedLabel.mockReturnValue("toolset-core-main");
      await act(async () => window.dispatchEvent(new FocusEvent("blur")));
      expect(native.focusedLabel).toHaveBeenCalledOnce();
      native.focusedLabel.mockReturnValue("main");
      await act(async () => window.dispatchEvent(new FocusEvent("focus")));
      await act(async () => finishShow(true));
    });

    expect((await key("ArrowDown")).defaultPrevented).toBe(true);
    expect(highlighted()?.dataset.commandId).toBe(opened.flyout.commands.find(command => command.enabled)?.id);
    expect(current()).toBe(before);
  });

  it.each([null, "other-document"])("releases routing when native focus moves away (%s)", async label => {
    await mouseOpen();
    vi.stubGlobal("__TAURI__", {});
    native.focusedLabel.mockReturnValue(label);
    await act(async () => { window.dispatchEvent(new FocusEvent("blur")); });
    await key("ArrowDown");
    expect(sendToolsetFlyoutKey).not.toHaveBeenCalled();
    expect(highlighted()).toBeNull();
  });

  it("uses one foreground snapshot during a flyout focus handoff", async () => {
    const before = current();
    await mouseOpen();
    vi.stubGlobal("__TAURI__", {});
    native.legacyHandoff = true;
    native.focusedLabel.mockReturnValue(platform === "windows" ? "main" : "toolset-popover-core-main");
    await act(async () => window.dispatchEvent(new FocusEvent("blur")));
    expect(native.focusedLabel).toHaveBeenCalledOnce();
    expect((await key("ArrowDown")).defaultPrevented).toBe(true);
    expect(highlighted()).not.toBeNull();
    expect(current()).toBe(before);
  });

  it.each([true, false])("holds navigation while the foreground check is pending (kept: %s)", async kept => {
    const before = current();
    await mouseOpen();
    vi.stubGlobal("__TAURI__", {});
    let resolveFocus!: (label: string | null) => void;
    native.focusedLabel.mockReturnValue(new Promise(resolve => { resolveFocus = resolve; }));
    await act(async () => window.dispatchEvent(new FocusEvent("blur")));
    await act(async () => window.dispatchEvent(new FocusEvent("focus")));
    expect((await key("ArrowDown")).defaultPrevented).toBe(true);
    expect((await key("ArrowRight")).defaultPrevented).toBe(true);
    expect(sendToolsetFlyoutKey).not.toHaveBeenCalled();
    expect(highlighted()).toBeNull();
    await act(async () => resolveFocus(kept ? "toolset-popover-core-main" : null));
    expect(vi.mocked(sendToolsetFlyoutKey).mock.calls.map(([payload]) => payload.key))
      .toEqual(kept ? ["ArrowDown", "ArrowRight"] : []);
    expect(highlighted() !== null).toBe(kept);
    expect(current()).toBe(before);
  });

  it.skipIf(platform !== "windows")("drops queued ArrowDown and Enter if the flyout hid before the owner focus reply", async () => {
    await mouseOpen();
    vi.stubGlobal("__TAURI__", {});
    let resolveFocus!: (label: string) => void;
    native.focusedLabel.mockReturnValue(new Promise(resolve => { resolveFocus = resolve; }));
    await act(async () => window.dispatchEvent(new FocusEvent("blur")));
    expect((await key("ArrowDown")).defaultPrevented).toBe(true);
    expect((await key("Enter")).defaultPrevented).toBe(true);
    expect(sendToolsetFlyoutKey).not.toHaveBeenCalled();
    // Native has hidden the window, but the renderer has yet to report the close.
    native.isVisible.mockResolvedValueOnce(false);
    await act(async () => resolveFocus("main"));
    expect(native.isVisible).toHaveBeenCalledOnce();
    expect(sendPaletteCommand).not.toHaveBeenCalled();
    expect(sendToolsetFlyoutKey).not.toHaveBeenCalled();
  });

  it("drops ArrowDown and Enter for a hidden flyout after the focus check has finished", async () => {
    await mouseOpen();
    vi.stubGlobal("__TAURI__", {});
    let resolveFocus!: (label: string) => void;
    native.focusedLabel.mockReturnValue(new Promise(resolve => { resolveFocus = resolve; }));
    await act(async () => window.dispatchEvent(new FocusEvent("blur")));
    native.isVisible.mockResolvedValue(false);
    await act(async () => resolveFocus(platform === "windows" ? "main" : "toolset-popover-core-main"));

    await key("ArrowDown");
    await key("Enter");
    expect(sendPaletteCommand).not.toHaveBeenCalled();
    expect(sendToolsetFlyoutKey).not.toHaveBeenCalled();
    const visibilityChecks = native.isVisible.mock.calls.length;
    await key("ArrowDown");
    expect(native.isVisible).toHaveBeenCalledTimes(visibilityChecks);
    expect(highlighted()).toBeNull();
  });

  it("refuses a forwarded Enter when the flyout hides after the router checks visibility", async () => {
    await mouseOpen();
    await key("ArrowDown");
    expect(highlighted()).not.toBeNull();

    native.isVisible.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await key("Enter")).defaultPrevented).toBe(true);

    expect(sendToolsetFlyoutKey).toHaveBeenLastCalledWith(expect.objectContaining({ key: "Enter" }));
    expect(sendPaletteCommand).not.toHaveBeenCalled();
  });

  it.each(["Enter", " "])("navigates a mouse-opened ring flyout and activates once with %j", async activation => {
    const before = current();
    const content = await mouseOpen();
    const choices = content.flyout.commands.filter(command => command.enabled);
    const hidesBeforeActivation = native.hide.mock.calls.length;
    expect(highlighted()).toBeNull();
    const flyoutOpening = { toolsetId: content.toolsetId, flyoutId: content.flyout.flyoutId,
      openedAt: content.openedAt, generation: content.generation };
    expect(native.show).toHaveBeenLastCalledWith("preserve", "flyout", flyoutOpening);
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
    expect(sendPaletteCommand).toHaveBeenCalledExactlyOnceWith(choices[0].id, { flyoutOpening });
    expect(native.hide).toHaveBeenCalledTimes(hidesBeforeActivation + 1);
    expect(current()).toBe(before);
    // A queued IPC activation and stale startup replay cannot invoke or reopen it.
    await act(async () => {
      await sendToolsetFlyoutKey({ toolsetId: content.toolsetId, flyoutId: content.flyout.flyoutId,
        openedAt: content.openedAt!, generation: content.generation, key: activation });
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
    // A changed snapshot is a fresh opening; an identical opening identity is a replay.
    const timing = newToolsetPopoverOpening();
    await act(async () => setToolsetPopoverContent(opened.toolsetId, { ...opened, ...timing, flyout }));
    expect(host.querySelector<HTMLButtonElement>('[data-test-popover] [data-command-id="tool.cyclobutane"]')?.disabled).toBe(true);
    await key("ArrowLeft"); expect(highlighted()?.dataset.commandId).toBe("tool.cyclopentane");
    await key("ArrowRight"); expect(highlighted()?.dataset.commandId).toBe("tool.cyclopropane");
    await key("ArrowRight"); expect(highlighted()?.dataset.commandId).toBe("tool.cyclopentane");
    await key("ArrowDown", { ctrlKey: true }); expect(highlighted()?.dataset.commandId).toBe("tool.cyclopentane");
    await act(async () => sendToolsetFlyoutKey({ toolsetId: opened.toolsetId, flyoutId: flyout.flyoutId,
      openedAt: opened.openedAt! - 1, key: "Enter" }));
    expect(sendPaletteCommand).not.toHaveBeenCalled();
    await key(" ");
    expect(sendPaletteCommand).toHaveBeenCalledExactlyOnceWith("tool.cyclopentane", {
      flyoutOpening: { toolsetId: opened.toolsetId, flyoutId: flyout.flyoutId, ...timing }
    });
    expect(document.activeElement).toBe(canvas);
    expect(native.focus).not.toHaveBeenCalled();
  });

  it("consumes arrows with no enabled choices and never invokes them", async () => {
    const opened = await mouseOpen();
    const before = current();
    await act(async () => setToolsetPopoverContent(opened.toolsetId, { ...opened, ...newToolsetPopoverOpening(),
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
