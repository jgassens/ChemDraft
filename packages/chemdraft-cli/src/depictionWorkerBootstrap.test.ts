import { beforeEach, expect, it, vi } from "vitest";

const boot = vi.hoisted(() => ({ init: vi.fn(), post: vi.fn(), on: vi.fn() }));
vi.mock("node:worker_threads", () => ({ parentPort: { on: boot.on, postMessage: boot.post } }));
vi.mock("tsx/esm/api", () => ({ register: vi.fn() }));
vi.mock("tsx/cjs/api", () => ({ register: vi.fn() }));
vi.mock("./engine", () => ({ installNodeEngines: vi.fn() }));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.doUnmock("@chemdraft/ocl-adapter");
  vi.doMock("@chemdraft/rdkit-adapter", async () => ({
    ...await vi.importActual<typeof import("@chemdraft/rdkit-adapter")>("@chemdraft/rdkit-adapter"), ensureRdkit: boot.init
  }));
});

it("CLI depiction worker stays ready after RDKit init failure, uses OCL and never retries RDKit", async () => {
  boot.init.mockRejectedValue(new Error("stub RDKit WASM init failure"));
  await import("./depictionWorker.mjs");
  expect(boot.post).toHaveBeenCalledWith({ id: 0, stage: "ready" });
  const handle = boot.on.mock.calls.find(([event]) => event === "message")![1];
  for (const id of [1, 2]) {
    await handle({ id, smiles: "CCO" });
    expect(boot.post.mock.lastCall?.[0]).toMatchObject({ id, stage: "result", result: {
      engine: "ocl", identityVerifiedByRdkit: false, depiction: { atoms: expect.any(Array) },
      warnings: expect.arrayContaining([expect.stringContaining("RDKit failed to load: stub RDKit WASM init failure")])
    } });
    expect(boot.post.mock.lastCall?.[0].result.depiction.atoms).toHaveLength(3);
  }
  expect(boot.init).toHaveBeenCalledOnce();
});

it("CLI depiction worker stays ready when only OCL fails and uses RDKit with a stereo-count warning", async () => {
  const { installRealRdkitModuleLoader } = await import("@chemdraft/rdkit-adapter/testing");
  installRealRdkitModuleLoader();
  const rdkit = await vi.importActual<typeof import("@chemdraft/rdkit-adapter")>("@chemdraft/rdkit-adapter");
  boot.init.mockImplementation(rdkit.ensureRdkit);
  vi.doMock("@chemdraft/ocl-adapter", () => { throw new Error("stub OCL import failure"); });
  await import("./depictionWorker.mjs");
  expect(boot.post).toHaveBeenCalledWith({ id: 0, stage: "ready" });
  const handle = boot.on.mock.calls.find(([event]) => event === "message")![1];
  await handle({ id: 1, smiles: "C[C@H](F)Cl" });
  expect(boot.post.mock.lastCall?.[0], boot.post.mock.lastCall?.[0]?.message).toMatchObject({ id: 1, stage: "result", result: {
    engine: "rdkit", identityVerifiedByRdkit: true,
    warnings: [expect.stringContaining("OpenChemLib failed to load:")]
  } });
  expect(boot.post.mock.lastCall?.[0].result.depiction.atoms).toHaveLength(4);
});

it("CLI depiction worker fails bootstrap only when both engines fail", async () => {
  boot.init.mockRejectedValue(new Error("stub RDKit init failure"));
  vi.doMock("@chemdraft/ocl-adapter", () => { throw new Error("stub OCL import failure"); });
  await expect(import("./depictionWorker.mjs")).rejects.toThrow("RDKit failed to load: stub RDKit init failure; OpenChemLib failed to load");
  expect(boot.post).not.toHaveBeenCalled();
});
