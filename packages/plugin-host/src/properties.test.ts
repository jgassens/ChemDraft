import { describe, expect, it, vi } from "vitest";
import { PluginHost } from "./index";

const manifest = { id: "org.test.properties", name: "Properties", version: "0", apiVersion: "^0.1.21", entry: "worker.js", permissions: ["chemistry.compute"] };
describe("chemistry.properties host boundary", () => {
  it("gates presence and retained references on chemistry.compute", async () => {
    const computeProperties = vi.fn(async () => ({ available: false as const, reason: "test decline" }));
    const host = new PluginHost({ computeProperties });
    host.registerPlugin({ ...manifest, permissions: [] });
    expect(host.createCommandContext(manifest.id).chemistry).toBeUndefined();
    host.unregisterPlugin(manifest.id); host.registerPlugin(manifest);
    const properties = host.createCommandContext(manifest.id).chemistry!.properties!;
    await expect(properties({ format: "smiles", structure: "C" })).resolves.toMatchObject({ available: false, reason: "test decline" });
    expect(computeProperties).toHaveBeenCalledWith({ format: "smiles", structure: "C" });
    await expect(properties({ format: "smiles", structure: "C".repeat(5001) })).resolves.toEqual({
      available: false, reason: "The structure is 5001 characters, over the 5000 limit."
    });
    expect(computeProperties).toHaveBeenCalledTimes(1);
    host.unregisterPlugin(manifest.id);
    await expect(properties({ format: "smiles", structure: "C" })).rejects.toThrow("not registered");
  });
  it.each([
    [{ format: "smiles", structure: "" }, "The structure must not be empty."],
    [{ format: "smiles", structure: "   " }, "The structure must not be empty."],
    [{ format: "unknown", structure: "C" }, "The format is invalid."],
    [{ format: "smiles", structure: 42 }, "The structure is invalid."]
  ])("explains invalid request fields", async (request, reason) => {
    const host = new PluginHost(); host.registerPlugin(manifest);
    await expect(host.createCommandContext(manifest.id).chemistry!.properties!(request as never))
      .resolves.toEqual({ available: false, reason });
  });
  it("declines absent engines and refuses malformed host results", async () => {
    const host = new PluginHost(); host.registerPlugin(manifest);
    expect(await host.createCommandContext(manifest.id).chemistry!.properties!({ format: "smiles", structure: "C" })).toMatchObject({ available: false });
    const broken = new PluginHost({ computeProperties: vi.fn(async () => ({ available: true })) as never }); broken.registerPlugin(manifest);
    await expect(broken.createCommandContext(manifest.id).chemistry!.properties!({ format: "smiles", structure: "C" })).rejects.toThrow();
  });
});
