import { invoke } from "@tauri-apps/api/core";

/** Native consent metadata for Plugin Manager. The Worker relay has no access to it. */
export interface AppHandoffConsent {
  pluginId: string;
  /** Revocation-only reference for the operation or conflicting app group. */
  consentId: string;
  appName: string;
  appPath: string;
  pipeline: string | null;
  status: "allowed" | "inactive" | "revoked" | "conflict";
  at: string;
}

export interface AppHandoffConsents {
  list(): Promise<readonly AppHandoffConsent[]>;
  revoke(pluginId: string, consentId: string): Promise<void>;
  clearPlugin(pluginId: string): Promise<void>;
}

export const nativeAppHandoffConsents: AppHandoffConsents = {
  list: () => invoke("app_handoff_consent_list"),
  revoke: (pluginId, consentId) => invoke("app_handoff_consent_revoke", { pluginId, consentId }),
  clearPlugin: pluginId => invoke("app_handoff_consent_clear_plugin", { pluginId })
};
