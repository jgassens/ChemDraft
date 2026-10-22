// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => {
  const listeners = new Map<string, (event: { event: string; id: number; payload: unknown }) => void>();
  return {
    listeners,
    invoke: vi.fn<(...args: unknown[]) => Promise<void>>(),
    listen: vi.fn(async (eventName: string, handler: (event: { event: string; id: number; payload: unknown }) => void) => {
      listeners.set(eventName, handler);
      return () => { listeners.delete(eventName); };
    })
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ listen: native.listen })
}));

import { confirmQuitAfterFlush, listenForQuitFlushRequest, QUIT_FLUSH_REQUEST_EVENT, saveDocumentSession } from "./index";

function requestFlush(requestId = 41) {
  native.listeners.get(QUIT_FLUSH_REQUEST_EVENT)?.({ event: QUIT_FLUSH_REQUEST_EVENT, id: 1, payload: { requestId } });
}

beforeEach(() => {
  native.listeners.clear();
  native.listen.mockClear();
  native.invoke.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("__TAURI_INTERNALS__", {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(["MacIntel", "Win32"])("quit flush on %s", (platform) => {
  beforeEach(() => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  });

  it("listens on the document window and confirms only after the session write finishes", async () => {
    let finishWrite: () => void = () => undefined;
    const pendingWrite = new Promise<void>((resolve) => { finishWrite = resolve; });
    native.invoke.mockImplementation(async (command) => {
      if (command === "save_document_session") await pendingWrite;
    });
    const session = { lastEdit: "inside the autosave debounce" };
    const stop = await listenForQuitFlushRequest(async (requestId) => {
      // The document window uses this same write-then-confirm handshake on either platform.
      await saveDocumentSession(session);
      await confirmQuitAfterFlush(requestId);
    });
    expect(native.listen).toHaveBeenCalledWith(QUIT_FLUSH_REQUEST_EVENT, expect.any(Function));
    requestFlush();
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("save_document_session", { state: session }));
    expect(native.invoke).toHaveBeenCalledTimes(1);
    finishWrite();
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("quit_after_flush", { requestId: 41 }));
    expect(native.invoke.mock.calls.map(([command]) => command)).toEqual(["save_document_session", "quit_after_flush"]);
    stop();
    requestFlush();
    expect(native.invoke).toHaveBeenCalledTimes(2);
  });

  it("contains a rejected handler and leaves native timeout handling in charge", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("webview flush failed"));
    const stop = await listenForQuitFlushRequest(handler);
    requestFlush();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(native.invoke).not.toHaveBeenCalled();
    stop();
  });

  it("reports a failed quit confirmation IPC to the document window", async () => {
    native.invoke.mockRejectedValue(new Error("native exit unavailable"));
    await expect(confirmQuitAfterFlush(41)).rejects.toThrow("native exit unavailable");
    expect(native.invoke).toHaveBeenCalledWith("quit_after_flush", { requestId: 41 });
  });

  it("ignores flush events without a valid native generation", async () => {
    const handler = vi.fn();
    const stop = await listenForQuitFlushRequest(handler);
    requestFlush(0);
    requestFlush(-1);
    requestFlush(NaN);
    native.listeners.get(QUIT_FLUSH_REQUEST_EVENT)?.({ event: QUIT_FLUSH_REQUEST_EVENT, id: 1, payload: undefined });
    expect(handler).not.toHaveBeenCalled();
    stop();
  });
});

it("does not install a quit listener or send native commands in the web preview", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", undefined);
  const handler = vi.fn();
  const stop = await listenForQuitFlushRequest(handler);
  await confirmQuitAfterFlush(41);
  stop();
  expect(native.listen).not.toHaveBeenCalled();
  expect(native.invoke).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
});
