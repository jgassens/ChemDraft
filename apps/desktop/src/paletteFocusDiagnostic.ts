import { resolveAgentBridgePermission } from "./agentBridge";

// Resolve once at page/module startup, never from an input event. Early lines
// are deliberately dropped while the native launch gate is still unknown.
let diagnosticsEnabled = false;
export const paletteFocusDiagnosticsReady = resolveAgentBridgePermission().then(({ enabled }) => {
  diagnosticsEnabled = enabled;
}).catch(() => undefined);

let diagnosticsEnabledForTests: boolean | undefined;
const pendingSends = new Set<Promise<void>>();

/** Wait for sends already started by a test without delaying diagnostic callers. */
export async function waitForPaletteFocusDiagnosticsForTests(): Promise<void> {
  await Promise.all(pendingSends);
}

/** Override the cached permission in tests; undefined restores the startup result. */
export function setPaletteFocusDiagnosticsEnabledForTests(enabled: boolean | undefined): void {
  diagnosticsEnabledForTests = enabled;
}

/** Diagnostics never delay a chooser or propagate transport/permission failures. */
export function paletteFocusDiagnostic(line: string): void {
  if (!(diagnosticsEnabledForTests ?? diagnosticsEnabled)) return;
  try {
    const send = import("@tauri-apps/api/core").then(async ({ invoke }) => {
      await invoke("palette_focus_diagnostic", { line: Array.from(line).slice(0, 500).join("") });
    }).catch(() => undefined);
    pendingSends.add(send);
    void send.then(() => pendingSends.delete(send));
  } catch {
    // Diagnostics must not affect input handling, even during page teardown.
  }
}
