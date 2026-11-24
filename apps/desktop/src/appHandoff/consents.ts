import { invoke } from "@tauri-apps/api/core";

/** Native consent metadata for Plugin Manager. The Worker relay has no access to it. */
export interface AppHandoffConsent {
  pluginId: string;
  appId: string;
  appName: string;
  appPath: string;
  pipeline: string | null;
  granted: boolean;
  at: string;
}

export interface AppHandoffConsents {
  list(): Promise<readonly AppHandoffConsent[]>;
  revoke(pluginId: string, appId: string): Promise<void>;
  clearPlugin(pluginId: string): Promise<void>;
}

export const nativeAppHandoffConsents: AppHandoffConsents = {
  list: () => invoke("app_handoff_consent_list"),
  revoke: (pluginId, appId) => invoke("app_handoff_consent_revoke", { pluginId, appId }),
  clearPlugin: pluginId => invoke("app_handoff_consent_clear_plugin", { pluginId })
};
