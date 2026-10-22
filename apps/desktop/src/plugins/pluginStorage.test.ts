import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
import { createPersistentPluginStorage } from "./pluginStorage";
const tauriGlobal = globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown };

describe("createPersistentPluginStorage", () => {
  let disk: Record<string, unknown>;
  beforeEach(() => {
    disk = {};
    invoke.mockReset();
    tauriGlobal.__TAURI_INTERNALS__ = {};
    invoke.mockImplementation(async (command: string, args: { key: string; valueJson: string | null }) => {
      if (command === "plugin_storage_read") return JSON.stringify(disk);
      if (command === "plugin_storage_mutate") {
        if (args.valueJson === null) delete disk[args.key];
        else disk[args.key] = JSON.parse(args.valueJson);
        return;
      }
      throw new Error(`Unexpected command: ${command}`);
    });
  });
  afterEach(() => { delete tauriGlobal.__TAURI_INTERNALS__; });
  const mutations = () => invoke.mock.calls.filter(([command]) => command === "plugin_storage_mutate");

  it("preserves unrelated keys when two document windows write from previously read state", async () => {
    disk = { existing: 1 };
    const first = createPersistentPluginStorage("org.test.plugin");
    const second = createPersistentPluginStorage("org.test.plugin");
    await Promise.all([first.get("existing"), second.get("existing")]);
    await Promise.all([first.set("first", 2), second.set("second", 3)]);
    expect(disk).toEqual({ existing: 1, first: 2, second: 3 });
    expect(await first.get("second")).toBe(3);
    expect(await second.listKeys()).toEqual(["existing", "first", "second"]);
    expect(invoke.mock.calls.some(([command]) => command === "plugin_storage_write")).toBe(false);
  });

  it("deletes only the selected key and distinguishes null from deletion", async () => {
    disk = { keep: 1, remove: 2 };
    const first = createPersistentPluginStorage("org.test.plugin");
    const second = createPersistentPluginStorage("org.test.plugin");
    await first.set("nullable", null);
    await second.delete("remove");
    expect(disk).toEqual({ keep: 1, nullable: null });
    expect(await first.listKeys()).toEqual(["keep", "nullable"]);
  });

  it("awaits native persistence before resolving set, without a pending debounce", async () => {
    let complete!: () => void;
    const written = new Promise<void>(resolve => { complete = resolve; });
    invoke.mockImplementation((command: string) => command === "plugin_storage_read" ? Promise.resolve(null) : written);
    const storage = createPersistentPluginStorage("org.test.plugin");
    let settled = false;
    const saving = storage.set("key", 1).then(() => { settled = true; });
    await vi.waitFor(() => expect(mutations()).toHaveLength(1));
    expect(settled).toBe(false);
    complete();
    await saving;
    expect(settled).toBe(true);
  });

  it("does not write after a failed read and keeps working in memory", async () => {
    const diagnostics: string[] = [];
    invoke.mockRejectedValue(new Error("permission denied"));
    const storage = createPersistentPluginStorage("org.test.plugin", message => diagnostics.push(message));
    await storage.set("keep", "me");
    expect(await storage.get("keep")).toBe("me");
    expect(mutations()).toHaveLength(0);
    expect(diagnostics.join(" ")).toContain("will not be saved this session");
    await storage.delete("keep");
    expect(await storage.listKeys()).toEqual([]);
  });

  it("reports a failed mutation and overlays its unsaved value on fresh reads", async () => {
    const diagnostics: string[] = [];
    invoke.mockImplementation((command: string) => command === "plugin_storage_read"
      ? Promise.resolve('{"remote":2}') : Promise.reject(new Error("disk full")));
    const storage = createPersistentPluginStorage("org.test.plugin", message => diagnostics.push(message));
    await storage.set("local", 1);
    expect(await storage.get("local")).toBe(1);
    expect(await storage.listKeys()).toEqual(["local", "remote"]);
    expect(diagnostics.join(" ")).toContain("disk full");
  });

  it("reports unrepresentable values and preserves them locally without invoking mutation", async () => {
    const diagnostics: string[] = [];
    const storage = createPersistentPluginStorage("org.test.plugin", message => diagnostics.push(message));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await storage.set("cyclic", cyclic);
    expect(await storage.get("cyclic")).toBe(cyclic);
    expect(mutations()).toHaveLength(0);
    expect(diagnostics.join(" ")).toContain("could not be saved");
  });

  it("reports corrupt storage before allowing the native key operation to repair it", async () => {
    const diagnostics: string[] = [];
    invoke.mockImplementation(async (command: string) => command === "plugin_storage_read" ? "{bad json" : undefined);
    const storage = createPersistentPluginStorage("org.test.plugin", message => diagnostics.push(message));
    await storage.set("fresh", true);
    expect(mutations()).toHaveLength(1);
    expect(diagnostics.join(" ")).toContain("could not be parsed");
  });

  it("keeps browser storage in memory", async () => {
    delete tauriGlobal.__TAURI_INTERNALS__;
    const storage = createPersistentPluginStorage("org.test.plugin");
    await storage.set("key", 1);
    expect(await storage.get("key")).toBe(1);
    await storage.delete("key");
    expect(await storage.listKeys()).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });
});
