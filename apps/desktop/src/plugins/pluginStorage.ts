import type { PluginStorage } from "@chemdraft/plugin-api";
import { isDesktopRuntime } from "../window-manager";

const WRITE_DEBOUNCE_MS = 250;

/**
 * Disk-backed PluginStorage: one JSON file per plugin under
 * app_data_dir/plugins/<pluginId>/storage.json, loaded once into memory and written
 * through with a short debounce. In the browser build it degrades to in-memory behind the
 * same interface, so plugin code never branches on platform.
 */
export function createPersistentPluginStorage(pluginId: string): PluginStorage {
  const values = new Map<string, unknown>();
  let loaded: Promise<void> | undefined;
  let writeTimer: ReturnType<typeof setTimeout> | undefined;

  const ensureLoaded = (): Promise<void> => {
    if (!loaded) {
      loaded = (async () => {
        if (!isDesktopRuntime()) {
          return;
        }
        const { invoke } = await import("@tauri-apps/api/core");
        const contents = await invoke<string | null>("plugin_storage_read", { pluginId }).catch(() => null);
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
    if (!isDesktopRuntime()) {
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
        await invoke("plugin_storage_write", { pluginId, contents });
      })().catch(() => undefined);
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
