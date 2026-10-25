import { describe, expect, it } from "vitest";
import { createPluginRuntime } from "./createPluginRuntime";

describe("createPluginRuntime external tools", () => {
  it("uses the honest unsupported engine outside a Tauri host", async () => {
    const runtime = createPluginRuntime({ getActiveDocument: () => undefined });
    await expect(runtime.externalTools.status({ id: "plugin", name: "Plugin" }, { tool: "claude" })).resolves.toMatchObject({ state: "unsupported" });
  });
});
