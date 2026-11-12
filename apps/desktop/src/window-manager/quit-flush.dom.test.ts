// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => {
  const listeners = new Map<string, (event: { event: string; id: number; payload: unknown }) => void>();
  return {
    listeners,
    invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
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

import { cancelQuit, confirmQuitAfterFlush, listenForQuitFlushRequest, listenForQuitPromptRequest, loadDocumentSession, QUIT_PROMPT_REQUEST_EVENT, QUIT_FLUSH_REQUEST_EVENT, saveDocumentSession } from "./index";
import { runUpdateFlow, tauriUpdateFlowDeps, UPDATE_SESSION_DRAIN_TIMEOUT_MS } from "../appUpdates";

function requestFlush() {
  native.listeners.get(QUIT_FLUSH_REQUEST_EVENT)?.({ event: QUIT_FLUSH_REQUEST_EVENT, id: 1, payload: 42 });
}

beforeEach(async () => {
  native.listeners.clear();
  native.listen.mockClear();
  native.invoke.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  native.invoke.mockResolvedValueOnce({ incarnation: 1, session: null });
  await loadDocumentSession();
  native.invoke.mockClear();
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
      await saveDocumentSession(session, { flush: true });
      await confirmQuitAfterFlush(requestId);
    });
    expect(native.listen).toHaveBeenCalledWith(QUIT_FLUSH_REQUEST_EVENT, expect.any(Function));
    requestFlush();
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("save_document_session", {
      // Each snapshot now identifies the native window incarnation loaded before editing.
      state: session, revision: expect.any(Number), incarnation: 1, flush: true, replacePreserved: true
    }));
    expect(native.invoke).toHaveBeenCalledTimes(1);
    finishWrite();
    // A7 correlates each acknowledgment so a stale quit cannot finish a later update barrier.
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("quit_after_flush", { requestId: 42 }));
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

  it("reports a failed confirmation IPC to the caller", async () => {
    native.invoke.mockRejectedValue(new Error("native exit unavailable"));
    // A7 must surface failed acknowledgments instead of treating an unwritten close as complete.
    await expect(confirmQuitAfterFlush(42)).rejects.toThrow("native exit unavailable");
    expect(native.invoke).toHaveBeenCalledWith("quit_after_flush", { requestId: 42 });
  });

  it("distinguishes mandatory window close choices and releases earlier windows when quit is cancelled", async () => {
    const prompt = vi.fn().mockResolvedValue(undefined);
    const cancelled = vi.fn();
    const stop = await listenForQuitPromptRequest(prompt, cancelled);
    native.listeners.get(QUIT_PROMPT_REQUEST_EVENT)!({ event: QUIT_PROMPT_REQUEST_EVENT, id: 1,
      payload: { requestId: 4294967297, closingWindow: true } });
    expect(prompt).toHaveBeenCalledWith(4294967297, true);
    native.listeners.get(QUIT_PROMPT_REQUEST_EVENT)!({ event: QUIT_PROMPT_REQUEST_EVENT, id: 1, payload: 3 });
    expect(prompt).toHaveBeenLastCalledWith(3, false);
    native.listeners.get("chemdraft://quit-cancelled")!({ event: "chemdraft://quit-cancelled", id: 1, payload: 3 });
    expect(cancelled).toHaveBeenCalledExactlyOnceWith(3);
    stop();
    expect(native.listeners.size).toBe(0);
  });

  it("distinguishes the user's Cancel from an internal prompt deferral or failure", async () => {
    await cancelQuit(1);
    await cancelQuit(2, "deferred");
    await cancelQuit(3, "failed");
    expect(native.invoke.mock.calls).toEqual([
      ["cancel_quit", { requestId: 1 }],
      ["cancel_quit", { requestId: 2, disposition: "deferred" }],
      ["cancel_quit", { requestId: 3, disposition: "failed" }]
    ]);
  });

  it("submits increasing revisions and requests an immediate strict update flush", async () => {
    await saveDocumentSession({ edit: 1 });
    await saveDocumentSession({ edit: 2 }, { strict: true });
    const first = native.invoke.mock.calls[0]![1] as { revision: number };
    expect(native.invoke.mock.calls[1]).toEqual(["save_document_session", {
      // Revision ordering is scoped to the native incarnation, including strict drains.
      state: { edit: 2 }, revision: first.revision + 1, incarnation: 1, flush: true, replacePreserved: true
    }]);
    native.invoke.mockRejectedValueOnce(new Error("disk full"));
    await expect(saveDocumentSession({ edit: 3 }, { strict: true })).rejects.toThrow("disk full");
  });

  it("loads the native incarnation and carries it with every session snapshot", async () => {
    const session = { tabs: [{ contents: "retained drawing" }] };
    native.invoke.mockResolvedValueOnce({ incarnation: 2, session });
    expect(await loadDocumentSession()).toEqual(session);
    await saveDocumentSession({ edit: "new webview" }, { flush: true });
    expect(native.invoke).toHaveBeenLastCalledWith("save_document_session", {
      state: { edit: "new webview" }, revision: expect.any(Number), incarnation: 2, flush: true, replacePreserved: true
    });
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

  it("aborts an update when the native coordinator drain never answers", async () => {
    vi.useFakeTimers();
    try {
      let finishDrain!: () => void;
      const stalled = new Promise<void>(resolve => { finishDrain = resolve; });
      native.invoke.mockImplementation(async command => {
        if (command === "flush_document_session") await stalled;
      });
      const update = { version: "2", currentVersion: "1", download: vi.fn().mockResolvedValue(undefined),
        install: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
      const deps = { ...tauriUpdateFlowDeps({ setStatus: vi.fn(), flushSession: vi.fn().mockResolvedValue(undefined) }),
        check: vi.fn().mockResolvedValue(update), confirm: vi.fn().mockResolvedValue(true), message: vi.fn().mockResolvedValue(undefined) };
      const result = runUpdateFlow("manual", deps);
      await vi.advanceTimersByTimeAsync(0);
      expect(native.invoke).toHaveBeenCalledWith("flush_document_session");
      await vi.advanceTimersByTimeAsync(UPDATE_SESSION_DRAIN_TIMEOUT_MS);
      expect(await result).toBe("install-failed");
      expect(deps.message).toHaveBeenCalledWith(expect.stringContaining("timed out"), expect.anything());
      expect(update.close).toHaveBeenCalledOnce();
      finishDrain();
      await vi.advanceTimersByTimeAsync(0);
      expect(update.install).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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
