import { useEffect, useState } from "react";
import type { ShortcutOverrides } from "@chemdraft/shortcut-engine";
import { desktopPreferences } from "./desktopPreferences";
import {
  isSchemeOverrides, KEYBINDING_SCHEME, KEYBINDING_STORAGE_KEY, loadKeybindingSettings,
  saveKeybindingSettings, type KeybindingSettings
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
      const saved = await desktopPreferences();
      // There is one shortcut set, so only the custom keys can differ from the cache.
      if (!disposed && !changed && saved && isSchemeOverrides(saved.shortcutOverrides)) {
        receive({ scheme: KEYBINDING_SCHEME, overrides: saved.shortcutOverrides });
      }
    }).catch(error => console.error("Could not load keyboard shortcuts", error));
    return () => { disposed = true; unlisten?.(); window.removeEventListener("storage", onStorage); };
  }, []);
  return settings;
}

/** Save the user's custom keys for the shortcut set, then tell every window. */
export async function updateShortcutPreference(overrides: ShortcutOverrides): Promise<void> {
  const cache = loadKeybindingSettings();
  const shortcutOverrides = { [KEYBINDING_SCHEME]: overrides };
  const saved = await desktopPreferences({ shortcutOverrides });
  const settings: KeybindingSettings = {
    scheme: KEYBINDING_SCHEME,
    overrides: isSchemeOverrides(saved?.shortcutOverrides) ? saved.shortcutOverrides : { ...cache.overrides, ...shortcutOverrides }
  };
  saveKeybindingSettings(settings);
  await broadcastKeybindingSettings(settings);
}
