import type { PluginStorage } from "@chemdraft/plugin-api";
import { isDesktopRuntime } from "../window-manager";

const WRITE_DEBOUNCE_MS = 250;

/** Where a storage failure is reported. Defaults to the console; tests pass their own sink. */
export type PluginStorageDiagnostic = (message: string) => void;

/**
 * Disk-backed PluginStorage: one JSON file per plugin under
 * app_data_dir/plugins/<pluginId>/storage.json, loaded once into memory and written
 * through with a short debounce. In the browser build it degrades to in-memory behind the
 * same interface, so plugin code never branches on platform.
 *
 * Read and write failures are distinguished from ordinary absence and reported. A read that
 * *fails* is not an empty file: flattening the two let the first `set()` persist an empty map over
 * a storage.json that was perfectly fine. After a failed read this degrades to in-memory for the
 * rest of the session rather than overwriting a file it could not see.
 */
export function createPersistentPluginStorage(
  pluginId: string,
  onDiagnostic: PluginStorageDiagnostic = (message) => console.error(message)
): PluginStorage {
  const values = new Map<string, unknown>();
  let loaded: Promise<void> | undefined;
  let writeTimer: ReturnType<typeof setTimeout> | undefined;
  // Set when the existing contents could not be read, so persisting would clobber them.
  let persistDisabled = false;

  const report = (message: string, error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error);
    onDiagnostic(`Plugin storage for "${pluginId}": ${message} (${detail})`);
  };

  const ensureLoaded = (): Promise<void> => {
    if (!loaded) {
      loaded = (async () => {
        if (!isDesktopRuntime()) {
          return;
        }
        const { invoke } = await import("@tauri-apps/api/core");
        let contents: string | null;
        try {
          contents = await invoke<string | null>("plugin_storage_read", { pluginId });
        } catch (error) {
          // Absent is `null` from the Rust side; a rejection means the file may exist and be
          // unreadable. Keep this session in memory so a later write cannot destroy it.
          persistDisabled = true;
          report("could not be read, so changes will not be saved this session", error);
          return;
        }
        if (!contents) {
          return;
        }
        try {
          const parsed = JSON.parse(contents) as Record<string, unknown>;
          Object.entries(parsed).forEach(([key, value]) => values.set(key, value));
        } catch {
          // Corrupt storage file: start fresh rather than failing every plugin call.
        }
      })();
    }
    return loaded;
  };

  const scheduleWrite = (): void => {
    if (!isDesktopRuntime() || persistDisabled) {
      return;
    }
    if (writeTimer !== undefined) {
      clearTimeout(writeTimer);
    }
    writeTimer = setTimeout(() => {
      writeTimer = undefined;
      void (async () => {
        const { invoke } = await import("@tauri-apps/api/core");
        const contents = JSON.stringify(Object.fromEntries(values.entries()));
        try {
          await invoke("plugin_storage_write", { pluginId, contents });
        } catch (error) {
          // The debounce already resolved the caller's `set()`, so this cannot be surfaced as a
          // rejection there — but it must not vanish either. Values stay readable in memory.
          report("could not be saved", error);
        }
      })();
    }, WRITE_DEBOUNCE_MS);
  };

  return {
    async get(key) {
      await ensureLoaded();
      return values.get(key) as never;
    },
    async set(key, value) {
      await ensureLoaded();
      values.set(key, value);
      scheduleWrite();
    },
    async delete(key) {
      await ensureLoaded();
      values.delete(key);
      scheduleWrite();
    },
    async listKeys() {
      await ensureLoaded();
      return [...values.keys()].sort();
    }
  };
}
