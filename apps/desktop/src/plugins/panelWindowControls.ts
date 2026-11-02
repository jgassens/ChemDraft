import { isDesktopRuntime } from "../window-manager";

/** Native panel controls always target the invoking webview, never a label supplied by JS. */
export async function hideCurrentPanelWindow(): Promise<void> {
  if (!isDesktopRuntime()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("hide_plugin_panel_window");
}
