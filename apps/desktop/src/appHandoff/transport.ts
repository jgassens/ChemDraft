import { invoke } from "@tauri-apps/api/core";
import type { PluginAppHandoffTransport } from "@chemdraft/plugin-host";

export function createTauriAppHandoffTransport(call: typeof invoke = invoke): PluginAppHandoffTransport {
  return async (pluginId, method, request) => {
    try {
      return await call("app_handoff_call", { pluginId, method, request });
    } catch (error) {
      // Rust returns path-free refusals as strings. Keep Tauri infrastructure errors out of the SDK.
      if (typeof error === "string" && error.length) throw new Error(error);
      throw new Error("ChemDraft could not reach the native app handoff endpoint.");
    }
  };
}

export function listenForNativeAppHandoffCommands(target: Window, dispatch: (commandId: string) => void): () => void {
  const eventName = "chemdraft:native-handoff-command";
  const listener = (event: Event) => {
    const payload: unknown = (event as CustomEvent<unknown>).detail;
    if (payload && typeof payload === "object" && Object.hasOwn(payload, "commandId") &&
        Object.keys(payload).length === 1 && "commandId" in payload && typeof payload.commandId === "string") {
      dispatch(payload.commandId);
    }
  };
  // Rust alone decides whether this menu event has a live arming.
  target.addEventListener(eventName, listener);
  return () => target.removeEventListener(eventName, listener);
}
