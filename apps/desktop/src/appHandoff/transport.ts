import { invoke } from "@tauri-apps/api/core";
import {
  boundedHandoffText, PluginHandoffChooseAppResultSchema, PluginHandoffRunCompanionResultSchema, PluginHandoffSendFileResultSchema, PluginHandoffStatusResultSchema
} from "@chemdraft/plugin-api";
import type { PluginAppHandoffTransport } from "@chemdraft/plugin-host";

const endpointUnavailable = "ChemDraft could not reach the native app handoff endpoint.";

export function createTauriAppHandoffTransport(
  call: typeof invoke<unknown> = invoke
): PluginAppHandoffTransport {
  return async (invocation, method, request) => {
    try {
      return await call("app_handoff_call", { invocation, method, request });
    } catch (error) {
      // Rust returns path-free refusals as strings. Keep Tauri infrastructure errors out of the SDK.
      throw new Error(typeof error === "string" && error.length ? error : endpointUnavailable);
    }
  };
}

export type AppHandoffTransportStatus =
  | { kind: "success"; message?: string }
  | { kind: "refused" | "cancelled" | "open-failed"; message: string };

export function appHandoffResultStatus(
  method: Parameters<PluginAppHandoffTransport>[1],
  request: Parameters<PluginAppHandoffTransport>[2],
  reply: unknown
): AppHandoffTransportStatus | undefined {
  const problem = (message: string): AppHandoffTransportStatus => ({ kind: "refused", message });
  const invalid = () => problem("ChemDraft received an invalid app handoff reply.");
  if (method === "sendFile") {
    const result = PluginHandoffSendFileResultSchema.safeParse(reply);
    if (!result.success) return invalid();
    switch (result.data.status) {
      case "sent": return { kind: "success", message: "Opened the handoff file in the chosen app." };
      case "declined": return { kind: "cancelled", message: "App handoff cancelled." };
      case "failed": return problem(`App handoff failed: ${boundedHandoffText(result.data.message)}`);
    }
  }
  if (method === "runCompanion") {
    const result = PluginHandoffRunCompanionResultSchema.safeParse(reply);
    if (!result.success) return invalid();
    switch (result.data.status) {
      case "done":
        if (result.data.opened) return { kind: "success", message: "Build completed and opened in the chosen app." };
        if ("openOutput" in request && request.openOutput) {
          return { kind: "open-failed", message: "Build completed, but the chosen app could not open it." };
        }
        return { kind: "success", message: "Build completed." };
      case "declined": return { kind: "cancelled", message: "Companion build cancelled." };
      case "failed": return problem(`Companion build failed: ${boundedHandoffText(result.data.message)}`);
    }
  }
  if (method === "chooseApp") {
    const result = PluginHandoffChooseAppResultSchema.safeParse(reply);
    if (!result.success) return invalid();
    // The picker does not spend the submission, so a later successful pick can clear this.
    if (result.data.status === "cancelled") return problem("App selection cancelled.");
    return { kind: "success" };
  }
  // An unavailable app from a status probe can be replaced by the picker.
  const result = PluginHandoffStatusResultSchema.safeParse(reply);
  if (!result.success) return invalid();
  if (result.data.available) return { kind: "success" };
}

export function appHandoffRefusal(error: unknown): AppHandoffTransportStatus {
  return { kind: "refused", message: (error instanceof Error && boundedHandoffText(error.message)) || endpointUnavailable };
}

export function attributedHandoffText(value: unknown, pluginName: string): string | undefined {
  if (typeof value !== "string") return;
  const line = boundedHandoffText(value);
  if (!line) return;
  const name = boundedHandoffText(pluginName, 80, false);
  return `Plugin (${name || "Unknown"}): ${line}`;
}

export function appHandoffCommandStatus(result: unknown, pluginName: string): string | undefined {
  if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true ||
      !("data" in result) || !result.data || typeof result.data !== "object" || !("status" in result.data)) return;
  return attributedHandoffText(result.data.status, pluginName);
}
