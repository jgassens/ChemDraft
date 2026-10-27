import { describe, expect, it, vi } from "vitest";
import { timeHost3d, timeHost3dAsync } from "./hostTiming";
import { ModelTokenAuthority } from "./token";
import { createChemistry3dProviders } from "./client";
import type { Chemistry3dTiming } from "./timing";
import { chemistry3dMethod } from "./method";

describe("opt-in host 3D timing", () => {
  it("does not read a clock or wrap promises when disabled", () => {
    const clock = vi.spyOn(performance, "now");
    try {
      const value = {};
      const promise = Promise.resolve(value);
      expect(timeHost3d(undefined, "sync", () => value)).toBe(value);
      expect(timeHost3dAsync(undefined, "async", () => promise)).toBe(promise);
      expect(clock).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it("records failed stages while preserving their errors", async () => {
    const sink = vi.fn();
    const failure = new Error("refused");
    expect(() => timeHost3d(sink, "sync", () => { throw failure; })).toThrow(failure);
    await expect(timeHost3dAsync(sink, "async", async () => { throw failure; })).rejects.toBe(failure);
    expect(sink.mock.calls.map(([event]) => event.stage)).toEqual(["sync", "async"]);
    expect(sink.mock.calls.every(([event]) => Number.isFinite(event.ms) && event.ms >= 0)).toBe(true);
  });

  it("times real signing, verification, provider parsing and contact screening without weakening tokens", async () => {
    const events: Chemistry3dTiming[] = [];
    const sink = (event: Chemistry3dTiming) => { events.push(event); };
    const tokens = new ModelTokenAuthority(sink);
    const model = { atoms: [{ element: "C", charge: 0, component: 0, addedHydrogen: false }], bonds: [], coords: [0, 0, 0],
      components: [{ smiles: "C", atomStart: 0, atomCount: 1 }], modelToken: "unsigned" };
    const flat = { objects: [], depthByAtom: [], method: chemistry3dMethod(42), warnings: [] };
    const run = vi.fn(async () => flat);
    model.modelToken = await tokens.sign(model, 42);
    const providers = createChemistry3dProviders(run, tokens, sink);
    await expect(providers.flatten3d({ model, view: "auto" }, new AbortController().signal)).resolves.toBe(flat);
    expect(events.map(event => event.stage)).toEqual(expect.arrayContaining([
      "token.sign.model-schema", "token.sign.webcrypto", "host.flatten3d.request-schema",
      "token.verify.model-schema", "token.verify.webcrypto", "host.flatten3d.token-verify", "host.flatten3d.clash-screen"
    ]));
    model.atoms[0].charge = 1;
    await expect(providers.flatten3d({ model, view: "auto" }, new AbortController().signal)).rejects.toThrow("modelToken is invalid");
    expect(run).toHaveBeenCalledOnce();
  });
});
