import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { Chemistry3dWorkRequest, Chemistry3dWorkResponse } from "./protocol";

const engine = vi.hoisted(() => ({ initializeChemistry3dWorker: vi.fn(), embed3dInWorker: vi.fn(),
  minimize3dInWorker: vi.fn(), flatten3dInWorker: vi.fn() }));
vi.mock("./engine", () => engine);
vi.mock("@chemdraft/rdkit-adapter", () => ({ ensureRdkit: vi.fn(), generate3DConformerProgressive: vi.fn() }));
vi.mock("@chemdraft/ocl-adapter", () => ({ ensureOclResources: vi.fn(), generate3DConformerProgressive: vi.fn(),
  setOclResourcesUrl: vi.fn(), withOclConformerTrace: vi.fn() }));
vi.mock("../rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("../oclResources", () => ({ oclResourcesUrl: "test:ocl-resources" }));

const handlerKey = Symbol.for("org.chemdraft.conformerWorker.messageHandler");
const counterKey = Symbol.for("org.chemdraft.workerEntryEvaluations");
const profileListenerKey = Symbol.for("org.chemdraft.workerEntryProfileListener");
afterEach(() => {
  Reflect.deleteProperty(globalThis, handlerKey);
  Reflect.deleteProperty(globalThis, counterKey);
  Reflect.deleteProperty(globalThis, profileListenerKey);
  Reflect.deleteProperty(globalThis, Symbol.for("org.chemdraft.workerActivity"));
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/** Evaluate the actual entry body without awaiting its module-evaluation promise first.
 * Static imports are prelinked; CJS lowering preserves dynamic imports as deferred promises.
 * This lets the transport dispatch at the first suspension, as in the reported WKWebView.
 * An ordinary `await import(entry)` test waits past that lost-message window and misses the bug. */
function evaluateEntry(entry: URL, modules: Record<string, unknown>): Promise<void> {
  const source = readFileSync(entry, "utf8").replaceAll("import.meta.url", JSON.stringify(entry.href));
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  });
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...args: string[]
  ) => (require: (id: string) => unknown, exports: object) => Promise<void>;
  return new AsyncFunction("require", "exports", outputText)(id => {
    if (!(id in modules)) throw new Error(`Unexpected entry dependency: ${id}`);
    return modules[id];
  }, {});
}

it("handles the first job with WebKit semantics: pre-listener messages are dropped, never replayed", async () => {
  vi.resetModules();
  vi.stubEnv("CHEMDRAFT_WKPROFILE", "1");
  const endpoint = new EventTarget();
  const replies: unknown[] = [];
  vi.stubGlobal("addEventListener", endpoint.addEventListener.bind(endpoint));
  vi.stubGlobal("removeEventListener", endpoint.removeEventListener.bind(endpoint));
  vi.stubGlobal("postMessage", (reply: unknown) => replies.push(reply));
  const dispatch = (data: unknown) => endpoint.dispatchEvent(new MessageEvent("message", { data }));
  const request = { kind: "chemistry3d", id: 123, job: { method: "embed3d", request: {} } };
  // Negative control: this transport really drops a message, even if listeners appear later.
  dispatch(request);
  const runtime = await import("../conformerWorkerRuntime");
  const evaluation = await import("../workers/entryEvaluation");
  let initialized!: () => void;
  engine.initializeChemistry3dWorker.mockImplementationOnce(() => new Promise<void>(resolve => { initialized = resolve; }));
  const result = { marker: "first job" };
  engine.embed3dInWorker.mockResolvedValueOnce(result);

  const evaluating = evaluateEntry(new URL("../conformerWorker.ts", import.meta.url), {
    "./conformerWorkerRuntime": runtime, "./workers/entryEvaluation": evaluation
  });
  // No await/microtask between entry evaluation and the first real job or diagnostic query.
  // The f6cf4745 top-level-await bootstrap loses BOTH here.
  dispatch(request);
  dispatch({ kind: "chemdraft-worker-profile-request", requestId: 9 });
  expect(replies).toContainEqual(expect.objectContaining({ kind: "chemdraft-worker-profile", requestId: 9,
    entries: [{ worker: "conformer", entryUrl: expect.any(String), evaluations: 1 }] }));
  await evaluating;
  await vi.waitFor(() => expect(engine.initializeChemistry3dWorker).toHaveBeenCalledOnce());
  expect(engine.embed3dInWorker).not.toHaveBeenCalled();
  initialized();
  await vi.waitFor(() => expect(replies).toContainEqual({ kind: "chemistry3d-result", id: 123, result }));
  expect(engine.embed3dInWorker).toHaveBeenCalledOnce();
  dispatch({ kind: "chemdraft-worker-profile-request", requestId: 10 });
  expect(replies).toContainEqual(expect.objectContaining({ requestId: 10,
    activity: expect.arrayContaining([expect.objectContaining({ stage: "worker.request.chemistry3d",
      endedAtEpochMs: expect.any(Number), details: { requestId: 123, method: "embed3d" } })]) }));
});

it.each([
  ["massFragmentPluginWorker", "mass-fragment"],
  ["windowsMassFragmentPluginWorker", "mass-fragment-windows"]
])("synchronously handles the first analyzer invocation in %s", async (entry, worker) => {
  vi.resetModules();
  vi.stubEnv("CHEMDRAFT_WKPROFILE", "1");
  const endpoint = new EventTarget();
  const replies: Record<string, unknown>[] = [];
  const addListener = vi.fn(endpoint.addEventListener.bind(endpoint));
  vi.stubGlobal("addEventListener", addListener);
  vi.stubGlobal("postMessage", (reply: Record<string, unknown>) => replies.push(reply));
  const dispatch = (data: unknown) => endpoint.dispatchEvent(new MessageEvent("message", { data }));
  const runtime = await import("../workers/massFragmentRuntime");
  const evaluation = await import("../workers/entryEvaluation");
  const { massAnalyzeCommandId } = await import("@chemdraft/plugin-mass-fragment");
  const shim = await import("../plugins/workers/installWindowsWorkerShim");
  const evaluating = evaluateEntry(new URL(`../plugins/workers/${entry}.ts`, import.meta.url), {
    "../../workers/massFragmentRuntime": runtime, "../../workers/entryEvaluation": evaluation,
    "./installWindowsWorkerShim": shim
  });
  expect(addListener).toHaveBeenCalledTimes(2); // profiler first, real protocol listener second
  dispatch({ kind: "invokeCommand", commandRequestId: 17, commandId: massAnalyzeCommandId });
  dispatch({ kind: "chemdraft-worker-profile-request", requestId: 3 });
  expect(replies).toContainEqual({ kind: "chemdraft-worker-profile", requestId: 3,
    entries: [{ worker, entryUrl: expect.any(String), evaluations: 1 }] });
  await evaluating;
  await vi.waitFor(() => expect(replies.some(reply => reply.kind === "capabilityRequest")).toBe(true));
  const request = replies.find(reply => reply.kind === "capabilityRequest");
  expect(request).toMatchObject({ commandRequestId: 17, namespace: "selection", method: "getSelection" });
  // Finish the real command with its honest no-selection result; no pending capability is left.
  dispatch({ kind: "capabilityResult", requestId: request!.requestId, ok: true, value: { objectIds: [], molecules: [] } });
  await vi.waitFor(() => expect(replies).toContainEqual(expect.objectContaining({
    kind: "commandSettled", commandRequestId: 17, ok: true,
    value: { ok: false, error: { code: "MASS_NO_SELECTION", message: expect.any(String) } }
  })));
});

it("retains one defensive listener if the worker entry is deliberately reevaluated", async () => {
  const listeners = new Set<EventListener>();
  const replies: Chemistry3dWorkResponse[] = [];
  vi.stubGlobal("addEventListener", (type: string, listener: EventListener) => {
    if (type === "message") listeners.add(listener);
  });
  vi.stubGlobal("removeEventListener", (type: string, listener: EventListener) => {
    if (type === "message") listeners.delete(listener);
  });
  vi.stubGlobal("postMessage", (reply: Chemistry3dWorkResponse) => replies.push(reply));
  // Simulate distinct bootstrap/import module instances sharing the SAME worker global.
  // A module-local boolean cannot prevent two listeners in this situation.
  vi.resetModules();
  await import("../conformerWorker");
  const original = [...listeners][0];
  vi.resetModules();
  await import("../conformerWorker");
  expect(listeners.size).toBe(1);
  expect(listeners.has(original)).toBe(false);

  const result = { marker: "unchanged engine result" };
  engine.embed3dInWorker.mockResolvedValue(result);
  engine.minimize3dInWorker.mockResolvedValue(result);
  engine.flatten3dInWorker.mockResolvedValue(result);
  const methods = ["embed3d", "minimize3d", "flatten3d"] as const;
  for (const [index, method] of methods.entries()) {
    const request = { kind: "chemistry3d", id: index + 1, job: { method, request: {} } } as Chemistry3dWorkRequest;
    for (const listener of [...listeners]) listener({ data: request } as MessageEvent<Chemistry3dWorkRequest>);
    await vi.waitFor(() => expect(replies.filter(reply => reply.kind === "chemistry3d-result")).toHaveLength(index + 1));
  }
  expect(engine.initializeChemistry3dWorker).toHaveBeenCalledTimes(3);
  expect(engine.embed3dInWorker).toHaveBeenCalledOnce();
  expect(engine.minimize3dInWorker).toHaveBeenCalledOnce();
  expect(engine.flatten3dInWorker).toHaveBeenCalledOnce();
  expect(replies.filter(reply => reply.kind === "chemistry3d-result"))
    .toEqual(methods.map((_, index) => ({ kind: "chemistry3d-result", id: index + 1, result })));
});
