import type { PluginStorage } from "@chemdraft/plugin-api";
import { isDesktopRuntime } from "../window-manager";

/** Where a storage failure is reported. Defaults to the console; tests pass their own sink. */
export type PluginStorageDiagnostic = (message: string) => void;

/**
 * Native storage is authoritative across document windows. Every operation reads its latest
 * snapshot; writes mutate one key under the native lock rather than replacing a cached map.
 * Writes are awaited, so closing a document cannot discard a pending debounce. Failed reads
 * degrade to memory for this instance, and failed writes retain local values for its caller.
 */
export function createPersistentPluginStorage(
  pluginId: string,
  onDiagnostic: PluginStorageDiagnostic = (message) => console.error(message)
): PluginStorage {
  let values = new Map<string, unknown>();
  const pending = new Map<string, { deleted: boolean; value?: unknown }>();
  let persistDisabled = false;
  let queue = Promise.resolve();
  const report = (message: string, error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error);
    onDiagnostic(`Plugin storage for "${pluginId}": ${message} (${detail})`);
  };
  // Serialize this instance's reads/writes while Rust serializes mutations across all windows.
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const refresh = async (): Promise<void> => {
    if (!isDesktopRuntime() || persistDisabled) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const contents = await invoke<string | null>("plugin_storage_read", { pluginId });
      let parsed: unknown = {};
      try {
        parsed = contents ? JSON.parse(contents) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a storage object");
      } catch (error) {
        report("could not be parsed and will be repaired by the next save", error);
        parsed = {};
      }
      values = new Map(Object.entries(parsed as Record<string, unknown>));
      for (const [key, entry] of pending) {
        if (entry.deleted) values.delete(key);
        else values.set(key, entry.value);
      }
    } catch (error) {
      persistDisabled = true;
      report("could not be read, so changes will not be saved this session", error);
    }
  };
  const mutate = async (key: string, entry: { deleted: boolean; value?: unknown }): Promise<void> => {
    await refresh();
    if (entry.deleted) values.delete(key);
    else values.set(key, entry.value);
    pending.set(key, entry);
    if (!isDesktopRuntime() || persistDisabled) return;
    try {
      const valueJson = entry.deleted ? null : JSON.stringify(entry.value);
      if (valueJson === undefined) throw new Error("The value cannot be represented as JSON");
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("plugin_storage_mutate", { pluginId, key, valueJson });
      pending.delete(key);
    } catch (error) {
      report("could not be saved", error);
    }
  };
  return {
    get: key => run(async () => { await refresh(); return values.get(key) as never; }),
    set: (key, value) => run(() => mutate(key, { deleted: false, value })),
    delete: key => run(() => mutate(key, { deleted: true })),
    listKeys: () => run(async () => { await refresh(); return [...values.keys()].sort(); })
  };
}
