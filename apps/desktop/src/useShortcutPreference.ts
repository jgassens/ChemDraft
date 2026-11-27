import { useEffect, useState } from "react";
import type { ShortcutOverrides } from "@chemdraft/shortcut-engine";
import { desktopPreferences, type DesktopPreferences } from "./desktopPreferences";
import {
  hasUnsavedShortcuts, isSchemeOverrides, KEYBINDING_SCHEME, KEYBINDING_STORAGE_KEY, loadKeybindingSettings,
  saveKeybindingSettings, setUnsavedShortcuts, type KeybindingSettings
} from "./keybindingSettings";
import { broadcastKeybindingSettings, listenForKeybindingSettings } from "./window-manager";

export function useShortcutPreference(): KeybindingSettings {
  const [settings, setSettings] = useState(loadKeybindingSettings);
  useEffect(() => {
    let disposed = false;
    let changed = false;
    let unlisten: (() => void) | undefined;
    const receive = (next: KeybindingSettings) => {
      changed = true;
      saveKeybindingSettings(next);
      setSettings(next);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === KEYBINDING_STORAGE_KEY) {
        changed = true;
        setSettings(loadKeybindingSettings());
      }
    };
    window.addEventListener("storage", onStorage);
    void listenForKeybindingSettings(receive).then(async stop => {
      if (disposed) { stop(); return; }
      unlisten = stop;
      if (changed) return;
      const saved = await nativeShortcutSettings();
      // There is one shortcut set, so only the custom keys can differ from the cache.
      if (!disposed && !changed && saved) receive(saved);
    }).catch(error => console.error("Could not load keyboard shortcuts", error));
    return () => { disposed = true; unlisten?.(); window.removeEventListener("storage", onStorage); };
  }, []);
  return settings;
}

/**
 * The custom keys the native preferences file holds, to replace this window's cache with; undefined
 * to keep the cache. While the cache holds custom keys the native file has not saved
 * (keybindingSettings.ts `hasUnsavedShortcuts`: the move to the single set could not write them), the
 * cache's are written to the native file first, so the file's older copy never drops them. If that
 * write fails too, the cache stays as it is and a later window or launch tries again.
 */
async function nativeShortcutSettings(): Promise<KeybindingSettings | undefined> {
  let saved: DesktopPreferences | undefined;
  if (hasUnsavedShortcuts()) {
    const pending = loadKeybindingSettings().overrides?.[KEYBINDING_SCHEME] ?? {};
    try {
      saved = await desktopPreferences({ shortcutOverrides: { [KEYBINDING_SCHEME]: pending } });
    } catch (error) {
      console.error("Could not save keyboard shortcuts", error);
      return undefined;
    }
    setUnsavedShortcuts(false);
  } else {
    saved = await desktopPreferences();
  }
  return saved && isSchemeOverrides(saved.shortcutOverrides)
    ? { scheme: KEYBINDING_SCHEME, overrides: saved.shortcutOverrides }
    : undefined;
}

/**
 * Save the user's custom keys for the shortcut set, then tell every window. `overrides` is the set's
 * whole map, so once the native file has it nothing in the cache is left unsaved.
 */
export async function updateShortcutPreference(overrides: ShortcutOverrides): Promise<void> {
  const cache = loadKeybindingSettings();
  const shortcutOverrides = { [KEYBINDING_SCHEME]: overrides };
  const saved = await desktopPreferences({ shortcutOverrides });
  const settings: KeybindingSettings = {
    scheme: KEYBINDING_SCHEME,
    overrides: isSchemeOverrides(saved?.shortcutOverrides) ? saved.shortcutOverrides : { ...cache.overrides, ...shortcutOverrides }
  };
  saveKeybindingSettings(settings);
  setUnsavedShortcuts(false);
  await broadcastKeybindingSettings(settings);
}
