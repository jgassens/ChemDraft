import { useEffect, useState } from "react";
import type { ShortcutOverrides } from "@chemdraft/shortcut-engine";
import { desktopPreferences } from "./desktopPreferences";
import {
  isKeybindingScheme, isSchemeOverrides, KEYBINDING_STORAGE_KEY, loadKeybindingSettings,
  saveKeybindingSettings, type KeybindingScheme, type KeybindingSettings
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
      if (!disposed && !changed && saved && (isKeybindingScheme(saved.shortcutScheme) || isSchemeOverrides(saved.shortcutOverrides))) {
        const cache = loadKeybindingSettings();
        receive({
          scheme: saved.shortcutScheme ?? cache.scheme,
          overrides: isSchemeOverrides(saved.shortcutOverrides) ? saved.shortcutOverrides : cache.overrides
        });
      }
    }).catch(error => console.error("Could not load keyboard shortcuts", error));
    return () => { disposed = true; unlisten?.(); window.removeEventListener("storage", onStorage); };
  }, []);
  return settings;
}

export async function updateShortcutPreference(scheme: KeybindingScheme, overrides?: ShortcutOverrides): Promise<void> {
  const cache = loadKeybindingSettings();
  const shortcutOverrides = overrides === undefined ? undefined : { [scheme]: overrides };
  const saved = await desktopPreferences(overrides === undefined ? { shortcutScheme: scheme } : { shortcutOverrides });
  const settings = {
    scheme: saved?.shortcutScheme ?? (overrides === undefined ? scheme : cache.scheme),
    overrides: saved?.shortcutOverrides ?? (shortcutOverrides ? { ...cache.overrides, ...shortcutOverrides } : cache.overrides)
  };
  saveKeybindingSettings(settings);
  await broadcastKeybindingSettings(settings);
}
