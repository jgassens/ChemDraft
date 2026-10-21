import { describe, expect, it, vi } from "vitest";
import { TauriStructureNamingEngine, type StructureNamingInstallProgress } from "./structureNamingEngine";
describe("TauriStructureNamingEngine", () => {
  it("uses the exact six native commands and forwards channel progress", async () => {
    const invoke = vi.fn(async <T>() => undefined as T);
    const channels: { onmessage: (value: StructureNamingInstallProgress) => void }[] = [];
    const engine = new TauriStructureNamingEngine(invoke as ConstructorParameters<typeof TauriStructureNamingEngine>[0], <T>() => {
      const channel = { onmessage: (_message: T) => undefined };
      channels.push(channel as { onmessage: (value: StructureNamingInstallProgress) => void });
      return channel;
    });
    const progress = vi.fn();
    await engine.status();
    await engine.install(progress);
    channels[0]!.onmessage({ phase: "downloadingModel", message: "Downloading centres" });
    expect(progress).toHaveBeenCalledWith({ phase: "downloadingModel", message: "Downloading centres" });
    await engine.cancelInstall();
    await engine.uninstall();
    await engine.name("CCO");
    await engine.cancel();
    expect(invoke.mock.calls).toEqual([
      ["naming_engine_status"], ["naming_engine_install", { onProgress: channels[0] }],
      ["naming_engine_cancel_install"], ["naming_engine_uninstall"], ["name_structure_raw", { smiles: "CCO" }], ["naming_cancel"]
    ]);
  });
});
