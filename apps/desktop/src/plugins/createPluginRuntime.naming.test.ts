import type { PluginCommandContext, PluginPermission } from "@chemdraft/plugin-api";
import { describe, expect, it, vi } from "vitest";
import { createPhase4Document } from "../documentWorkflow";
import { createPluginRuntime } from "./createPluginRuntime";
import { fakeNamingEngine, namingManifest, namingMolecule } from "./structureNamingTestFixtures";

function setup() {
  const document = createPhase4Document();
  document.pages[0]!.objects = [namingMolecule];
  const engine = fakeNamingEngine();
  const runtime = createPluginRuntime({ getActiveDocument: () => document,
    getSelection: () => ({ objectIds: ["m1"], molecules: [] }), structureNamingEngine: engine,
    namingCanonicalizer: { canonicalize: async () => "CCO", version: "loaded" } });
  return { runtime, document, engine };
}
describe("desktop structureToName", () => {
  it.each(["chemistry.compute", "native.execute", "selection.read"] satisfies PluginPermission[])("absent without %s", permission => {
    const { runtime } = setup();
    runtime.registerPlugin({ ...namingManifest, permissions: namingManifest.permissions.filter(value => value !== permission) });
    expect(runtime.host.createCommandContext(namingManifest.id).chemistry?.structureToName).toBeUndefined();
  });
  it("absent on web hosts even when all permissions are held", () => {
    const runtime = createPluginRuntime({ getActiveDocument: () => undefined });
    runtime.registerPlugin(namingManifest);
    expect(runtime.host.createCommandContext(namingManifest.id).chemistry?.structureToName).toBeUndefined();
  });
  it("serves only its own invocation and rejects saved contexts after it ends", async () => {
    const { runtime } = setup();
    let saved!: PluginCommandContext;
    runtime.registerPlugin(namingManifest, { commandHandlers: { "plugin.namingTest.run": async context => {
      saved = context;
      return context.chemistry!.structureToName!({ objectId: "m1" });
    } } });
    expect(await runtime.invokeCommand("plugin.namingTest.run")).toMatchObject({ status: "named", name: "ethanol" });
    await expect(saved.chemistry!.structureToName!({ objectId: "m1" })).rejects.toThrow(/invocation/);
    await expect(runtime.host.createCommandContext(namingManifest.id).chemistry!.structureToName!({ objectId: "m1" })).rejects.toThrow(/invocation/);
  });
  it("refuses an out-of-scope object before engine access", async () => {
    const { runtime, document, engine } = setup();
    document.pages[0]!.objects.push({ ...namingMolecule, id: "m2" });
    runtime.registerPlugin(namingManifest, { commandHandlers: { "plugin.namingTest.run": context => context.chemistry!.structureToName!({ objectId: "m2" }) } });
    await expect(runtime.invokeCommand("plugin.namingTest.run")).rejects.toThrow(/current selection/);
    expect(engine.status).not.toHaveBeenCalled();
  });
  it("abandoned invocation cancels the engine and returns cancelled", async () => {
    const { runtime, engine } = setup();
    vi.mocked(engine.name).mockImplementation(() => new Promise(() => undefined));
    let naming!: ReturnType<NonNullable<NonNullable<PluginCommandContext["chemistry"]>["structureToName"]>>;
    runtime.registerPlugin(namingManifest, { commandHandlers: { "plugin.namingTest.run": async context => {
      naming = context.chemistry!.structureToName!({ objectId: "m1" });
      await vi.waitFor(() => expect(engine.name).toHaveBeenCalled());
    } } });
    await runtime.invokeCommand("plugin.namingTest.run");
    expect(await naming).toEqual({ status: "cancelled" });
    expect(engine.cancel).toHaveBeenCalledOnce();
  });
});
