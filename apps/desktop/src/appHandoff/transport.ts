import { invoke } from "@tauri-apps/api/core";
import {
  PluginHandoffChooseAppResultSchema, PluginHandoffRunCompanionResultSchema, PluginHandoffSendFileResultSchema, PluginHandoffStatusResultSchema
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

export interface AppHandoffTransportStatus {
  message: string;
  unsuccessful: boolean;
}

function transportStatus(
  method: Parameters<PluginAppHandoffTransport>[1],
  request: Parameters<PluginAppHandoffTransport>[2],
  reply: unknown
): AppHandoffTransportStatus | undefined {
  const problem = (message: string): AppHandoffTransportStatus => ({ message, unsuccessful: true });
  const invalid = () => problem("ChemDraft received an invalid app handoff reply.");
  if (method === "sendFile") {
    const result = PluginHandoffSendFileResultSchema.safeParse(reply);
    if (!result.success) return invalid();
    switch (result.data.status) {
      case "sent": return { message: "Opened the handoff file in the chosen app.", unsuccessful: false };
      case "declined": return problem("App handoff cancelled.");
      case "failed": return problem(`App handoff failed: ${result.data.message}`);
    }
  }
  if (method === "runCompanion") {
    const result = PluginHandoffRunCompanionResultSchema.safeParse(reply);
    if (!result.success) return invalid();
    switch (result.data.status) {
      case "done":
        if (result.data.opened) return { message: "Build completed and opened in the chosen app.", unsuccessful: false };
        if ("openOutput" in request && request.openOutput) return problem("Build completed, but the chosen app could not open it.");
        return { message: "Build completed.", unsuccessful: false };
      case "declined": return problem("Companion build cancelled.");
      case "failed": return problem(`Companion build failed: ${result.data.message}`);
    }
  }
  if (method === "chooseApp") {
    const result = PluginHandoffChooseAppResultSchema.safeParse(reply);
    if (!result.success) return invalid();
    if (result.data.status === "cancelled") return problem("App selection cancelled.");
  }
  // An unavailable app from a status probe can be replaced by the picker.
  if (method === "status" && !PluginHandoffStatusResultSchema.safeParse(reply).success) return invalid();
}

export async function reportAppHandoffTransportResult(
  reply: Promise<unknown>,
  method: Parameters<PluginAppHandoffTransport>[1],
  request: Parameters<PluginAppHandoffTransport>[2],
  report: (status: AppHandoffTransportStatus) => void
): Promise<unknown> {
  const value = await reply.catch((error: unknown) => {
    report({ message: error instanceof Error && error.message ? error.message : endpointUnavailable, unsuccessful: true });
    throw error;
  });
  const status = transportStatus(method, request, value);
  if (status) report(status);
  return value;
}

export function boundedPluginText(value: string, limit: number): string {
  let text = "";
  let count = 0;
  for (const character of value) {
    if (count++ === limit) return text.trim() ? `${text.trim()}…` : "";
    if (/[\t\n\r\v\f\u0085\u2028\u2029]/u.test(character)) {
      if (!text.endsWith(" ")) text += " ";
    }
    else if (!/[\p{Cc}\p{Cf}]/u.test(character)) text += character;
  }
  return text.trim();
}

export function appHandoffCommandStatus(result: unknown, pluginName: string): string | undefined {
  if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true ||
      !("data" in result) || !result.data || typeof result.data !== "object" || !("status" in result.data)) return;
  const { status } = result.data;
  if (typeof status !== "string") return;
  const line = boundedPluginText(status, 500);
  if (!line) return;
  const attribution = boundedPluginText(pluginName, 80);
  return `Plugin (${attribution || "unknown"}): ${line}`;
}
