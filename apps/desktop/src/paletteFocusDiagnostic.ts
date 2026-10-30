import { resolveAgentBridgePermission } from "./agentBridge";

/** Diagnostics never delay a chooser or propagate transport/permission failures. */
export function paletteFocusDiagnostic(line: string): void {
  try {
    void resolveAgentBridgePermission().then(async ({ enabled }) => {
      if (!enabled) return;
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("palette_focus_diagnostic", { line: Array.from(line).slice(0, 500).join("") });
    }).catch(() => undefined);
  } catch {
    // Diagnostics must not affect input handling, even during page teardown.
  }
}
