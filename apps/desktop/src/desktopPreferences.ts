import { invoke, isTauri } from "@tauri-apps/api/core";
import type { StoredKeybindingScheme, StoredShortcutOverrides } from "./keybindingSettings";

export interface DesktopPreferences {
  /** The shortcut set's id. Older versions may have stored the retired preset's (shortcutDefaultMigration.ts). */
  shortcutScheme?: StoredKeybindingScheme;
  shortcutOverrides?: StoredShortcutOverrides;
  guidedTourSeen?: true;
}

/** The native settings file is shared by the document window and Preferences. */
export function desktopPreferences(patch?: DesktopPreferences): Promise<DesktopPreferences> {
  return isTauri() ? invoke("desktop_preferences", { patch }) : Promise.resolve({});
}
