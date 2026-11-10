// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dismissToolsetPopovers, listenForToolsetPopoverDismiss, listenForToolsetPopoverContent, setToolsetPopoverContent,
  TOOLSET_POPOVER_DISMISS_EVENT, toolsetPopoverTimestamp, openToolsetPopoverWindow, listenForToolsetPopoverRelease,
  listenForToolsetFlyoutKeys, sendToolsetFlyoutKey, listenForToolsetFlyoutClosed, notifyToolsetFlyoutClosed } from "./index";

const transport = vi.hoisted(() => ({
  emit: vi.fn(async (_event: string, _payload?: unknown) => {}),
  receive: undefined as undefined | ((event: { event: string; id: number; payload: unknown }) => void)
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: transport.emit,
  listen: vi.fn(async (_event: string, receive: typeof transport.receive) => {
    transport.receive = receive;
    return () => { transport.receive = undefined; };
  })
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));

const host = window as typeof window & { __TAURI__?: unknown };
beforeEach(() => { host.__TAURI__ = {}; vi.clearAllMocks(); });
afterEach(() => { delete host.__TAURI__; });

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
