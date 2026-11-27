import { invoke } from "@tauri-apps/api/core";
import type { AppHandoffMenuInvocation } from "@chemdraft/plugin-host";

type Dispatch = (invocation: AppHandoffMenuInvocation) => Promise<void>;

type InvocationCall = (command: "app_handoff_menu_invocation", args: {
  invocation: AppHandoffMenuInvocation; phase: "begin" | "finish";
}) => Promise<void>;

export type ListenForAppHandoff = (dispatch: Dispatch) => () => void;

/** Install before mounting React or loading plugins. Rust calls the receiver directly on the
 * document window. Page script can call it too, so authenticate before entering the dispatcher. */
export function installNativeAppHandoffReceiver(target: Window, call: InvocationCall = invoke): ListenForAppHandoff {
  let owner: Dispatch | undefined;
  Object.defineProperty(target, "__CHEMDRAFT_NATIVE_HANDOFF__", {
    configurable: false,
    writable: false,
    enumerable: false,
    value: async (payload: Partial<AppHandoffMenuInvocation> | null) => {
      const { pluginId, commandId, nonce } = payload ?? {};
      const dispatch = owner;
      if (!dispatch || typeof pluginId !== "string" || typeof commandId !== "string" ||
          typeof nonce !== "string" || !/^[0-9a-f]{32}$/.test(nonce)) return;
      const invocation = Object.freeze({ pluginId, commandId, nonce });
      try {
        await call("app_handoff_menu_invocation", { invocation, phase: "begin" });
      } catch {
        return; // Forged, expired, superseded, or already dispatched.
      }
      try {
        if (owner === dispatch) await dispatch(invocation);
      } finally {
        await call("app_handoff_menu_invocation", { invocation, phase: "finish" }).catch(() => {
          // Navigation and shutdown also invalidate in Rust. Never log the IPC payload.
          console.warn("Could not confirm completion of the native app handoff.");
        });
      }
    }
  });
  return dispatch => {
    if (owner) throw new Error("The document already has an app handoff relay.");
    owner = dispatch;
    return () => { if (owner === dispatch) owner = undefined; };
  };
}
