// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installNativeFlyoutKeyboard } from "./nativeFlyoutKeyboard";
import { PalettePopoverWindow } from "./PalettePopoverWindow";
import { installPopoverEscapeRouting } from "./window-manager/popoverEscape";
import {
  dismissToolsetPopovers, notifyToolsetFlyoutClosed, setToolsetPopoverContent, TOOLSET_POPOVER_DISMISS_EVENT,
  type ToolsetFlyoutKey, type ToolsetPopoverOpening
} from "./window-manager";

type Listener = (event: { event: string; id: number; payload: unknown }) => void;
const native = {
  listeners: new Map<string, Map<number, Listener>>(),
  nextListener: 0,
  visible: false,
  hold: (_event: string, _payload: unknown): boolean => false,
  queued: [] as (() => void)[],
  emit: vi.fn(async (event: string, payload: unknown) => {
    for (const [id, receive] of native.listeners.get(event) ?? []) {
      const deliver = () => receive({ event, id, payload });
      if (native.hold(event, payload)) native.queued.push(deliver);
      else deliver();
    }
  }),
  position: vi.fn(async () => {}),
  show: vi.fn(async (_kind?: string) => true),
  hide: vi.fn(async () => {}),
  routeCommand: vi.fn()
};

function installMockTauri() {
  vi.stubGlobal("__TAURI_INTERNALS__", {
    metadata: { currentWindow: { label: "test" }, currentWebview: { label: "test" } },
    transformCallback: (receive: Listener) => receive,
    invoke: async (command: string, args: { event: string; handler: Listener; payload?: unknown; kind?: string }) => {
      if (command === "plugin:event|listen") {
        const listeners = native.listeners.get(args.event) ?? new Map();
        native.listeners.set(args.event, listeners);
        const id = ++native.nextListener;
        listeners.set(id, args.handler);
        return id;
      }
      if (command === "plugin:event|emit") await native.emit(args.event, args.payload);
      if (command === "set_current_window_global_position") await native.position();
      if (command === "show_toolset_popover_window" || command === "plugin:window|show") {
        const shown = await native.show(args.kind);
        if (shown) native.visible = true;
        return shown;
      }
      if (command === "plugin:window|hide") {
        await native.hide();
        native.visible = false;
      }
      if (command === "plugin:window|get_all_windows") return ["toolset-popover-core-main", "toolset-popover-core-art"];
      if (command === "plugin:window|is_visible") return native.visible;
      if (command === "route_toolset_command") native.routeCommand(args);
    }
  });
  vi.stubGlobal("__TAURI_EVENT_PLUGIN_INTERNALS__", {
    unregisterListener: (event: string, id: number) => native.listeners.get(event)?.delete(id)
  });
}

const flyoutKeyEvent = "chemdraft://toolset-flyout-key";
const main = "core.main";
const art = "core.art";
const contentEvent = "chemdraft://toolset-popover-content";
const accepted = (event: string, payload: unknown) =>
  event === contentEvent && (payload as { accepted?: true }).accepted === true;
const sendKeys = () => native.emit.mock.calls.filter(([event]) => event === flyoutKeyEvent)
  .map(([, payload]) => payload as ToolsetFlyoutKey);
const press = async (key: string, type = "keydown") => {
  const event = new KeyboardEvent(type, { key, bubbles: true, cancelable: true });
  await act(async () => document.body.dispatchEvent(event));
  return event.defaultPrevented;
};
const pushMenu = (toolsetId: string, flyoutId: string, opening: ToolsetPopoverOpening = {}) => act(async () => {
  await setToolsetPopoverContent(toolsetId, { kind: "flyout", ...opening, flyout: {
    flyoutId, title: flyoutId, commands: [{ id: flyoutId, title: flyoutId, enabled: true, active: false }]
  } }, { x: 10, y: 20 });
});

describe.each(["macos", "windows"] as const)("keyboard routing with reordered popover events on %s", platform => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let stop: (() => void) | undefined;
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    installMockTauri();
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<>
      <PalettePopoverWindow toolsetId={main} kind="flyout" prewarm platform={platform} />
      <PalettePopoverWindow toolsetId={art} kind="flyout" prewarm platform={platform} />
    </>));
    await vi.waitFor(() => expect(native.listeners.get(contentEvent)?.size).toBe(2));
    await act(async () => { stop = installNativeFlyoutKeyboard(platform); });
    await vi.waitFor(() => expect(native.listeners.get(contentEvent)?.size).toBeGreaterThan(2));
    await vi.waitFor(() => expect(native.listeners.get(flyoutKeyEvent)?.size).toBe(2));
  });
  afterEach(async () => {
    stop?.();
    stop = undefined;
    await act(async () => root.unmount());
    host.remove();
    native.listeners.clear();
    native.queued.length = 0;
    native.visible = false;
    native.hold = () => false;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const highlighted = () => host.querySelector('[data-keyboard-highlighted="true"]')?.getAttribute("data-command-id");

  it("defers acceptance and keyboard activation until the native show succeeds", async () => {
    const opening = { openedAt: 1, generation: 1 };
    let finishPosition!: () => void;
    let finishShow!: (shown: boolean) => void;
    native.position.mockImplementationOnce(() => new Promise<void>(resolve => { finishPosition = resolve; }));
    native.show.mockImplementationOnce(() => new Promise<boolean>(resolve => { finishShow = resolve; }));
    await pushMenu(main, "rings", opening);
    expect(native.position).toHaveBeenCalledOnce();
    expect(await press("ArrowDown")).toBe(true);
    expect(await press("Enter")).toBe(true);
    expect(native.show).not.toHaveBeenCalled();
    expect(native.routeCommand).not.toHaveBeenCalled();
    expect(native.emit.mock.calls.some(([event, payload]) => accepted(event, payload))).toBe(false);

    await act(async () => finishPosition());
    expect(native.show).toHaveBeenCalledOnce();
    expect(native.routeCommand).not.toHaveBeenCalled();
    expect(native.emit.mock.calls.some(([event, payload]) => accepted(event, payload))).toBe(false);
    // Even a direct IPC key with the current identity cannot activate hidden content.
    await act(async () => {
      for (const key of ["ArrowDown", "Enter"]) {
        await native.emit(flyoutKeyEvent, { ...opening, toolsetId: main, flyoutId: "rings", key });
      }
    });
    expect(highlighted()).toBeUndefined();
    expect(native.routeCommand).not.toHaveBeenCalled();
    const keysBeforeShow = sendKeys().length;
    await act(async () => {
      finishShow(true);
      await vi.waitFor(() => {
        if (platform === "windows") expect(sendKeys().slice(keysBeforeShow).map(({ key }) => key)).toEqual(["ArrowDown"]);
        else expect(native.routeCommand).toHaveBeenCalledOnce();
      });
    });
    if (platform === "windows") {
      expect(highlighted()).toBe("rings");
      expect(native.routeCommand).not.toHaveBeenCalled();
      await press("Enter", "keyup");
      expect(await press("Enter")).toBe(true);
    }
    expect(native.routeCommand).toHaveBeenCalledOnce();
  });

  it("consumes navigation and replays keys in order when acceptance is delayed", async () => {
    native.hold = accepted;
    await pushMenu(main, "rings", { openedAt: 1, generation: 1 });
    expect(native.show).toHaveBeenCalledOnce();
    expect(await press("ArrowDown")).toBe(true);
    expect(await press("Enter")).toBe(true);
    expect(sendKeys()).toEqual([]);
    await act(async () => native.queued.splice(0).forEach(deliver => deliver()));
    expect(sendKeys().map(({ key }) => key)).toEqual(platform === "windows" ? ["ArrowDown"] : ["ArrowDown", "Enter"]);
    if (platform === "windows") {
      expect(native.routeCommand).not.toHaveBeenCalled();
      await press("Enter", "keyup");
      expect(await press("Enter")).toBe(true);
    }
    expect(native.routeCommand).toHaveBeenCalledOnce();
  });

  it("republishes acceptance on a stamped replay for a late keyboard router", async () => {
    stop?.();
    stop = undefined;
    await pushMenu(main, "rings", { openedAt: 1, generation: 1 });
    expect(native.show).toHaveBeenCalledOnce();
    await act(async () => { stop = installNativeFlyoutKeyboard(platform); });
    await pushMenu(main, "rings", { openedAt: 1, generation: 1 });
    expect(native.show).toHaveBeenCalledOnce();
    expect(await press("ArrowDown")).toBe(true);
    expect(highlighted()).toBe("rings");
  });

  it("discards queued keys when the opening fails to show", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let failShow!: (error: Error) => void;
    native.show.mockImplementationOnce(() => new Promise<boolean>((_, reject) => { failShow = reject; }));
    await pushMenu(main, "rings", { openedAt: 1, generation: 1 });
    expect(await press("ArrowDown")).toBe(true);
    expect(await press("Enter")).toBe(true);
    await act(async () => failShow(new Error("Native reveal failed")));
    expect(await press("ArrowDown")).toBe(false);
    expect(sendKeys()).toEqual([]);
    expect(native.emit.mock.calls.some(([event, payload]) => accepted(event, payload))).toBe(false);
    await pushMenu(main, "rings", { openedAt: 1, generation: 2 });
    expect(highlighted()).toBeUndefined();
    expect(native.routeCommand).not.toHaveBeenCalled();
  });

  it("releases routing without accepting or replaying keys when native show is suspended", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let finishShow!: (shown: boolean) => void;
    native.show.mockImplementationOnce(() => new Promise<boolean>(resolve => { finishShow = resolve; }));
    await pushMenu(main, "rings", { openedAt: 1, generation: 1 });
    expect(await press("ArrowDown")).toBe(true);
    expect(await press("Enter")).toBe(true);

    // The native command resolves successfully but leaves the window hidden.
    await act(async () => finishShow(false));
    expect(native.visible).toBe(false);
    expect(native.routeCommand).not.toHaveBeenCalled();
    expect(native.emit.mock.calls.some(([event, payload]) => accepted(event, payload))).toBe(false);
    expect(sendKeys()).toEqual([]);
    expect(await press("ArrowDown")).toBe(false);
    expect(native.show).toHaveBeenCalledOnce();
  });

  it("discards pending keys on close even if acceptance was already sent", async () => {
    native.hold = accepted;
    await pushMenu(main, "rings", { openedAt: 1, generation: 1 });
    expect(await press("ArrowDown")).toBe(true);
    expect(await press("Enter")).toBe(true);
    await act(async () => dismissToolsetPopovers(2));
    await act(async () => native.queued.splice(0).forEach(deliver => deliver()));
    expect(sendKeys()).toEqual([]);
    expect(native.routeCommand).not.toHaveBeenCalled();
    expect(await press("ArrowDown")).toBe(false);
  });

  it("routes to the second unstamped menu in the same clock tick", async () => {
    vi.spyOn(performance, "now").mockReturnValue(50);
    await pushMenu(main, "rings");
    await pushMenu(main, "shapes");
    expect(await press("ArrowDown")).toBe(true);
    expect(sendKeys().at(-1)).toMatchObject({ toolsetId: main, flyoutId: "shapes", generation: expect.any(Number) });
    expect(highlighted()).toBe("shapes");
  });

  it("routes a stamped reopening at the timestamp of a closed timestamp-only menu", async () => {
    await pushMenu(main, "rings", { openedAt: 1 });
    await act(async () => host.querySelector("button")!.click());
    await vi.waitFor(() => expect(native.hide).toHaveBeenCalledOnce());
    expect(await press("ArrowDown")).toBe(false);
    await pushMenu(main, "rings", { openedAt: 1, generation: 1 });
    expect(await press("ArrowDown")).toBe(true);
    expect(highlighted()).toBe("rings");
    // Reordered duplicate close notices still identify the timestamp-only opening.
    const closes = native.emit.mock.calls.filter(([event]) =>
      event === "chemdraft://toolset-popover-closed" || event === "chemdraft://toolset-flyout-closed");
    expect(closes).toHaveLength(2);
    await act(async () => { for (const [event, payload] of closes) await native.emit(event, payload); });
    expect(await press("ArrowDown")).toBe(true);
  });

  it("ignores a legacy timestamp-only close for a stamped replacement", async () => {
    await pushMenu(main, "rings", { openedAt: 1 });
    await act(async () => host.querySelector("button")!.click());
    expect(native.hide).toHaveBeenCalledOnce();
    await pushMenu(main, "rings", { openedAt: 1, generation: 1 });
    await act(async () => notifyToolsetFlyoutClosed({ toolsetId: main, flyoutId: "rings", openedAt: 1 }));
    expect(native.hide).toHaveBeenCalledOnce();
    expect(await press("ArrowDown")).toBe(true);
    expect(highlighted()).toBe("rings");
  });

  it("rejects queued timestamp-only Enter on a same-time stamped replacement", async () => {
    await pushMenu(main, "rings", { openedAt: 1 });
    native.hold = (event, payload) => event === flyoutKeyEvent && (payload as ToolsetFlyoutKey).key === "Enter";
    expect(await press("Enter")).toBe(true);
    expect(sendKeys().at(-1)?.generation).toBeUndefined();
    await pushMenu(main, "rings", { openedAt: 1, generation: 1 });
    expect(await press("ArrowDown")).toBe(true);
    expect(highlighted()).toBe("rings");
    await act(async () => native.queued.splice(0).forEach(deliver => deliver()));
    expect(native.routeCommand).not.toHaveBeenCalled();
    expect(native.hide).not.toHaveBeenCalled();
  });

  it("routes an older opening from another toolset after the newer toolset closes", async () => {
    await pushMenu(main, "rings", { openedAt: 3, generation: 1 });
    await act(async () => host.querySelector("button")!.click());
    await vi.waitFor(() => expect(native.hide).toHaveBeenCalledOnce());
    expect(await press("ArrowDown")).toBe(false);
    await pushMenu(art, "shapes", { openedAt: 2, generation: 1 });
    expect(await press("ArrowDown")).toBe(true);
    expect(highlighted()).toBe("shapes");
  });

  it("allows delayed content after a payload-less dismissal", async () => {
    await act(async () => dismissToolsetPopovers());
    await pushMenu(main, "rings", { openedAt: 1, generation: 1 });
    expect(native.show).toHaveBeenCalledOnce();
    expect(await press("ArrowDown")).toBe(true);
    expect(highlighted()).toBe("rings");
  });

  it("routes Escape to a delayed stamped opening after a payload-less dismissal", async () => {
    const dismissListeners = native.listeners.get(TOOLSET_POPOVER_DISMISS_EVENT)!.size;
    const stopEscape = installPopoverEscapeRouting();
    // The document and popover share a DOM in this fixture. Stop document keys
    // before they can reach the popover renderer's own Escape listener.
    const canvasEscape = vi.fn((event: KeyboardEvent) => event.stopPropagation());
    try {
      await vi.waitFor(() => expect(native.listeners.get(TOOLSET_POPOVER_DISMISS_EVENT)?.size).toBe(dismissListeners + 1));
      await act(async () => dismissToolsetPopovers());
      const opening = { openedAt: 1, generation: 1 };
      await pushMenu(main, "rings", opening);
      expect(native.show).toHaveBeenCalledOnce();
      expect(await press("ArrowDown")).toBe(true);
      document.body.addEventListener("keydown", canvasEscape);
      expect(await press("Escape")).toBe(true);
      expect(canvasEscape).not.toHaveBeenCalled();
      expect(native.emit).toHaveBeenCalledWith(TOOLSET_POPOVER_DISMISS_EVENT, {
        reason: "escape", requestedAt: expect.any(Number), openings: [{ toolsetId: main, ...opening }]
      });
      expect(native.visible).toBe(false);
      expect(await press("ArrowDown")).toBe(false);
    } finally {
      document.body.removeEventListener("keydown", canvasEscape);
      stopEscape();
    }
  });

  it("releases routing when the failed color reveal closes before its content reaches the router", async () => {
    await pushMenu(main, "rings", { openedAt: 1, generation: 1 });
    expect(await press("ArrowDown")).toBe(true);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    native.show.mockRejectedValueOnce(new Error("Color picker reveal failed"))
      .mockRejectedValueOnce(new Error("Color picker fallback failed"));
    let contentDeliveries = 0;
    native.hold = (event, payload) => {
      if (event !== contentEvent) return false;
      const notice = payload as { kind?: string; accepted?: true; flyoutId?: string };
      return notice.accepted ? notice.flyoutId === undefined
        : notice.kind === "artColor" && ++contentDeliveries >= 3;
    };
    // Deliver the picker request to its renderer and hold its content notice to the router.
    await act(async () => setToolsetPopoverContent(main, { kind: "artColor", openedAt: 2, generation: 2 }));
    expect(native.queued.length).toBeGreaterThan(0);
    expect(native.hide).toHaveBeenCalledOnce();
    expect(await press("ArrowDown")).toBe(false);
    expect(native.emit).not.toHaveBeenCalledWith(contentEvent, expect.objectContaining({
      toolsetId: main, openedAt: 2, generation: 2, accepted: true
    }));
    await act(async () => native.queued.splice(0).forEach(deliver => deliver()));
    expect(await press("ArrowDown")).toBe(false);
  });
});
