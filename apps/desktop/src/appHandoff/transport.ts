import { invoke } from "@tauri-apps/api/core";
import { PluginHandoffRunCompanionResultSchema, PluginHandoffSendFileResultSchema } from "@chemdraft/plugin-api";
import type { PluginAppHandoffTransport } from "@chemdraft/plugin-host";

export function createTauriAppHandoffTransport(
  call: typeof invoke<unknown> = invoke,
  onStatus?: (message: string) => void
): PluginAppHandoffTransport {
  return async (invocation, method, request) => {
    let reply: unknown;
    try {
      reply = await call("app_handoff_call", { invocation, method, request });
    } catch (error) {
      // Rust returns path-free refusals as strings. Keep Tauri infrastructure errors out of the SDK.
      const message = typeof error === "string" && error.length
        ? error : "ChemDraft could not reach the native app handoff endpoint.";
      onStatus?.(message);
      throw new Error(message);
    }
    if (onStatus && method === "sendFile") {
      const result = PluginHandoffSendFileResultSchema.safeParse(reply);
      if (result.success && result.data.status === "sent") onStatus("Opened the handoff file in the chosen app.");
      if (result.success && result.data.status === "failed") onStatus(`App handoff failed: ${result.data.message}`);
    } else if (onStatus && method === "runCompanion") {
      const result = PluginHandoffRunCompanionResultSchema.safeParse(reply);
      if (result.success && result.data.status === "done") {
        onStatus(result.data.opened ? "Build completed and opened in the chosen app." : "Build completed.");
      }
      if (result.success && result.data.status === "failed") onStatus(`Companion build failed: ${result.data.message}`);
    }
    return reply;
  };
}
