import { describe, expect, it, vi } from "vitest";
import { parsePluginManifest, type PluginChemistryAPI, type PluginEmbed3DResult } from "@chemdraft/plugin-api";
import { PluginHost } from "./index";

const command = "plugin.test.threeD";
const manifest = (enabled: boolean) => parsePluginManifest({ id: "org.test.threeD", name: "3D", version: "0", apiVersion: "^0.1.15", entry: "test",
  permissions: enabled ? ["chemistry.compute"] : [], contributes: { commands: [{ id: command, title: "3D" }] } });
const input = { components: [{ smiles: "C" }] };
const embedded: PluginEmbed3DResult = {
  model: { atoms: [{ element: "C", charge: 0, component: 0, addedHydrogen: false }], bonds: [], coords: [0, 0, 0],
    components: [{ smiles: "C", atomStart: 0, atomCount: 1 }], modelToken: "test" },
  method: { engine: "RDKit MinimalLib Release_2026_03_3 + patches 0001-0008", embedding: "ETKDGv3", seed: 42,
    forceField: "none", interfragment: false, coordinateUnits: "Angstrom", energyUnits: "kcal/mol", conventions: ["test"] },
  warnings: []
};

describe("host 3D chemistry result validation", () => {
  const results = {
    embed3d: embedded,
    minimize3d: { ...embedded, clash: false,
      forceField: { name: "mmff94s", status: "converged", energy: 1, iterationsBudget: 1000 } },
    flatten3d: { objects: [], depthByAtom: [], method: embedded.method, warnings: [] }
  };
  const requests = { embed3d: input, minimize3d: { model: embedded.model, interfragment: false },
    flatten3d: { model: embedded.model, view: "auto" } };
  const cases = (["embed3d", "minimize3d", "flatten3d"] as const).flatMap(method =>
    Object.keys(results[method]).map(field => ({ method, field })));
  it.each(cases)("rejects $method missing $field with a specific error", async ({ method, field }) => {
    const malformed: Record<string, unknown> = { ...results[method] };
    delete malformed[field];
    const host = new PluginHost({ [method]: async () => malformed });
    host.registerPlugin(manifest(true), { commandHandlers: { [command]: ctx => ctx.chemistry![method]!(requests[method] as never) } });
    await expect(host.invokeCommand(command)).rejects.toThrow(`chemistry.${method} returned an invalid result at ${field}:`);
  });
  it.each([
    { method: "embed3d" as const, field: "model.coords", value: { ...embedded, model: { ...embedded.model, coords: [NaN, 0, 0] } } },
    { method: "minimize3d" as const, field: "forceField", value: embedded },
    { method: "minimize3d" as const, field: "clash", value: { ...results.minimize3d, clash: "false" } },
    { method: "flatten3d" as const, field: "objects", value: results.minimize3d },
    { method: "flatten3d" as const, field: "objects", value: { ...results.flatten3d, objects: {} } },
    { method: "flatten3d" as const, field: "depthByAtom", value: { ...results.flatten3d, depthByAtom: [[Infinity]] } },
    { method: "flatten3d" as const, field: "warnings", value: { ...results.flatten3d, warnings: "warning" } }
  ])("rejects malformed $method $field, including the previous method's result", async ({ method, field, value }) => {
    const host = new PluginHost({ [method]: async () => value });
    host.registerPlugin(manifest(true), { commandHandlers: { [command]: ctx => ctx.chemistry![method]!(requests[method] as never) } });
    await expect(host.invokeCommand(command)).rejects.toThrow(`chemistry.${method} returned an invalid result at ${field}`);
  });
});

describe("host 3D chemistry command gate", () => {
  it("is absent without chemistry.compute, present with that permission alone", () => {
    for (const enabled of [true, false]) {
      const host = new PluginHost();
      host.registerPlugin(manifest(enabled));
      const chemistry = host.createCommandContext("org.test.threeD").chemistry;
      if (!enabled) expect(chemistry).toBeUndefined();
      else for (const method of ["embed3d", "minimize3d", "flatten3d"] as const) expect(chemistry?.[method]).toBeTypeOf("function");
    }
  });
  it("refuses calls outside its own invocation, including retained references during another command", async () => {
    const host = new PluginHost();
    let retained!: PluginChemistryAPI;
    host.registerPlugin(manifest(true), { commandHandlers: { [command]: ctx => { retained = ctx.chemistry!; } } });
    await host.invokeCommand(command);
    for (const chemistry of [retained, host.createCommandContext("org.test.threeD").chemistry!]) {
      await expect(chemistry.embed3d!(input)).rejects.toThrow("may call chemistry.embed3d only while one of its own commands is executing.");
      await expect(chemistry.minimize3d!({} as never)).rejects.toThrow("may call chemistry.minimize3d only while one of its own commands is executing.");
      await expect(chemistry.flatten3d!({} as never)).rejects.toThrow("may call chemistry.flatten3d only while one of its own commands is executing.");
    }
    host.registerPlugin({ ...manifest(true), id: "org.test.other", contributes: { commands: [{ id: "plugin.other.run", title: "Other" }] } },
      { commandHandlers: { "plugin.other.run": () => retained.embed3d!(input) } });
    await expect(host.invokeCommand("plugin.other.run")).rejects.toThrow("only while one of its own commands is executing");
  });
  it("passes an abort signal to the provider and cancels outstanding work at command end", async () => {
    let signal!: AbortSignal;
    let pending!: Promise<unknown>;
    const embed3d = vi.fn((_request, stop: AbortSignal) => { signal = stop; return new Promise<PluginEmbed3DResult>(() => undefined); });
    const host = new PluginHost({ embed3d });
    host.registerPlugin(manifest(true), { commandHandlers: { [command]: ctx => {
      pending = ctx.chemistry!.embed3d!(input);
      // Attach immediately; the invocation deliberately does not await the operation.
      void pending.catch(() => undefined);
    } } });
    await host.invokeCommand(command);
    expect(signal.aborted).toBe(true);
    await expect(pending).rejects.toThrow("chemistry.embed3d cancelled because the plugin command ended.");
  });
  it("aborts work when a plugin unregisters", async () => {
    let signal!: AbortSignal;
    const host = new PluginHost({ embed3d: (_request, stop) => { signal = stop; return new Promise(() => undefined); } });
    host.registerPlugin(manifest(true), { commandHandlers: { [command]: ctx => ctx.chemistry!.embed3d!(input) } });
    const running = host.invokeCommand(command);
    const assertion = expect(running).rejects.toThrow("cancelled because the plugin command ended");
    await vi.waitFor(() => expect(signal).toBeDefined());
    host.unregisterPlugin("org.test.threeD");
    await assertion;
    expect(signal.aborted).toBe(true);
  });
  it("ignores a cancelled provider's late completion after a new call enters the same plugin queue", async () => {
    const completions: ((value: PluginEmbed3DResult) => void)[] = [];
    const host = new PluginHost({ embed3d: () => new Promise(resolve => completions.push(resolve)) });
    const register = () => host.registerPlugin(manifest(true), {
      commandHandlers: { [command]: ctx => ctx.chemistry!.embed3d!(input) }
    });
    register();
    const first = host.invokeCommand(command);
    const cancelled = expect(first).rejects.toThrow("cancelled because the plugin command ended");
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    host.unregisterPlugin("org.test.threeD");
    await cancelled;
    register();
    const second = host.invokeCommand(command);
    await vi.waitFor(() => expect(completions).toHaveLength(2));
    completions[0]({ ...embedded, warnings: ["cancelled result"] });
    const current = { ...embedded, warnings: ["current result"] };
    completions[1](current);
    await expect(second).resolves.toEqual(current);
  });
  it("admits one of 20 concurrent calls, queues eight, and specifically refuses the other eleven", async () => {
    let active = 0;
    let peak = 0;
    const completions: (() => void)[] = [];
    const host = new PluginHost({ embed3d: () => {
      peak = Math.max(peak, ++active);
      return new Promise<PluginEmbed3DResult>(resolve => completions.push(() => {
        active--; resolve(embedded);
      }));
    } });
    let results!: PromiseSettledResult<PluginEmbed3DResult>[];
    host.registerPlugin(manifest(true), { commandHandlers: { [command]: async ctx => {
      results = await Promise.allSettled(Array.from({ length: 20 }, () => ctx.chemistry!.embed3d!(input)));
    } } });
    const running = host.invokeCommand(command);
    for (let i = 0; i < 9; i++) {
      await vi.waitFor(() => expect(completions).toHaveLength(i + 1));
      completions[i]();
    }
    await running;
    expect(peak).toBe(1);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(9);
    const refused = results.filter(result => result.status === "rejected");
    expect(refused).toHaveLength(11);
    for (const result of refused) expect(result.reason.message).toBe('Plugin "org.test.threeD" 3D chemistry is busy: at most 1 running call and 8 queued calls are allowed.');
  });
  it.each(["command end", "unregister"])("cancels the running call and all eight queued calls on %s", async end => {
    let release!: () => void;
    let settled!: Promise<PromiseSettledResult<PluginEmbed3DResult>[]>;
    const signals: AbortSignal[] = [];
    const embed3d = vi.fn((_request, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<PluginEmbed3DResult>(() => undefined);
    });
    const host = new PluginHost({ embed3d });
    host.registerPlugin(manifest(true), { commandHandlers: { [command]: async ctx => {
      settled = Promise.allSettled(Array.from({ length: 9 }, () => ctx.chemistry!.embed3d!(input)));
      await new Promise<void>(resolve => { release = resolve; });
    } } });
    const running = host.invokeCommand(command);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    if (end === "unregister") host.unregisterPlugin("org.test.threeD");
    release();
    await running;
    expect(embed3d).toHaveBeenCalledOnce();
    expect(signals[0].aborted).toBe(true);
    for (const result of await settled) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason.message).toBe("chemistry.embed3d cancelled because the plugin command ended.");
    }
  });
  it("counts plugin queue time in the flatten deadline", async () => {
    vi.useFakeTimers();
    try {
      let resolveFirst!: (value: never) => void;
      const flatten3d = vi.fn(() => new Promise<never>(resolve => { resolveFirst = resolve; }));
      const host = new PluginHost({ flatten3d });
      const model = { atoms: [{ element: "C", charge: 0, component: 0, addedHydrogen: false }], bonds: [], coords: [0, 0, 0],
        components: [{ smiles: "C", atomStart: 0, atomCount: 1 }], modelToken: "test" };
      let results!: PromiseSettledResult<unknown>[];
      host.registerPlugin(manifest(true), { commandHandlers: { [command]: async ctx => {
        results = await Promise.allSettled([0, 1].map(() => ctx.chemistry!.flatten3d!({ model, view: "auto" })));
      } } });
      const running = host.invokeCommand(command);
      await vi.advanceTimersByTimeAsync(4999);
      expect(flatten3d).toHaveBeenCalledOnce();
      resolveFirst({ objects: [], depthByAtom: [], method: embedded.method, warnings: [] } as never);
      await vi.advanceTimersByTimeAsync(0);
      expect(flatten3d).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await running;
      expect(results[0].status).toBe("fulfilled");
      expect(results[1]).toMatchObject({ status: "rejected", reason: new Error("flatten3d timed out after 5 seconds including queue time.") });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it.each([false, true])("uses the total multi-component embed budget across the plugin queue (expires=%s)", async expires => {
    vi.useFakeTimers();
    try {
      const completions: ((value: PluginEmbed3DResult) => void)[] = [];
      const embed3d = vi.fn(() => new Promise<PluginEmbed3DResult>(resolve => completions.push(resolve)));
      const host = new PluginHost({ embed3d });
      const two = { components: [{ smiles: "C" }, { smiles: "O" }] };
      let results!: PromiseSettledResult<unknown>[];
      host.registerPlugin(manifest(true), { commandHandlers: { [command]: async ctx => {
        results = await Promise.allSettled([0, 1].map(() => ctx.chemistry!.embed3d!(two)));
      } } });
      const running = host.invokeCommand(command);
      await vi.advanceTimersByTimeAsync(20000);
      expect(embed3d).toHaveBeenCalledOnce();
      const result = embedded;
      completions[0](result);
      await vi.advanceTimersByTimeAsync(0);
      expect(embed3d).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(expires ? 10001 : 9000);
      if (!expires) completions[1](result);
      await running;
      expect(results[0].status).toBe("fulfilled");
      if (expires) expect(results[1]).toMatchObject({ status: "rejected",
        reason: new Error("embed3d timed out after 30 seconds including queue time.") });
      else expect(results[1].status).toBe("fulfilled");
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
