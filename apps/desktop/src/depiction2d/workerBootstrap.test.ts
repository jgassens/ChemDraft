import { afterEach, beforeEach, expect, it, vi } from "vitest";

const boot = vi.hoisted(() => ({ init: vi.fn(), generate: vi.fn(), oclLoaded: false, failOcl: false }));
vi.mock("@chemdraft/rdkit-adapter", () => ({ ensureRdkit: boot.init, generateSmiles2DMolfile: boot.generate }));
vi.mock("../rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); boot.failOcl = false; boot.oclLoaded = false;
  vi.doMock("@chemdraft/ocl-adapter", async () => {
    if (boot.failOcl) throw new Error("stub OCL import failure");
    boot.oclLoaded = true;
    return vi.importActual("@chemdraft/ocl-adapter");
  });
});
afterEach(() => vi.unstubAllGlobals());

it("the browser depiction worker waits for WASM initialization and OCL import before ready", async () => {
  let initialized!: () => void;
  boot.init.mockReturnValue(new Promise<void>((resolve) => { initialized = resolve; }));
  const postMessage = vi.fn();
  vi.stubGlobal("self", { postMessage });
  const loaded = import("./worker");
  await vi.waitFor(() => expect(boot.init).toHaveBeenCalledOnce(), { timeout: 10_000 });
  expect(postMessage).not.toHaveBeenCalled();
  initialized(); await loaded;
  expect(boot.oclLoaded).toBe(true);
  expect(postMessage).toHaveBeenCalledExactlyOnceWith({ id: 0, stage: "ready" });
}, 15_000);

it("desktop depiction worker stays ready after RDKit init failure, uses OCL and never retries RDKit", async () => {
  boot.init.mockRejectedValue(new Error("stub RDKit WASM init failure"));
  const scope = { postMessage: vi.fn(), onmessage: vi.fn() };
  vi.stubGlobal("self", scope);
  await import("./worker");
  expect(scope.postMessage).toHaveBeenCalledWith({ id: 0, stage: "ready" });
  for (const id of [1, 2]) {
    await scope.onmessage({ data: { id, smiles: "CCO" } });
    expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ id, stage: "result", result: {
      depiction: expect.objectContaining({ atoms: expect.any(Array) }), stereoCount: 0,
      warnings: [expect.stringContaining("RDKit failed to load: stub RDKit WASM init failure")]
    } }));
    expect(scope.postMessage.mock.lastCall?.[0].result.depiction.atoms).toHaveLength(3);
  }
  expect(boot.init).toHaveBeenCalledOnce();
  expect(boot.generate).not.toHaveBeenCalled();
});

it("desktop depiction worker stays ready when only OCL fails, and warns that stereo counts are unavailable", async () => {
  const ocl = await vi.importActual<typeof import("@chemdraft/ocl-adapter")>("@chemdraft/ocl-adapter");
  boot.generate.mockResolvedValue(ocl.depictSmiles2D("CCO").molfile);
  boot.init.mockResolvedValue({}); boot.failOcl = true;
  const scope = { postMessage: vi.fn(), onmessage: vi.fn() };
  vi.stubGlobal("self", scope);
  await import("./worker");
  expect(scope.postMessage).toHaveBeenCalledWith({ id: 0, stage: "ready" });
  await scope.onmessage({ data: { id: 1, smiles: "CCO" } });
  expect(scope.postMessage.mock.lastCall?.[0]).toMatchObject({ stage: "result", result: {
    warnings: [expect.stringContaining("OpenChemLib failed to load:")]
  } });
  expect(boot.generate).toHaveBeenCalledOnce();
});

it("desktop depiction worker fails bootstrap only when both engines fail", async () => {
  boot.init.mockRejectedValue(new Error("stub RDKit init failure")); boot.failOcl = true;
  const postMessage = vi.fn(); vi.stubGlobal("self", { postMessage });
  await expect(import("./worker")).rejects.toThrow("RDKit failed to load: stub RDKit init failure; OpenChemLib failed to load");
  expect(postMessage).not.toHaveBeenCalled();
});
