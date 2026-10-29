// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dismissToolsetPopovers, listenForToolsetPopoverDismiss, TOOLSET_POPOVER_DISMISS_EVENT, toolsetPopoverTimestamp } from "./index";

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

const host = window as typeof window & { __TAURI__?: unknown };
beforeEach(() => { host.__TAURI__ = {}; vi.clearAllMocks(); });
afterEach(() => { delete host.__TAURI__; });

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
