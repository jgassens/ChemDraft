import type { EngineInstallSnapshot } from "./dialogProtocol";
export const engineInstallFixture = (): EngineInstallSnapshot => ({
  engineName: "Naming", title: "Install Naming Engine", pluginName: "Structure names",
  pluginId: "org.chemdraft.names", disclosure: "Downloads about 100 MB and uses about 0.3 GB once installed. Runs only on this computer.",
  requiredDiskBytes: 1000000000, freeDiskBytes: 16730000000, state: { status: "notInstalled" }, buttons: ["install", "close"]
});
