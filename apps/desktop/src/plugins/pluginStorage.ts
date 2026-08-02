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

  /**
   * Load once, and NEVER reject.
   *
   * The result is memoised, so a rejected promise would be permanent: `if (!loaded)` is false
   * forever, there is no retry, and every later get/set/delete/listKeys would throw for the rest of
   * the session — with no diagnostic, because the failure never reached the handler below. Any
   * failure to see the existing contents therefore degrades this session to in-memory instead,
   * which is the documented contract.
   */
  const ensureLoaded = (): Promise<void> => {
    if (!loaded) {
      loaded = (async () => {
        if (!isDesktopRuntime()) {
          return;
        }
        try {
          // Inside the try on purpose: the dynamic import can fail too (a chunk that will not
          // load), and that is just as much "we cannot see the file" as a read error is.
          const { invoke } = await import("@tauri-apps/api/core");
          const contents = await invoke<string | null>("plugin_storage_read", { pluginId });
          if (!contents) {
            return;
          }
          try {
            const parsed = JSON.parse(contents) as Record<string, unknown>;
            Object.entries(parsed).forEach(([key, value]) => values.set(key, value));
          } catch (error) {
            // Corrupt file: start fresh rather than failing every plugin call, and keep writing
            // enabled because overwriting is the repair. Say so, though — the next save destroys
            // whatever was in there, and that should not happen quietly.
            report("could not be parsed and will be overwritten by the next save", error);
          }
        } catch (error) {
          // Absent is `null` from the Rust side; anything else means the file may exist and hold
          // data we never saw, so a later write could destroy it. Keep this session in memory.
          persistDisabled = true;
          report("could not be read, so changes will not be saved this session", error);
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
        try {
          // The whole body is guarded, not just the invoke. The dynamic import can fail, and
          // JSON.stringify throws on a cyclic value or a BigInt that a plugin stored quite
          // legitimately — and this runs detached from the caller, so anything escaping here is an
          // unhandled rejection: no diagnostic, and no sign that nothing was saved.
          const { invoke } = await import("@tauri-apps/api/core");
          const contents = JSON.stringify(Object.fromEntries(values.entries()));
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
