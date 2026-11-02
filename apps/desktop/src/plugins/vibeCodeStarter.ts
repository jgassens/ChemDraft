import appConfig from "../../src-tauri/tauri.conf.json";

export const PLUGIN_STARTER_FILENAME = "ChemDraft plugin starter.md";

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
  const appVersion = options.isDesktop
    ? await (await import("@tauri-apps/api/app")).getVersion()
    : appConfig.version;
  const { buildPluginStarterMarkdown } = await import("./pluginStarter");
  const contents = buildPluginStarterMarkdown({ appVersion });
  if (path) await options.writeText(path, contents);
  else options.download(PLUGIN_STARTER_FILENAME, contents, "text/markdown;charset=utf-8");
  return path ? path.split(/[\\/]/).pop() : PLUGIN_STARTER_FILENAME;
}
