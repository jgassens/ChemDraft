import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args)
}));

import {
  createPersistentPluginStorage,
  deletePersistentPluginStorage,
  PLUGIN_STORAGE_MAX_BYTES,
  webPluginStorageKey
} from "./pluginStorage";

/** A Map-backed Storage whose every method can be made to throw, like a blocked or full browser store. */
class FakeLocalStorage {
  readonly items = new Map<string, string>();
  failGet: Error | undefined;
  failSet: Error | undefined;
  readonly getItem = vi.fn((key: string) => {
    if (this.failGet) throw this.failGet;
    return this.items.get(key) ?? null;
  });
  readonly setItem = vi.fn((key: string, value: string) => {
    if (this.failSet) throw this.failSet;
    this.items.set(key, value);
  });
  readonly removeItem = vi.fn((key: string) => {
    this.items.delete(key);
  });
}

function domException(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

// One window for the whole file: the module installs its pagehide listener once, on the first window
// it sees. Tests swap the storage behind it instead of the window itself.
let localStorageImpl: FakeLocalStorage | null = new FakeLocalStorage();
let localStorageAccessError: Error | undefined;
const pageHideListeners: (() => void)[] = [];
const fakeWindow = {
  get localStorage() {
    if (localStorageAccessError) throw localStorageAccessError;
    return localStorageImpl;
  },
  addEventListener: (type: string, listener: () => void) => {
    if (type === "pagehide") pageHideListeners.push(listener);
  }
};

const tauriGlobal = globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown };

async function waitUntil(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Negative cases: give the 250 ms debounce every chance to fire, then assert it did not. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 600));
}

describe("createPersistentPluginStorage in the browser build", () => {
  let storage: FakeLocalStorage;

  beforeAll(() => {
    vi.stubGlobal("window", fakeWindow);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    invoke.mockReset();
    delete tauriGlobal.__TAURI_INTERNALS__;
    storage = new FakeLocalStorage();
    localStorageImpl = storage;
    localStorageAccessError = undefined;
  });

  afterEach(() => {
    delete tauriGlobal.__TAURI_INTERNALS__;
  });

  it("survives a reload: a fresh module and store read back what was saved", async () => {
    const pluginId = "org.test.reload";
    const first = createPersistentPluginStorage(pluginId);
    await first.set("howToPlaySeen", true);
    await first.set("progress", { level: 3, best: [1, 2] });
    await waitUntil(() => storage.items.has(webPluginStorageKey(pluginId)));

    expect(JSON.parse(storage.items.get("chemdraft.pluginStorage.org.test.reload")!)).toEqual({
      howToPlaySeen: true,
      progress: { level: 3, best: [1, 2] }
    });

    // A reload re-evaluates the module: no caches, no generations, only what localStorage holds.
    vi.resetModules();
    const reloaded = await import("./pluginStorage");
    const second = reloaded.createPersistentPluginStorage(pluginId);
    expect(await second.get("howToPlaySeen")).toBe(true);
    expect(await second.get("progress")).toEqual({ level: 3, best: [1, 2] });
    expect(await second.listKeys()).toEqual(["howToPlaySeen", "progress"]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("debounces saves into one write of the whole document", async () => {
    const plugin = createPersistentPluginStorage("org.test.debounce");
    await plugin.set("a", 1);
    await plugin.set("b", 2);
    await plugin.delete("a");
    await waitUntil(() => storage.setItem.mock.calls.length > 0);
    await settle();

    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.setItem.mock.calls[0][1])).toEqual({ b: 2 });
  });

  it("flushes a pending save on pagehide, so a quick reload keeps it", async () => {
    const plugin = createPersistentPluginStorage("org.test.pagehide");
    await plugin.set("dismissed", true);
    expect(storage.setItem).not.toHaveBeenCalled();

    pageHideListeners.forEach((listener) => listener());

    expect(storage.items.get(webPluginStorageKey("org.test.pagehide"))).toBe('{"dismissed":true}');
    await settle();
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("keeps each plugin's document under its own key", async () => {
    const alpha = createPersistentPluginStorage("org.test.alpha");
    const beta = createPersistentPluginStorage("org.test.beta");
    await alpha.set("score", 10);
    await beta.set("score", 99);
    await waitUntil(() => storage.items.size === 2);

    expect(JSON.parse(storage.items.get(webPluginStorageKey("org.test.alpha"))!)).toEqual({ score: 10 });
    expect(JSON.parse(storage.items.get(webPluginStorageKey("org.test.beta"))!)).toEqual({ score: 99 });

    vi.resetModules();
    const reloaded = await import("./pluginStorage");
    expect(await reloaded.createPersistentPluginStorage("org.test.alpha").get("score")).toBe(10);
    expect(await reloaded.createPersistentPluginStorage("org.test.beta").get("score")).toBe(99);
    expect(await reloaded.createPersistentPluginStorage("org.test.gamma").listKeys()).toEqual([]);
  });

  it("refuses a document over the desktop size limit with the desktop's message, then saves smaller ones", async () => {
    const diagnostics: string[] = [];
    const plugin = createPersistentPluginStorage("org.test.big", (message) => diagnostics.push(message));
    await plugin.set("blob", "x".repeat(PLUGIN_STORAGE_MAX_BYTES));
    await waitUntil(() => diagnostics.length > 0);

    expect(PLUGIN_STORAGE_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(diagnostics.join(" ")).toContain(`Plugin storage payload exceeds ${PLUGIN_STORAGE_MAX_BYTES} bytes.`);
    expect(storage.setItem).not.toHaveBeenCalled();
    // The value stays readable in memory, as on desktop.
    expect((await plugin.get<string>("blob"))?.length).toBe(PLUGIN_STORAGE_MAX_BYTES);

    await plugin.delete("blob");
    await plugin.set("small", 1);
    await waitUntil(() => storage.setItem.mock.calls.length > 0);
    expect(storage.items.get(webPluginStorageKey("org.test.big"))).toBe('{"small":1}');
  });

  it("measures the limit in UTF-8 bytes, like the Rust check", async () => {
    const diagnostics: string[] = [];
    const plugin = createPersistentPluginStorage("org.test.utf8", (message) => diagnostics.push(message));
    // Under the limit in UTF-16 code units, over it in UTF-8 bytes (3 bytes each).
    await plugin.set("text", "€".repeat(Math.ceil(PLUGIN_STORAGE_MAX_BYTES / 3)));
    await waitUntil(() => diagnostics.length > 0);

    expect(diagnostics.join(" ")).toContain("exceeds");
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("falls back to memory with one diagnostic when reading localStorage throws a SecurityError", async () => {
    const diagnostics: string[] = [];
    localStorageAccessError = domException("SecurityError", "The operation is insecure.");
    const plugin = createPersistentPluginStorage("org.test.blocked", (message) => diagnostics.push(message));

    await expect(plugin.set("a", 1)).resolves.toBeUndefined();
    await expect(plugin.set("b", 2)).resolves.toBeUndefined();
    await expect(plugin.get("a")).resolves.toBe(1);
    await expect(plugin.listKeys()).resolves.toEqual(["a", "b"]);
    await expect(plugin.delete("a")).resolves.toBeUndefined();
    await settle();

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("org.test.blocked");
    expect(diagnostics[0]).toContain("The operation is insecure.");
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("falls back to memory when getItem throws, and does not then overwrite what it could not read", async () => {
    const diagnostics: string[] = [];
    storage.items.set(webPluginStorageKey("org.test.getfail"), '{"keep":true}');
    storage.failGet = domException("SecurityError", "Access is denied for this document.");
    const plugin = createPersistentPluginStorage("org.test.getfail", (message) => diagnostics.push(message));

    await plugin.set("new", 1);
    await settle();

    expect(diagnostics).toHaveLength(1);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.items.get(webPluginStorageKey("org.test.getfail"))).toBe('{"keep":true}');
  });

  it("falls back to memory with one diagnostic when localStorage is null", async () => {
    const diagnostics: string[] = [];
    localStorageImpl = null;
    const plugin = createPersistentPluginStorage("org.test.null", (message) => diagnostics.push(message));
    await plugin.set("a", 1);
    await settle();

    expect(await plugin.get("a")).toBe(1);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("not be saved this session");
  });

  it("stops saving after a QuotaExceededError, with one diagnostic and values kept in memory", async () => {
    const diagnostics: string[] = [];
    storage.failSet = domException("QuotaExceededError", "The quota has been exceeded.");
    const plugin = createPersistentPluginStorage("org.test.quota", (message) => diagnostics.push(message));

    await expect(plugin.set("a", 1)).resolves.toBeUndefined();
    await waitUntil(() => diagnostics.length > 0);
    await expect(plugin.set("b", 2)).resolves.toBeUndefined();
    await settle();

    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("The quota has been exceeded.");
    expect(await plugin.get("a")).toBe(1);
    expect(await plugin.get("b")).toBe(2);
  });

  it("starts fresh on a corrupt or non-object document and repairs it on the next save", async () => {
    const diagnostics: string[] = [];
    storage.items.set(webPluginStorageKey("org.test.corrupt"), "[1,2,3]");
    const plugin = createPersistentPluginStorage("org.test.corrupt", (message) => diagnostics.push(message));

    expect(await plugin.listKeys()).toEqual([]);
    await plugin.set("fresh", true);
    await waitUntil(() => storage.setItem.mock.calls.length > 0);

    expect(diagnostics.join(" ")).toContain("could not be parsed");
    expect(storage.items.get(webPluginStorageKey("org.test.corrupt"))).toBe('{"fresh":true}');
  });

  it("explicit deletion removes the localStorage key and cached values, leaving other plugins alone", async () => {
    const plugin = createPersistentPluginStorage("org.test.remove");
    const other = createPersistentPluginStorage("org.test.stay");
    await plugin.set("a", 1);
    await other.set("b", 2);
    await waitUntil(() => storage.items.size === 2);

    await deletePersistentPluginStorage("org.test.remove");

    expect(storage.items.has(webPluginStorageKey("org.test.remove"))).toBe(false);
    expect(await plugin.listKeys()).toEqual([]);
    expect(await createPersistentPluginStorage("org.test.remove").listKeys()).toEqual([]);
    expect(storage.items.has(webPluginStorageKey("org.test.stay"))).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("a pending save does not recreate the key after deletion", async () => {
    const plugin = createPersistentPluginStorage("org.test.pending-delete");
    await plugin.set("a", 1);
    await deletePersistentPluginStorage("org.test.pending-delete");
    pageHideListeners.forEach((listener) => listener());
    await settle();

    expect(storage.items.has(webPluginStorageKey("org.test.pending-delete"))).toBe(false);
  });

  it("leaves the desktop path on Tauri commands and never touches localStorage there", async () => {
    tauriGlobal.__TAURI_INTERNALS__ = {};
    invoke.mockImplementation((command: string) =>
      command === "plugin_storage_read" ? Promise.resolve('{"existing":1}') : Promise.resolve(undefined)
    );
    const plugin = createPersistentPluginStorage("org.test.desktop");
    expect(await plugin.get("existing")).toBe(1);
    await plugin.set("added", 2);
    await waitUntil(() => invoke.mock.calls.some(([command]) => command === "plugin_storage_write"));
    await deletePersistentPluginStorage("org.test.desktop");

    expect(invoke).toHaveBeenCalledWith("plugin_storage_write", {
      pluginId: "org.test.desktop",
      contents: '{"existing":1,"added":2}'
    });
    expect(invoke).toHaveBeenCalledWith("plugin_storage_delete", { pluginId: "org.test.desktop" });
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });
});
