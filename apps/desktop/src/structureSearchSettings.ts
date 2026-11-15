import { documentWindowId } from "./documentIdentity";
import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { listenTauriEvent } from "./window-manager/tauriEvents";

export const STRUCTURE_SEARCH_DEFAULT_ENABLED = true;
export const STRUCTURE_SEARCH_STORAGE_KEY = "chemdraft.structure-search.enabled.v1";
const SETTINGS_EVENT = "chemdraft://structure-search-settings";

export function loadStructureSearchEnabled(): boolean {
  try {
    const stored = globalThis.localStorage?.getItem(STRUCTURE_SEARCH_STORAGE_KEY);
    if (stored === "true" || stored === "false") return stored === "true";
  } catch { /* Use the shared default when storage is unavailable. */ }
  return STRUCTURE_SEARCH_DEFAULT_ENABLED;
}

export async function saveStructureSearchEnabled(enabled: boolean): Promise<void> {
  try { globalThis.localStorage?.setItem(STRUCTURE_SEARCH_STORAGE_KEY, String(enabled)); }
  catch { /* Persistence is best effort; broadcast the current choice as well. */ }
  if (isTauri()) await emitTo(documentWindowId(), SETTINGS_EVENT, { enabled });
  else globalThis.dispatchEvent?.(new Event(SETTINGS_EVENT));
}

/** Main-window hook: keep the command gate, menus and native preference mirror in step. */
export function useStructureSearchEnabled(): boolean {
  const [enabled, setEnabled] = useState(loadStructureSearchEnabled);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const update = (value: boolean) => {
      if (disposed) return;
      setEnabled(value);
      if (isTauri()) void invoke("set_structure_search_enabled", { enabled: value })
        .catch(error => console.error("Could not sync online structure search preference:", error));
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === STRUCTURE_SEARCH_STORAGE_KEY || event.key === null) update(loadStructureSearchEnabled());
    };
    const onSettings = () => update(loadStructureSearchEnabled());
    globalThis.addEventListener?.("storage", onStorage);
    globalThis.addEventListener?.(SETTINGS_EVENT, onSettings);
    if (isTauri()) void listenTauriEvent<{ enabled: boolean }>(SETTINGS_EVENT, event => {
      if (typeof event.payload?.enabled === "boolean") update(event.payload.enabled);
    }).then(stop => {
      if (disposed) stop(); else { unlisten = stop; update(loadStructureSearchEnabled()); }
    }).catch(error => console.error("Could not observe online structure search preference:", error));
    else update(loadStructureSearchEnabled());
    return () => {
      disposed = true;
      unlisten?.();
      globalThis.removeEventListener?.("storage", onStorage);
      globalThis.removeEventListener?.(SETTINGS_EVENT, onSettings);
    };
  }, []);
  return enabled;
}
