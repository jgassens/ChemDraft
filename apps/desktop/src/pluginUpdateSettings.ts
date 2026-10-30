import { isDesktopRuntime } from "./window-manager";
import { listenTauriEvent } from "./window-manager/tauriEvents";

export const PLUGIN_UPDATE_SETTINGS_KEY = "chemdraft.pluginUpdates.automatic.v1";
const CHANGE_EVENT = "chemdraft://plugin-update-settings";

export function loadAutomaticPluginUpdates(): boolean {
  try { return globalThis.localStorage?.getItem(PLUGIN_UPDATE_SETTINGS_KEY) !== "false"; }
  catch { return true; }
}

export function saveAutomaticPluginUpdates(enabled: boolean): void {
  try { globalThis.localStorage?.setItem(PLUGIN_UPDATE_SETTINGS_KEY, String(enabled)); }
  catch { /* Persistence is best effort, as for other preferences. */ }
}

export async function broadcastPluginUpdateSettings(enabled: boolean): Promise<void> {
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: enabled }));
  if (isDesktopRuntime()) {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(CHANGE_EVENT, enabled);
  }
}

export async function listenForPluginUpdateSettings(handler: (enabled: boolean) => void): Promise<() => void> {
  const listener = (event: Event) => {
    const value: unknown = (event as CustomEvent).detail;
    if (typeof value === "boolean") handler(value);
  };
  window.addEventListener(CHANGE_EVENT, listener);
  const stopDom = () => window.removeEventListener(CHANGE_EVENT, listener);
  if (!isDesktopRuntime()) return stopDom;
  try {
    const stopNative = await listenTauriEvent<boolean>(CHANGE_EVENT, event => {
      if (typeof event.payload === "boolean") handler(event.payload);
    });
    return () => { stopDom(); stopNative(); };
  } catch (error) {
    stopDom();
    throw error;
  }
}
