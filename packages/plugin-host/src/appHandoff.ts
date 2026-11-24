import type { PluginAppsAPI } from "@chemdraft/plugin-api";

const OFFICIAL_COMPANION_PLUGINS: ReadonlyMap<string, string> = new Map([
  ["org.chemdraft.handoff.crystalBuilder", "jgassens/ChemDraft-CrystalBuilder-Plugin"]
]);

export interface PluginAppHandoffProvenance {
  source?: "catalog" | "sideload";
  repository?: string;
  checksumVerified?: boolean;
}

/** Host-owned install records for the exact plugin ID and version. A missing record denies access. */
export interface PluginAppHandoffProvenanceProvider {
  /** The record being registered, including a candidate in an active install or update transaction. */
  forRegistration(pluginId: string, version: string): PluginAppHandoffProvenance | undefined;
  /** The current committed install record, reread for each call. */
  forCall(pluginId: string, version: string): PluginAppHandoffProvenance | undefined |
    Promise<PluginAppHandoffProvenance | undefined>;
}

export type PluginAppHandoffMethod = keyof PluginAppsAPI;
export type PluginAppHandoffTransport = (
  pluginId: string,
  method: PluginAppHandoffMethod,
  request: Parameters<PluginAppsAPI[PluginAppHandoffMethod]>[0]
) => Promise<unknown>;

/** Return a path-free refusal suitable for the plugin as well as the install manager. */
export function appHandoffProvenanceError(
  pluginId: string,
  record: PluginAppHandoffProvenance | undefined
): string | undefined {
  const repository = OFFICIAL_COMPANION_PLUGINS.get(pluginId);
  if (!repository) return `Plugin "${pluginId}" is outside the official app handoff catalog.`;
  if (record?.source === "catalog" && record.repository === repository && record.checksumVerified === true) {
    return undefined;
  }
  return `Plugin "${pluginId}" needs a checksum-verified install from its official catalog repository to use app handoff.`;
}
