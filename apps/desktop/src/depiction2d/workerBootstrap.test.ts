import { readFileSync } from "node:fs";
import ts from "typescript";
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
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const waitForReady = (postMessage: ReturnType<typeof vi.fn>) =>
  vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ id: 0, stage: "ready" }));

it("the browser depiction worker waits for WASM initialization and OCL import before ready", async () => {
  let initialized!: () => void;
  boot.init.mockReturnValue(new Promise<void>((resolve) => { initialized = resolve; }));
  const postMessage = vi.fn();
  vi.stubGlobal("self", { postMessage });
  const loaded = import("./worker");
  await vi.waitFor(() => expect(boot.init).toHaveBeenCalledOnce(), { timeout: 10_000 });
  expect(postMessage).not.toHaveBeenCalled();
  initialized(); await loaded;
  await waitForReady(postMessage);
  expect(boot.oclLoaded).toBe(true);
  expect(postMessage).toHaveBeenCalledExactlyOnceWith({ id: 0, stage: "ready" });
}, 15_000);

it("desktop depiction worker stays ready after RDKit init failure, uses OCL and never retries RDKit", async () => {
  boot.init.mockRejectedValue(new Error("stub RDKit WASM init failure"));
  const scope = { postMessage: vi.fn(), onmessage: vi.fn() };
  vi.stubGlobal("self", scope);
  await import("./worker");
  await waitForReady(scope.postMessage);
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
  await waitForReady(scope.postMessage);
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
  // An async bootstrap rejection must still surface as a worker error, not just unhandledrejection.
  const scheduled = vi.fn();
  vi.stubGlobal("setTimeout", scheduled);
  await import("./worker");
  await vi.waitFor(() => expect(scheduled).toHaveBeenCalledOnce());
  expect(scheduled.mock.lastCall?.[1]).toBe(0);
  expect(scheduled.mock.lastCall?.[0]).toThrow("RDKit failed to load: stub RDKit init failure; OpenChemLib failed to load");
  expect(postMessage).not.toHaveBeenCalled();
});

it("queues early messages until ready and completes them in order, including arrivals during layout", async () => {
  const ocl = await vi.importActual<typeof import("@chemdraft/ocl-adapter")>("@chemdraft/ocl-adapter");
  const molfile = ocl.depictSmiles2D("CCO").molfile;
  let initialized!: () => void, finishFirst!: (molfile: string) => void;
  boot.init.mockReturnValue(new Promise<void>(resolve => { initialized = resolve; }));
  boot.generate.mockReturnValueOnce(new Promise<string>(resolve => { finishFirst = resolve; }))
    .mockResolvedValue(molfile);
  const scope = { postMessage: vi.fn(), onmessage: vi.fn() };
  vi.stubGlobal("self", scope);
  await import("./worker");
  scope.onmessage({ data: { id: 1, smiles: "CCO" } });
  scope.onmessage({ data: { id: 2, smiles: "CCO", standardOnly: true } });
  expect(scope.postMessage).not.toHaveBeenCalled();
  expect(boot.generate).not.toHaveBeenCalled();
  initialized();
  await waitForReady(scope.postMessage);
  await vi.waitFor(() => expect(boot.generate).toHaveBeenCalledOnce());
  expect(scope.postMessage).toHaveBeenCalledExactlyOnceWith({ id: 0, stage: "ready" });
  scope.onmessage({ data: { id: 3, smiles: "CCO" } });
  expect(boot.generate).toHaveBeenCalledOnce();
  finishFirst(molfile);
  await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledTimes(4));
  expect(scope.postMessage.mock.calls.map(([reply]) => [reply.id, reply.stage]))
    .toEqual([[0, "ready"], [1, "result"], [2, "result"], [3, "result"]]);
  expect(boot.generate.mock.calls[1]?.[1]).toMatchObject({ standardOnly: true });
  expect(boot.init).toHaveBeenCalledOnce();
});

it("registers synchronously on a WebKit-style transport that drops messages without a listener", async () => {
  let initialized!: () => void;
  boot.init.mockReturnValue(new Promise<void>(resolve => { initialized = resolve; }));
  const ocl = await vi.importActual<typeof import("@chemdraft/ocl-adapter")>("@chemdraft/ocl-adapter");
  boot.generate.mockResolvedValue(ocl.depictSmiles2D("CCO").molfile);
  const endpoint = new EventTarget();
  const scope = { postMessage: vi.fn(), set onmessage(listener: (event: MessageEvent) => void) {
    endpoint.addEventListener("message", listener as EventListener);
  } };
  vi.stubGlobal("self", scope);
  const dispatch = (id: number) => endpoint.dispatchEvent(new MessageEvent("message", { data: { id, smiles: "CCO" } }));
  dispatch(-1); // Dropped; adding a listener later must not replay it.
  const runtime = await import("./runtime");
  const evaluation = await import("../workers/entryEvaluation");
  const entry = new URL("./worker.ts", import.meta.url);
  const source = readFileSync(entry, "utf8").replaceAll("import.meta.url", JSON.stringify(entry.href));
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  });
  const modules: Record<string, unknown> = { "./runtime": runtime, "../workers/entryEvaluation": evaluation };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...args: string[]
  ) => (require: (id: string) => unknown, exports: object) => Promise<void>;
  // Prelink static dependencies, then dispatch before awaiting entry evaluation's promise.
  const evaluating = new AsyncFunction("require", "exports", outputText)(id => {
    if (!(id in modules)) throw new Error(`Unexpected entry dependency: ${id}`);
    return modules[id];
  }, {});
  dispatch(7);
  await evaluating;
  expect(boot.generate).not.toHaveBeenCalled();
  initialized();
  await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledTimes(2));
  expect(scope.postMessage.mock.calls.map(([reply]) => [reply.id, reply.stage]))
    .toEqual([[0, "ready"], [7, "result"]]);
  expect(boot.generate).toHaveBeenCalledOnce();
});
