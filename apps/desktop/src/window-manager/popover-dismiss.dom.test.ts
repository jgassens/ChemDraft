// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dismissToolsetPopovers, listenForToolsetPopoverDismiss, listenForToolsetPopoverContent, setToolsetPopoverContent,
  TOOLSET_POPOVER_DISMISS_EVENT, toolsetPopoverTimestamp, openToolsetPopoverWindow, listenForToolsetPopoverRelease,
  isToolsetPopoverWindowVisible, closeToolsetPopoverWindow, notifyToolsetPopoverClosed, listenForToolsetPopoverClosed,
  newToolsetPopoverOpening, compareToolsetPopoverOpenings,
  listenForToolsetFlyoutKeys, sendToolsetFlyoutKey, listenForToolsetFlyoutClosed, notifyToolsetFlyoutClosed } from "./index";

const transport = vi.hoisted(() => ({
  emit: vi.fn(async (_event: string, _payload?: unknown) => {}),
  invoke: vi.fn(async (_command: string, _args?: unknown) => {}),
  isVisible: vi.fn(async () => false),
  getByLabel: vi.fn(),
  receive: undefined as undefined | ((event: { event: string; id: number; payload: unknown }) => void)
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: transport.emit,
  listen: vi.fn(async (_event: string, receive: typeof transport.receive) => {
    transport.receive = receive;
    return () => { transport.receive = undefined; };
  })
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: transport.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ Window: { getByLabel: transport.getByLabel } }));

const host = window as typeof window & { __TAURI__?: unknown };
beforeEach(() => { host.__TAURI__ = {}; vi.clearAllMocks(); });
afterEach(() => { delete host.__TAURI__; vi.restoreAllMocks(); });

it("assigns distinct sequences at identical timestamps and retains them through replay, close and Escape", async () => {
  vi.spyOn(performance, "now").mockReturnValue(100);
  const first = newToolsetPopoverOpening();
  const second = newToolsetPopoverOpening();
  expect(second.openedAt).toBe(first.openedAt);
  expect(second.generation).toBe(first.generation + 1);
  expect(compareToolsetPopoverOpenings(second, first)).toBeGreaterThan(0);
  const content = { kind: "artColor", ...second } as const;
  await setToolsetPopoverContent("core.art", content);
  await setToolsetPopoverContent("core.art", content);
  expect(transport.emit.mock.calls[0]).toEqual(transport.emit.mock.calls[1]);
  await notifyToolsetPopoverClosed("core.art", first.openedAt, first.generation);
  expect(transport.emit).toHaveBeenLastCalledWith("chemdraft://toolset-popover-closed", { toolsetId: "core.art", ...first });
  const openings = [{ toolsetId: "core.art", ...second }];
  await dismissToolsetPopovers(200, "escape", openings);
  expect(transport.emit).toHaveBeenLastCalledWith(TOOLSET_POPOVER_DISMISS_EVENT, { requestedAt: 200, reason: "escape", openings });
});

it.each([false, true])("reads native popover visibility (%s) with the same label as Rust", async visible => {
  transport.isVisible.mockResolvedValue(visible);
  transport.getByLabel.mockResolvedValue({ isVisible: transport.isVisible });
  expect(await isToolsetPopoverWindowVisible("core.art")).toBe(visible);
  expect(transport.getByLabel).toHaveBeenCalledExactlyOnceWith("toolset-popover-core-art");
  expect(transport.isVisible).toHaveBeenCalledTimes(1);
});

it("treats an uncreated popover and a browser preview as hidden", async () => {
  transport.getByLabel.mockResolvedValue(null);
  expect(await isToolsetPopoverWindowVisible("core.art")).toBe(false);
  expect(transport.isVisible).not.toHaveBeenCalled();
  transport.getByLabel.mockClear();
  delete host.__TAURI__;
  expect(await isToolsetPopoverWindowVisible("core.art")).toBe(false);
  expect(transport.getByLabel).not.toHaveBeenCalled();
});

it.each([
  { openedAt: 200, generation: 1 },
  { openedAt: 100, generation: 2 }
])("does not natively close a newer opening %j after a deferred visibility reply", async newer => {
  const toolsetId = `core.staleClose-${newer.openedAt}-${newer.generation}`;
  const first = { kind: "artColor", openedAt: 100, generation: 1 } as const;
  await setToolsetPopoverContent(toolsetId, first);
  let resolveVisibility!: (visible: boolean) => void;
  transport.getByLabel.mockResolvedValue({ isVisible: transport.isVisible });
  transport.isVisible.mockImplementationOnce(() => new Promise(resolve => { resolveVisibility = resolve; }));
  const closing = (async () => {
    if (await isToolsetPopoverWindowVisible(toolsetId)) {
      await closeToolsetPopoverWindow(toolsetId, first.openedAt, first.generation);
    }
  })();
  await vi.waitFor(() => expect(transport.isVisible).toHaveBeenCalledTimes(1));
  await openToolsetPopoverWindow(toolsetId, "flyout", 10, 20);
  await setToolsetPopoverContent(toolsetId, { kind: "flyout", ...newer,
    flyout: { flyoutId: "shapes", title: "Shapes", commands: [] } });
  await setToolsetPopoverContent(toolsetId, first); // A delayed replay cannot authorize the stale close.
  resolveVisibility(true);
  await closing;
  expect(transport.invoke).not.toHaveBeenCalledWith("close_toolset_popover", expect.anything());
  expect(transport.emit).not.toHaveBeenCalledWith("chemdraft://toolset-popover-closed", expect.anything());
  await closeToolsetPopoverWindow(toolsetId, newer.openedAt, newer.generation);
  expect(transport.invoke).toHaveBeenLastCalledWith("close_toolset_popover", { toolsetId });
});

it("rechecks the opening after importing the native close API", async () => {
  await setToolsetPopoverContent("core.closeImport", { kind: "artColor", openedAt: 100, generation: 1 });
  const closing = closeToolsetPopoverWindow("core.closeImport", 100, 1);
  const opening = setToolsetPopoverContent("core.closeImport", { kind: "artColor", openedAt: 100, generation: 2 });
  await Promise.all([closing, opening]);
  expect(transport.invoke).not.toHaveBeenCalledWith("close_toolset_popover", expect.anything());
});

it("forwards the captured opening release once even if the button stops propagation", async () => {
  const handler = vi.fn();
  const stop = await listenForToolsetPopoverRelease(handler);
  await openToolsetPopoverWindow("core.main", "flyout", 10, 20);
  const button = document.createElement("button"); document.body.append(button);
  button.addEventListener("pointerup", event => event.stopPropagation());
  button.dispatchEvent(new Event("pointerup", { bubbles: true }));
  await vi.waitFor(() => expect(transport.emit).toHaveBeenCalledWith("chemdraft://toolset-popover-release",
    { toolsetId: "core.main", releasedAt: expect.any(Number) }));
  button.dispatchEvent(new Event("pointerup", { bubbles: true }));
  expect(transport.emit).toHaveBeenCalledTimes(1);
  const payload = transport.emit.mock.calls[0][1];
  transport.receive?.({ event: "chemdraft://toolset-popover-release", id: 1, payload });
  expect(handler).toHaveBeenCalledWith(payload);
  button.remove(); stop();
});

it("transports the original press timestamp through emit and listen without restamping on delivery", async () => {
  const handler = vi.fn();
  const stop = await listenForToolsetPopoverDismiss(handler);
  const requestedAt = toolsetPopoverTimestamp();
  await dismissToolsetPopovers(requestedAt);
  expect(transport.emit).toHaveBeenCalledWith(TOOLSET_POPOVER_DISMISS_EVENT, { requestedAt });
  transport.receive?.({ event: TOOLSET_POPOVER_DISMISS_EVENT, id: 1, payload: { requestedAt } });
  expect(handler).toHaveBeenCalledWith({ requestedAt });
  stop();
});

it("preserves unconditional unstamped broadcasts, including Tauri's null payload", async () => {
  const handler = vi.fn();
  const stop = await listenForToolsetPopoverDismiss(handler);
  await dismissToolsetPopovers();
  expect(transport.emit).toHaveBeenCalledWith(TOOLSET_POPOVER_DISMISS_EVENT, undefined);
  for (const payload of [undefined, null]) {
    transport.receive?.({ event: TOOLSET_POPOVER_DISMISS_EVENT, id: 1, payload });
    expect(handler).toHaveBeenLastCalledWith(payload);
  }
  stop();
});

it("transports Escape cancellation separately from click-away dismissal", async () => {
  const handler = vi.fn();
  const stop = await listenForToolsetPopoverDismiss(handler);
  const requestedAt = toolsetPopoverTimestamp();
  await dismissToolsetPopovers(requestedAt, "escape");
  const payload = { requestedAt, reason: "escape" };
  expect(transport.emit).toHaveBeenCalledWith(TOOLSET_POPOVER_DISMISS_EVENT, payload);
  transport.receive?.({ event: TOOLSET_POPOVER_DISMISS_EVENT, id: 1, payload });
  expect(handler).toHaveBeenCalledWith(payload);
  stop();
});

it("transports the closed opening identity so stale replays cannot claim another Escape", async () => {
  const handler = vi.fn();
  const stop = await listenForToolsetPopoverClosed(handler);
  const payload = { toolsetId: "core.main", openedAt: toolsetPopoverTimestamp() };
  await notifyToolsetPopoverClosed(payload.toolsetId, payload.openedAt);
  expect(transport.emit).toHaveBeenCalledWith("chemdraft://toolset-popover-closed", payload);
  transport.receive?.({ event: "chemdraft://toolset-popover-closed", id: 1, payload });
  expect(handler).toHaveBeenCalledWith(payload);
  stop();
});

it("transports the originating open time with the content without restamping it", async () => {
  const handler = vi.fn();
  const stop = await listenForToolsetPopoverContent(handler);
  const openedAt = toolsetPopoverTimestamp() - 100;
  const content = { kind: "artColor", openedAt } as const;
  const anchor = { x: 10, y: 20 };
  await setToolsetPopoverContent("core.art", content, anchor);
  const payload = { toolsetId: "core.art", anchor, ...content };
  expect(transport.emit).toHaveBeenCalledWith("chemdraft://toolset-popover-content", payload);
  transport.receive?.({ event: "chemdraft://toolset-popover-content", id: 1, payload });
  expect(handler).toHaveBeenCalledWith(payload);
  stop();
});

it("transports flyout keys with the originating session without transferring focus", async () => {
  const handler = vi.fn();
  const stop = await listenForToolsetFlyoutKeys(handler);
  const payload = { toolsetId: "core.main", flyoutId: "rings", openedAt: 123, key: "ArrowDown" };
  await sendToolsetFlyoutKey(payload);
  expect(transport.emit).toHaveBeenCalledExactlyOnceWith("chemdraft://toolset-flyout-key", payload);
  transport.receive?.({ event: "chemdraft://toolset-flyout-key", id: 1, payload });
  expect(handler).toHaveBeenCalledExactlyOnceWith(payload);
  stop();
});

it("notifies the document which flyout session closed", async () => {
  const handler = vi.fn();
  const stop = await listenForToolsetFlyoutClosed(handler);
  const payload = { toolsetId: "core.main", flyoutId: "rings", openedAt: 123 };
  await notifyToolsetFlyoutClosed(payload);
  expect(transport.emit).toHaveBeenCalledExactlyOnceWith("chemdraft://toolset-flyout-closed", payload);
  transport.receive?.({ event: "chemdraft://toolset-flyout-closed", id: 1, payload });
  expect(handler).toHaveBeenCalledExactlyOnceWith(payload);
  stop();
});
