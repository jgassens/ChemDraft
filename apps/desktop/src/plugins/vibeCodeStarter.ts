import appConfig from "../../src-tauri/tauri.conf.json";
import type { ThisComputer } from "./pluginStarter";
import { INSTALLED_PLUGINS_DIR } from "./installedPluginPaths";

export const PLUGIN_STARTER_FILENAME = "ChemDraft plugin starter.md";

export async function gatherThisComputer(): Promise<ThisComputer & { appVersion: string }> {
  const [{ getVersion }, { appDataDir, join }, { invoke }] = await Promise.all([
    import("@tauri-apps/api/app"), import("@tauri-apps/api/path"), import("@tauri-apps/api/core")
  ]);
  const [appVersion, appData, native] = await Promise.all([
    getVersion(), appDataDir(), invoke<Omit<ThisComputer, "appDataDir" | "installedPluginsDir">>("plugin_starter_computer")
  ]);
  return { ...native, appVersion, appDataDir: appData, installedPluginsDir: await join(appData, INSTALLED_PLUGINS_DIR) };
}

/** The document window supplies its existing export picker, writer and browser download helpers. */
export interface VibeCodeStarterSaveOptions {
  isDesktop: boolean;
  pickSavePath: (defaultPath: string, formatLabel: string, extensions: readonly string[]) => Promise<string | undefined>;
  writeText: (path: string, contents: string) => Promise<void>;
  download: (filename: string, contents: string, mimeType: string) => void;
}

export async function saveVibeCodeStarter(options: VibeCodeStarterSaveOptions): Promise<string | undefined> {
  let path: string | undefined;
  if (options.isDesktop) {
    const { documentDir, join } = await import("@tauri-apps/api/path");
    path = await options.pickSavePath(
      await join(await documentDir(), PLUGIN_STARTER_FILENAME), "ChemDraft plugin starter", ["md"]
    );
    if (!path) return;
  }
  const thisComputer = options.isDesktop ? await gatherThisComputer() : undefined;
  const appVersion = thisComputer?.appVersion ?? appConfig.version;
  const { buildPluginStarterMarkdown } = await import("./pluginStarter");
  const contents = buildPluginStarterMarkdown({ appVersion, thisComputer });
  if (path) await options.writeText(path, contents);
  else options.download(PLUGIN_STARTER_FILENAME, contents, "text/markdown;charset=utf-8");
  return path ? path.split(/[\\/]/).pop() : PLUGIN_STARTER_FILENAME;
}
