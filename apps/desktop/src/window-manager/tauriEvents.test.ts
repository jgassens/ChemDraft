import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Event, EventCallback, UnlistenFn } from "@tauri-apps/api/event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeTauriListen, UNLISTEN_ATTEMPTS } from "./tauriEvents";

/**
 * Tauri 2.11.2 as the page sees it: `listen()` resolves on the IPC reply, while the script that puts
 * the listener's entry into the page runs separately (`register()` here). Unlisten reads that entry's
 * `handlerId` with no guard, so an unlisten that runs before the entry exists rejects with the
 * TypeError the crash reporter showed, and removes nothing.
 */
function tauri2112() {
  let nextId = 1;
  const registered = new Set<number>();
  const pending: number[] = [];
  const handlers = new Map<number, EventCallback<string>>();
  const counts = { attached: 0, unlistenCalls: 0, removed: 0 };
  const attach = (handler: EventCallback<string>): Promise<UnlistenFn> => {
    const id = nextId++;
    counts.attached += 1;
    handlers.set(id, handler);
    pending.push(id);
    return Promise.resolve(async () => {
      counts.unlistenCalls += 1;
      if (!registered.has(id)) {
        throw new TypeError("Cannot read properties of undefined (reading 'handlerId')");
      }
      if (handlers.delete(id)) {
        counts.removed += 1;
      }
    });
  };
  return {
    attach,
    counts,
    /** The page runs the scripts that register every listener attached so far. */
    register() {
      for (const id of pending.splice(0)) registered.add(id);
    },
    /** Deliver to every native listener still in place, registered or not. */
    deliver(payload: string) {
      for (const [id, handler] of handlers) handler({ event: "test", id, payload } as Event<string>);
    }
  };
}

describe("safeTauriListen", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  beforeEach(() => {
    vi.useFakeTimers();
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
  });

  afterEach(async () => {
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    // Let Node report any rejection still unhandled before checking.
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off("unhandledRejection", onUnhandled);
    vi.restoreAllMocks();
    expect(unhandled).toEqual([]);
  });

  it("is what crashed: Tauri's own unlisten, run before the page registers the listener, rejects", async () => {
    const page = tauri2112();
    const unlisten = await page.attach(() => undefined);
    await expect(unlisten()).rejects.toThrow("reading 'handlerId'");
    expect(page.counts.removed).toBe(0);
  });

  it("removes the native listener once, however many times stop is called", async () => {
    const page = tauri2112();
    const { stop, attached } = safeTauriListen("test", page.attach, () => undefined);
    expect(await attached).toBe(stop);
    page.register();
    stop();
    stop();
    stop();
    await vi.runAllTimersAsync();
    expect(page.counts.unlistenCalls).toBe(1);
    expect(page.counts.removed).toBe(1);
  });

  it("applies a stop made before listen() resolves, once it does", async () => {
    const page = tauri2112();
    let finishAttach: () => void = () => undefined;
    const handler = vi.fn();
    const { stop, attached } = safeTauriListen<string>("test", (wrapped) => new Promise<UnlistenFn>((resolve) => {
      finishAttach = () => void page.attach(wrapped).then(resolve);
    }), handler);
    stop();
    expect(page.counts.attached).toBe(0);
    finishAttach();
    await attached;
    page.register();
    await vi.runAllTimersAsync();
    expect(page.counts.removed).toBe(1);
    page.deliver("late");
    expect(handler).not.toHaveBeenCalled();
  });

  it("survives a stop in the gap before the page registers the listener, and still removes it", async () => {
    const page = tauri2112();
    const { stop, attached } = safeTauriListen("test", page.attach, () => undefined);
    await attached;
    stop(); // The page has not run the registration script yet: Tauri's unlisten rejects.
    await vi.advanceTimersByTimeAsync(0);
    expect(page.counts.unlistenCalls).toBe(1);
    expect(page.counts.removed).toBe(0);

    page.register();
    await vi.runAllTimersAsync();
    expect(page.counts.unlistenCalls).toBe(2);
    expect(page.counts.removed).toBe(1);
  });

  it("mutes the handler at stop, even while the native listener is still in place", async () => {
    const page = tauri2112();
    const handler = vi.fn();
    const { stop, attached } = safeTauriListen<string>("test", page.attach, handler);
    await attached;
    page.register();
    page.deliver("before");
    expect(handler).toHaveBeenCalledTimes(1);
    stop();
    page.deliver("after"); // Delivered before the native unlisten lands.
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("gives up after a bounded number of tries with a console warning, never a rejection", async () => {
    const page = tauri2112();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const handler = vi.fn();
    const { stop, attached } = safeTauriListen<string>("test", page.attach, handler);
    await attached;
    stop(); // The registration never lands.
    await vi.runAllTimersAsync();
    expect(page.counts.unlistenCalls).toBe(UNLISTEN_ATTEMPTS);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("test");
    page.deliver("stray");
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects `attached` when listening fails, and stop is then a no-op", async () => {
    const failure = new Error("IPC unavailable");
    const { stop, attached } = safeTauriListen("test", () => Promise.reject(failure), () => undefined);
    await expect(attached).rejects.toBe(failure);
    expect(() => stop()).not.toThrow();
  });

  it("copes with a synchronous throw from unlisten as well as a rejection", async () => {
    let calls = 0;
    const { stop, attached } = safeTauriListen("test", () => Promise.resolve(() => {
      calls += 1;
      if (calls === 1) throw new TypeError("sync");
    }), () => undefined);
    await attached;
    stop();
    await vi.runAllTimersAsync();
    expect(calls).toBe(2);
  });
});

describe("every Tauri listener goes through safeTauriListen", () => {
  // A direct `listen` brings back the unguarded unlisten: these are the forms the app used.
  const forbidden = [
    /import\s*\{[^}]*\blisten\b[^}]*\}\s*from\s*["']@tauri-apps\/api\/event["']/,
    /\{[^}]*\blisten\b[^}]*\}\s*=\s*await\s+import\(\s*["']@tauri-apps\/api\/event["']\s*\)/,
    /\.then\(\s*\(\s*\{[^}]*\blisten\b[^}]*\}\s*\)\s*=>/,
    /getCurrentWebviewWindow\(\)\s*\.listen\s*[<(]/,
    /\b(?:getCurrentWindow|getCurrentWebview)\(\)\s*\.(?:listen|once)\s*[<(]/,
    // Tauri's window helpers listen internally and hand back the same unguarded unlisten.
    /\.(?:onFocusChanged|onCloseRequested|onResized|onMoved|onScaleChanged|onDragDropEvent|onThemeChanged)\s*\(/
  ];
  const sourceRoot = join(process.cwd(), "apps", "desktop", "src");
  const files = (function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  })(sourceRoot);

  it("finds the app sources", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("has no direct listen outside tauriEvents.ts", () => {
    const offenders = files
      .filter((path) => !path.endsWith(join("window-manager", "tauriEvents.ts")))
      .filter((path) => forbidden.some((pattern) => pattern.test(readFileSync(path, "utf8"))))
      .map((path) => relative(sourceRoot, path));
    expect(offenders).toEqual([]);
  });
});
