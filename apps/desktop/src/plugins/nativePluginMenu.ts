import type { PluginAppMenuItem } from "../appMenu";
import { isDesktopRuntime } from "../window-manager";

/** One plugin menu item shaped for the Rust native-menu bridge (ADR-0016). */
export interface NativePluginMenuItem {
  /** The `plugin.*` command id — the native menu routes clicks back by this prefix. */
  id: string;
  label: string;
  enabled: boolean;
}

/**
 * The plugin items the native Analyze menu should show: every plugin-contributed command in the
 * `analyze` location, as `{ id: commandId, label, enabled }`. Pure so it is unit-testable without a
 * Tauri runtime.
 */
export function pluginAnalyzeItemsForNativeMenu(
  items: readonly PluginAppMenuItem[]
): NativePluginMenuItem[] {
  return items
    .filter((item) => item.location === "analyze")
    .map((item) => ({
      id: item.command.commandId,
      label: item.command.label,
      enabled: item.command.enabled
    }));
}

/**
 * Push the plugin Analyze items into the native macOS menu (desktop only). A no-op on the web build,
 * where the in-window menu bar already renders them. Failures are swallowed — the native menu is a
 * convenience and must never break the app if the bridge command is unavailable.
 */
export async function syncPluginNativeMenuItems(items: readonly PluginAppMenuItem[]): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("sync_plugin_menu_items", { items: pluginAnalyzeItemsForNativeMenu(items) });
  } catch (error) {
    console.warn("Could not sync plugin menu items into the native menu:", error);
  }
}
