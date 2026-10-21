import type { EngineInstallSnapshot } from "./dialogProtocol";
export const engineInstallFixture = (): EngineInstallSnapshot => ({
  engineName: "Naming engine", title: "Naming needs a local engine", pluginName: "Structure names",
  pluginId: "org.chemdraft.names", disclosure: "About 100 MB to download; about 0.3 GB on disk. Runs only on this computer.",
  requiredDiskBytes: 300000000, freeDiskBytes: 1000000000, state: { status: "notInstalled" }, buttons: ["install", "close"]
});
