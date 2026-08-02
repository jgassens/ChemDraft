import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args)
}));

import { createPersistentPluginStorage } from "./pluginStorage";

const tauriGlobal = globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown };

describe("createPersistentPluginStorage", () => {
  beforeEach(() => {
    invoke.mockReset();
    tauriGlobal.__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    delete tauriGlobal.__TAURI_INTERNALS__;
  });

  /**
   * Real timers throughout. Fake timers do not work here: the write body awaits a dynamic
   * `import("@tauri-apps/api/core")` after the timer fires, which does not settle within
   * `advanceTimersByTimeAsync` — so the invoke landed in the *next* test, making "no write
   * happened" pass for the wrong reason — while the pending timer survived `useRealTimers()`
   * and fired under the following test's clock.
   *
   * Positive cases poll rather than sleep a fixed span: the 250ms debounce plus a dynamic import
   * is not reliably done within any short fixed wait when the whole suite runs in parallel.
   */
  async function waitUntil(condition: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** For the negative case only: give the debounce every chance to fire, then assert it did not. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 900));
  }

  function writeCalls(): [string, { pluginId: string; contents: string }][] {
    return invoke.mock.calls.filter(([command]) => command === "plugin_storage_write") as [
      string,
      { pluginId: string; contents: string }
    ][];
  }

  function writtenContents(index = 0): unknown {
    return JSON.parse(writeCalls()[index][1].contents);
  }

  it("never writes after a failed read — a rejection is not an empty file", async () => {
    // `.catch(() => null)` flattened a read failure into "absent", so the in-memory map stayed
    // empty and the next set() persisted that emptiness over a storage.json that was fine —
    // the same clobbering trap the Rust layer was hardened against, re-introduced one layer up.
    const diagnostics: string[] = [];
    invoke.mockImplementation((command: string) => {
      if (command === "plugin_storage_read") {
        return Promise.reject(new Error("permission denied"));
      }
      return Promise.resolve(undefined);
    });

    const storage = createPersistentPluginStorage("org.test.plugin", (message) => diagnostics.push(message));
    await storage.set("keep", "me");
    await settle();

    expect(writeCalls()).toHaveLength(0);
    expect(diagnostics.join(" ")).toContain("org.test.plugin");
  });

  it("still writes when the file is genuinely absent", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "plugin_storage_read") {
        return Promise.resolve(null);
      }
      return Promise.resolve(undefined);
    });

    const storage = createPersistentPluginStorage("org.test.plugin");
    await storage.set("first", "value");
    await waitUntil(() => writeCalls().length > 0);

    expect(writeCalls()).toHaveLength(1);
    expect(writtenContents()).toEqual({ first: "value" });
  });

  it("reports a failed write instead of resolving as if it succeeded", async () => {
    const diagnostics: string[] = [];
    invoke.mockImplementation((command: string) => {
      if (command === "plugin_storage_read") {
        return Promise.resolve(null);
      }
      return Promise.reject(new Error("disk full"));
    });

    const storage = createPersistentPluginStorage("org.test.plugin", (message) => diagnostics.push(message));
    await storage.set("key", "value");
    await waitUntil(() => diagnostics.length > 0);

    expect(writeCalls()).toHaveLength(1);
    expect(diagnostics.join(" ")).toContain("disk full");
  });

  it("keeps values readable in memory after a failed write", async () => {
    invoke.mockImplementation((command: string) =>
      command === "plugin_storage_read" ? Promise.resolve(null) : Promise.reject(new Error("disk full"))
    );

    const storage = createPersistentPluginStorage("org.test.plugin", () => undefined);
    await storage.set("key", "value");
    await waitUntil(() => writeCalls().length > 0);

    expect(await storage.get("key")).toBe("value");
    expect(await storage.listKeys()).toEqual(["key"]);
  });

  it("loads existing contents and merges later writes into them", async () => {
    invoke.mockImplementation((command: string) =>
      command === "plugin_storage_read" ? Promise.resolve('{"existing":1}') : Promise.resolve(undefined)
    );

    const storage = createPersistentPluginStorage("org.test.plugin");
    expect(await storage.get("existing")).toBe(1);
    await storage.set("added", 2);
    await waitUntil(() => writeCalls().length > 0);

    expect(writtenContents()).toEqual({ existing: 1, added: 2 });
  });

  it("starts fresh on a corrupt file but still allows writing", async () => {
    invoke.mockImplementation((command: string) =>
      command === "plugin_storage_read" ? Promise.resolve("{not json") : Promise.resolve(undefined)
    );

    const storage = createPersistentPluginStorage("org.test.plugin", () => undefined);
    await storage.set("fresh", true);
    await waitUntil(() => writeCalls().length > 0);

    expect(writeCalls()).toHaveLength(1);
  });

  it("reports an unserializable value instead of an unhandled rejection", async () => {
    // Only the invoke was wrapped, so JSON.stringify — which throws on a cyclic value or a BigInt
    // a plugin stored quite legitimately — escaped as an unhandled rejection from a detached timer:
    // no diagnostic, nothing written, and every later set repeated it. The plugin saw success.
    const diagnostics: string[] = [];
    invoke.mockImplementation((command: string) =>
      command === "plugin_storage_read" ? Promise.resolve(null) : Promise.resolve(undefined)
    );

    const storage = createPersistentPluginStorage("org.test.plugin", (message) => diagnostics.push(message));
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    await storage.set("cyclic", cyclic);
    await waitUntil(() => diagnostics.length > 0);

    expect(diagnostics.join(" ")).toContain("could not be saved");
    // Nothing was written, and the value stays readable in memory rather than being lost silently.
    expect(writeCalls()).toHaveLength(0);
    expect(await storage.get("cyclic")).toBe(cyclic);
  });

  it("reports a corrupt file rather than discarding it silently", async () => {
    // Starting fresh is right — the contents are unusable — but the next save overwrites whatever
    // was in there, and that should not happen without a word.
    const diagnostics: string[] = [];
    invoke.mockImplementation((command: string) =>
      command === "plugin_storage_read" ? Promise.resolve("{not json") : Promise.resolve(undefined)
    );

    const storage = createPersistentPluginStorage("org.test.plugin", (message) => diagnostics.push(message));
    await storage.set("fresh", true);
    await waitUntil(() => writeCalls().length > 0);

    expect(diagnostics.join(" ")).toContain("could not be parsed");
    // Writing stays enabled: overwriting an unparseable file is the repair, unlike an unreadable one.
    expect(writeCalls()).toHaveLength(1);
  });

  it("keeps working when the tauri module itself fails to load", async () => {
    // ensureLoaded memoises its promise, and the dynamic import used to sit OUTSIDE the try. A
    // chunk that would not load therefore left `loaded` permanently rejected: `if (!loaded)` is
    // false forever, so no retry, every later call throwing for the rest of the session, and
    // persistDisabled never set — so the documented degrade-to-in-memory never happened for the
    // one failure mode that most needs it.
    vi.resetModules();
    vi.doMock("@tauri-apps/api/core", () => {
      throw new Error("chunk load failed");
    });

    try {
      const { createPersistentPluginStorage: freshFactory } = await import("./pluginStorage");
      const diagnostics: string[] = [];
      const storage = freshFactory("org.test.plugin", (message) => diagnostics.push(message));

      // Every entry point must RESOLVE, not throw.
      await expect(storage.set("a", 1)).resolves.toBeUndefined();
      await expect(storage.get("a")).resolves.toBe(1);
      await expect(storage.listKeys()).resolves.toEqual(["a"]);
      await expect(storage.delete("a")).resolves.toBeUndefined();
      await expect(storage.listKeys()).resolves.toEqual([]);
      expect(diagnostics.join(" ")).toContain("will not be saved this session");
    } finally {
      vi.doUnmock("@tauri-apps/api/core");
      vi.resetModules();
    }
  });
});
