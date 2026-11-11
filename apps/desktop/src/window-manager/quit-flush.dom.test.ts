// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => {
  const listeners = new Map<string, (event: { event: string; id: number; payload: undefined }) => void>();
  return {
    listeners,
    invoke: vi.fn<(...args: unknown[]) => Promise<void>>(),
    listen: vi.fn(async (eventName: string, handler: (event: { event: string; id: number; payload: undefined }) => void) => {
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
import { runUpdateFlow, tauriUpdateFlowDeps } from "../appUpdates";

function requestFlush() {
  native.listeners.get(QUIT_FLUSH_REQUEST_EVENT)?.({ event: QUIT_FLUSH_REQUEST_EVENT, id: 1, payload: undefined });
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
    const stop = await listenForQuitFlushRequest(async () => {
      // The document window uses this same write-then-confirm handshake on either platform.
      await saveDocumentSession(session, { flush: true });
      await confirmQuitAfterFlush();
    });
    expect(native.listen).toHaveBeenCalledWith(QUIT_FLUSH_REQUEST_EVENT, expect.any(Function));
    requestFlush();
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("save_document_session", {
      state: session, revision: expect.any(Number), flush: true, replacePreserved: true
    }));
    expect(native.invoke).toHaveBeenCalledTimes(1);
    finishWrite();
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("quit_after_flush"));
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

  it("contains a failed quit confirmation IPC", async () => {
    native.invoke.mockRejectedValue(new Error("native exit unavailable"));
    await expect(confirmQuitAfterFlush()).resolves.toBeUndefined();
    expect(native.invoke).toHaveBeenCalledWith("quit_after_flush");
  });

  it("submits increasing revisions and requests an immediate strict update flush", async () => {
    await saveDocumentSession({ edit: 1 });
    await saveDocumentSession({ edit: 2 }, { strict: true });
    const first = native.invoke.mock.calls[0]![1] as { revision: number };
    expect(native.invoke.mock.calls[1]).toEqual(["save_document_session", {
      state: { edit: 2 }, revision: first.revision + 1, flush: true, replacePreserved: true
    }]);
    native.invoke.mockRejectedValueOnce(new Error("disk full"));
    await expect(saveDocumentSession({ edit: 3 }, { strict: true })).rejects.toThrow("disk full");
  });

  it.each([false, true])("waits for the whole coordinator before installing an update (disk failure: %s)", async fails => {
    const rendererFlush = vi.fn(async () => { await saveDocumentSession({ edit: "latest" }, { strict: true }); });
    let finishFlush!: () => void;
    const pendingFlush = new Promise<void>(resolve => { finishFlush = resolve; });
    native.invoke.mockImplementation(async command => {
      if (command === "flush_document_session") {
        await pendingFlush;
        if (fails) throw new Error("disk full");
      }
    });
    const update = { version: "2", currentVersion: "1", download: vi.fn().mockResolvedValue(undefined),
      install: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    const deps = { ...tauriUpdateFlowDeps({ setStatus: vi.fn(), flushSession: rendererFlush }),
      check: vi.fn().mockResolvedValue(update), confirm: vi.fn().mockResolvedValue(true), message: vi.fn().mockResolvedValue(undefined) };
    const outcome = runUpdateFlow("manual", deps);
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("flush_document_session"));
    expect(rendererFlush).toHaveBeenCalledTimes(1);
    expect(native.invoke.mock.calls.map(([command]) => command)).toEqual(["save_document_session", "flush_document_session"]);
    expect(update.install).not.toHaveBeenCalled();
    finishFlush();
    expect(await outcome).toBe(fails ? "install-failed" : "installing");
    expect(update.install).toHaveBeenCalledTimes(fails ? 0 : 1);
    if (fails) expect(deps.message).toHaveBeenCalledWith(expect.stringContaining("disk full"), expect.anything());
  });

  it("drains the coordinator even when the renderer preserves an untouched startup session", async () => {
    const deps = tauriUpdateFlowDeps({ setStatus: vi.fn(), flushSession: vi.fn().mockResolvedValue(undefined) });
    await deps.flushSession();
    expect(native.invoke.mock.calls).toEqual([["flush_document_session"]]);
  });
});

it("does not install a quit listener or send native commands in the web preview", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", undefined);
  const handler = vi.fn();
  const stop = await listenForQuitFlushRequest(handler);
  await confirmQuitAfterFlush();
  stop();
  expect(native.listen).not.toHaveBeenCalled();
  expect(native.invoke).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
});
