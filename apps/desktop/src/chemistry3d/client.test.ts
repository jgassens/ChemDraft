import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChemistry3dProviders, createConformerWorkerPool } from "./client";
import { ModelTokenAuthority } from "./token";
import { PluginHost } from "@chemdraft/plugin-host";
import { chemistry3dMethod } from "./method";
import type { Chemistry3dJob, Chemistry3dWorkRequest, Chemistry3dWorkResponse } from "./protocol";

class TestWorker {
  static instances: TestWorker[] = [];
  static autoReady = true;
  onmessage?: (event: { data: Chemistry3dWorkResponse }) => void;
  onerror?: (event: { message: string }) => void;
  terminate = vi.fn();
  postMessage = vi.fn((request: Chemistry3dWorkRequest) => {
    if (TestWorker.autoReady) this.emit({ kind: "chemistry3d-ready", id: request.id });
  });
  constructor(readonly url: URL, readonly options: WorkerOptions) { TestWorker.instances.push(this); }
  get request(): Chemistry3dWorkRequest { return this.postMessage.mock.lastCall![0]; }
  emit(data: unknown): void { this.onmessage?.({ data: structuredClone(data) as Chemistry3dWorkResponse }); }
  reply(data: unknown): void { this.emit({ ...data as object, id: this.request.id }); }
}
const model = { atoms: [{ element: "C", charge: 0, component: 0, addedHydrogen: false }], bonds: [], coords: [0, 0, 0],
  components: [{ smiles: "C", atomStart: 0, atomCount: 1 }], modelToken: "test" };
const jobs: Chemistry3dJob[] = [
  { method: "embed3d", request: { components: [{ smiles: "C" }] } },
  { method: "minimize3d", request: { model, interfragment: false }, provenance: chemistry3dMethod(42) },
  { method: "flatten3d", request: { model, view: "auto" }, provenance: chemistry3dMethod(42) }
];
let pool: ReturnType<typeof createConformerWorkerPool>;
const runInConformerWorker: ReturnType<typeof createConformerWorkerPool>["run"] = (job, signal) => pool.run(job, signal);
beforeEach(() => { vi.useFakeTimers(); TestWorker.instances = []; TestWorker.autoReady = true; vi.stubGlobal("Worker", TestWorker); pool = createConformerWorkerPool(); });
afterEach(() => { pool.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("3D chemistry conformer worker lifetime", () => {
  it("refuses a signed clashing model before constructing or queueing a cold worker", async () => {
    TestWorker.autoReady = false;
    const tokens = new ModelTokenAuthority();
    const pair = { atoms: [model.atoms[0], { ...model.atoms[0], element: "O", component: 1 }],
      bonds: [], coords: [0, 0, 0, 1.851, 0, 0], components: [model.components[0],
        { smiles: "O", atomStart: 1, atomCount: 1 }], modelToken: "unsigned" };
    pair.modelToken = await tokens.sign(pair, 42);
    const providers = createChemistry3dProviders(pool.run, tokens);
    await expect(providers.flatten3d({ model: pair, view: "auto" }, new AbortController().signal))
      .rejects.toThrow("flatten3d refused a clashing model: closest inter-component heavy-atom contact is 1.851 A");
    expect(TestWorker.instances).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("excludes cold startup from BOTH the plugin admission and worker call deadlines", async () => {
    TestWorker.autoReady = false;
    const host = new PluginHost({ flatten3d: (_request, signal) => pool.run(jobs[2], signal) as
      Promise<import("@chemdraft/plugin-api").PluginFlatten3DResult> });
    const id = "plugin.coldFlatten.run";
    host.registerPlugin({ id: "org.test.coldFlatten", name: "Cold flatten", version: "0.0.1", apiVersion: "^0.1.15",
      entry: "index.js", permissions: ["chemistry.compute"], contributes: { commands: [{ id, title: "Flatten", requiredPermissions: [] }] } },
    { commandHandlers: { [id]: context => context.chemistry!.flatten3d!({ model, view: "auto" }) } });
    const result = host.invokeCommand(id);
    const failed = expect(result).rejects.toThrow("flatten3d timed out after 5 seconds including queue time.");
    await vi.advanceTimersByTimeAsync(12_000);
    const worker = TestWorker.instances[0];
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.reply({ kind: "chemistry3d-ready" });
    await vi.advanceTimersByTimeAsync(4_999);
    // Duplicate readiness and progress cannot keep extending the budget.
    worker.reply({ kind: "chemistry3d-ready" });
    worker.reply({ kind: "chemistry3d-progress" });
    expect(worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds startup separately and terminates a worker that never becomes ready", async () => {
    TestWorker.autoReady = false;
    const failed = expect(pool.run(jobs[2], new AbortController().signal))
      .rejects.toThrow("flatten3d worker startup timed out after 30 seconds.");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(TestWorker.instances[0].terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves queue time already spent before cold startup", async () => {
    const controllers = [new AbortController(), new AbortController()];
    const active = controllers.map(controller => pool.run(jobs[1], controller.signal).catch(error => error));
    const result = pool.run(jobs[2], new AbortController().signal);
    const failed = expect(result).rejects.toThrow("flatten3d timed out after 5 seconds including queue time.");
    await vi.advanceTimersByTimeAsync(4_000);
    TestWorker.autoReady = false;
    // Cancellation destroys a warm worker, so the queued job must start a new cold one.
    controllers[0].abort();
    const cold = TestWorker.instances[2];
    await vi.advanceTimersByTimeAsync(12_000);
    cold.reply({ kind: "chemistry3d-ready" });
    await vi.advanceTimersByTimeAsync(999);
    expect(cold.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect(cold.terminate).toHaveBeenCalledOnce();
    controllers[1].abort();
    await Promise.all(active);
  });
  it("does not call the console when reply logging is absent", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const result = pool.run(jobs[0], new AbortController().signal);
    TestWorker.instances[0].reply({ kind: "chemistry3d-result", result: { model, method: chemistry3dMethod(42), warnings: [] } });
    await result;
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });
  it("logs accepted and stale replies without result payloads when a logger is provided", async () => {
    pool.dispose();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    pool = createConformerWorkerPool({ replyLogger: reply => console.info("[chemistry3d reply]", reply) });
    const embedded = { model, method: chemistry3dMethod(42), warnings: [] };
    const first = pool.run(jobs[0], new AbortController().signal);
    const worker = TestWorker.instances.at(-1)!;
    const firstId = worker.request.id;
    worker.reply({ kind: "chemistry3d-result", result: embedded });
    await first;
    const current = pool.run(jobs[2], new AbortController().signal);
    const currentId = worker.request.id;
    worker.emit({ id: firstId, kind: "chemistry3d-result", result: embedded });
    const flattened = { objects: [], depthByAtom: [], method: chemistry3dMethod(42), warnings: [] };
    worker.reply({ kind: "chemistry3d-result", result: flattened });
    await current;
    expect(info).toHaveBeenCalledWith("[chemistry3d reply]", {
      workerSlot: 0, replyJobId: firstId, waitingJobId: firstId, method: "embed3d",
      kind: "chemistry3d-result", accepted: true, resultKeys: ["model", "method", "warnings"]
    });
    expect(info).toHaveBeenCalledWith("[chemistry3d reply]", {
      workerSlot: 0, replyJobId: firstId, waitingJobId: currentId, method: "flatten3d",
      kind: "chemistry3d-result", accepted: false, resultKeys: ["model", "method", "warnings"]
    });
    info.mockRestore();
  });
  it("delivers a result when the reply logger throws", async () => {
    pool.dispose();
    const expected = { model, method: chemistry3dMethod(42), warnings: [] };
    pool = createConformerWorkerPool({ replyLogger: () => { throw new Error("logger failed"); } });
    const result = pool.run(jobs[0], new AbortController().signal);
    TestWorker.instances[0].reply({ kind: "chemistry3d-result", result: expected });
    await expect(result).resolves.toEqual(expected);
  });
  it("swallows a throwing logger for an idle worker and keeps the pool usable", async () => {
    pool.dispose();
    pool = createConformerWorkerPool({ replyLogger: () => { throw new Error("logger failed"); } });
    const first = pool.run(jobs[0], new AbortController().signal);
    const worker = TestWorker.instances[0];
    const embedded = { model, method: chemistry3dMethod(42), warnings: [] };
    worker.reply({ kind: "chemistry3d-result", result: embedded });
    await expect(first).resolves.toEqual(embedded);

    expect(() => worker.emit({ id: worker.request.id, kind: "chemistry3d-result", result: embedded })).not.toThrow();

    const expected = { objects: [], depthByAtom: [], method: chemistry3dMethod(42), warnings: [] };
    const next = pool.run(jobs[2], new AbortController().signal);
    worker.reply({ kind: "chemistry3d-result", result: expected });
    await expect(next).resolves.toEqual(expected);
  });
  it("does not deliver a previous result to the next call after a worker is reused", async () => {
    const embedded = { model, method: chemistry3dMethod(42), warnings: [] };
    const minimized = { ...embedded, clash: false,
      forceField: { name: "mmff94s", status: "converged", energy: 1, iterationsBudget: 1000 } };
    const flattened = { objects: [], depthByAtom: [], method: chemistry3dMethod(42), warnings: [] };
    let previousReply: unknown;
    let previousHandler: TestWorker["onmessage"];
    for (const [index, expected] of [embedded, minimized, flattened].entries()) {
      const result = pool.run(jobs[index], new AbortController().signal);
      const worker = TestWorker.instances[0];
      const handler = worker.onmessage;
      const reply = { kind: "chemistry3d-result", id: worker.request.id, result: expected };
      // A message queued before handler replacement can be dispatched after the slot is reused.
      // This is deliberately delivered to the CURRENT handler, not a saved old callback.
      if (index > 0) worker.emit(previousReply);
      worker.emit(reply);
      await expect(result).resolves.toEqual(expected);
      if (index > 0) expect(handler).toBe(previousHandler);
      previousHandler = handler;
      previousReply = reply;
    }
    expect(TestWorker.instances).toHaveLength(1);
  });
  it("keeps two in-flight jobs separate with out-of-order replies and immediate queued slot reuse", async () => {
    const embedded = { model, method: chemistry3dMethod(42), warnings: ["first job"] };
    const minimized = { ...embedded, clash: false, warnings: ["second job"],
      forceField: { name: "mmff94s", status: "converged", energy: 1, iterationsBudget: 1000 } };
    const flattened = { objects: [], depthByAtom: [], method: chemistry3dMethod(42), warnings: ["third job"] };
    const first = pool.run(jobs[0], new AbortController().signal);
    const second = pool.run(jobs[1], new AbortController().signal);
    const third = pool.run(jobs[2], new AbortController().signal);
    const [a, b] = TestWorker.instances;
    const firstId = a.request.id;
    const secondId = b.request.id;
    expect(firstId).not.toBe(secondId);
    // Complete the second job first; its slot is immediately assigned the queued third job.
    b.reply({ kind: "chemistry3d-result", result: minimized });
    expect(b.request.job.method).toBe("flatten3d");
    expect(new Set([firstId, secondId, b.request.id]).size).toBe(3);
    b.emit({ kind: "chemistry3d-result", id: secondId, result: minimized });
    a.reply({ kind: "chemistry3d-result", result: embedded });
    b.reply({ kind: "chemistry3d-result", result: flattened });
    await expect(Promise.all([first, second, third])).resolves.toEqual([embedded, minimized, flattened]);
  });
  it("ignores a cancelled job's late reply after a new call starts on the same pool", async () => {
    const controller = new AbortController();
    const cancelled = pool.run(jobs[0], controller.signal);
    const rejected = expect(cancelled).rejects.toThrow("cancelled because the plugin command ended");
    const previousWorker = TestWorker.instances[0];
    const previousId = previousWorker.request.id;
    controller.abort();
    await rejected;
    const current = pool.run(jobs[2], new AbortController().signal);
    const currentWorker = TestWorker.instances[1];
    expect(previousWorker.terminate).toHaveBeenCalledOnce();
    expect(currentWorker.request.id).not.toBe(previousId);
    const stale = { id: previousId, kind: "chemistry3d-result", result: { model, method: chemistry3dMethod(42), warnings: [] } };
    // Exercise both an already-queued callback on the terminated worker and stale
    // delivery to the new active handler: neither may satisfy the current call.
    previousWorker.emit(stale);
    currentWorker.emit(stale);
    const flattened = { objects: [], depthByAtom: [], method: chemistry3dMethod(42), warnings: [] };
    currentWorker.reply({ kind: "chemistry3d-result", result: flattened });
    await expect(current).resolves.toEqual(flattened);
  });
  it("filters stale timing, errors, progress and unrelated Spin/warmup frames before handling them", async () => {
    pool.dispose();
    const onTiming = vi.fn();
    pool = createConformerWorkerPool({ onTiming });
    const first = pool.run(jobs[0], new AbortController().signal);
    const worker = TestWorker.instances[0];
    const oldId = worker.request.id;
    const embedded = { model, method: chemistry3dMethod(42), warnings: [] };
    worker.reply({ kind: "chemistry3d-result", result: embedded });
    await first;
    const current = pool.run(jobs[0], new AbortController().signal);
    const id = worker.request.id;
    expect(id).not.toBe(oldId);
    const timing = { stage: "stale timing", ms: 123 };
    for (const frame of [
      { kind: "chemistry3d-timing", id: oldId, timing },
      { kind: "chemistry3d-error", id: oldId, message: "old error" },
      { kind: "chemistry3d-progress", id: oldId },
      { kind: "chemistry3d-ready", id: oldId },
      { kind: "chemistry3d-result", result: embedded }, // untagged legacy frame
      { id, stage: "warmed" }, { id, stage: "embedded", result: embedded },
      { id, stage: "refined", result: embedded }, { id, stage: "error", message: "Spin error" },
      { id, stage: "trace", trace: {} }, { id, stage: "complete" }, null
    ]) worker.emit(frame);
    expect(onTiming).not.toHaveBeenCalledWith(timing);
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.reply({ kind: "chemistry3d-progress" });
    worker.reply({ kind: "chemistry3d-result", result: embedded });
    await expect(current).resolves.toEqual(embedded);
  });
  it("rejects a matching worker error and never reuses job ids after pool recreation", async () => {
    const first = pool.run(jobs[0], new AbortController().signal);
    const rejected = expect(first).rejects.toThrow("engine refused this job");
    const worker = TestWorker.instances[0];
    const id = worker.request.id;
    worker.reply({ kind: "chemistry3d-error", message: "engine refused this job" });
    await rejected;
    pool.dispose();
    pool = createConformerWorkerPool();
    const next = pool.run(jobs[0], new AbortController().signal);
    const currentWorker = TestWorker.instances[1];
    expect(currentWorker.request.id).not.toBe(id);
    const embedded = { model, method: chemistry3dMethod(42), warnings: [] };
    currentWorker.reply({ kind: "chemistry3d-result", result: embedded });
    await expect(next).resolves.toEqual(embedded);
  });
  it("enables timing only when explicitly requested and forwards worker events", async () => {
    pool.dispose();
    const onTiming = vi.fn();
    pool = createConformerWorkerPool({ onTiming });
    const result = pool.run(jobs[0], new AbortController().signal);
    const worker = TestWorker.instances[0];
    expect(worker.postMessage).toHaveBeenCalledWith({ kind: "chemistry3d", id: expect.any(Number), job: jobs[0], profile: true });
    const timing = { stage: "embed.attempt", ms: 123, details: { useRandomCoords: true } };
    worker.reply({ kind: "chemistry3d-timing", timing });
    expect(onTiming).toHaveBeenCalledWith(timing);
    worker.reply({ kind: "chemistry3d-result", result: { model, method: chemistry3dMethod(42), warnings: [] } });
    await result;
    expect(onTiming.mock.calls.at(-1)![0].stage).toBe("host.embed3d.roundtrip");
  });
  it.each(jobs)("terminates $method on command cancellation", async job => {
    const controller = new AbortController();
    const result = runInConformerWorker(job, controller.signal);
    const failed = expect(result).rejects.toThrow(`chemistry.${job.method} cancelled because the plugin command ended.`);
    const worker = TestWorker.instances[0];
    expect(worker.url.pathname).toMatch(/conformerWorker.ts$/);
    expect(worker.options).toEqual({ type: "module" });
    expect(worker.postMessage).toHaveBeenCalledWith({ kind: "chemistry3d", id: expect.any(Number), job });
    controller.abort();
    await failed;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(jobs)("enforces the $method timeout and terminates synchronous WASM", async job => {
    const result = runInConformerWorker(job, new AbortController().signal);
    const failed = expect(result).rejects.toThrow("timed out");
    const timeout = job.method === "embed3d" ? 15000 : job.method === "minimize3d" ? 60000 : 5000;
    await vi.advanceTimersByTimeAsync(timeout - 1);
    expect(TestWorker.instances[0].terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });
  it("uses one total embed deadline across components, and reuses a successful worker", async () => {
    const result = runInConformerWorker({ method: "embed3d", request: { components: [{ smiles: "C" }, { smiles: "O" }] } }, new AbortController().signal);
    const worker = TestWorker.instances[0];
    worker.reply({ kind: "chemistry3d-progress" }); // first component
    await vi.advanceTimersByTimeAsync(14000);
    worker.reply({ kind: "chemistry3d-progress" });
    await vi.advanceTimersByTimeAsync(14000);
    expect(worker.terminate).not.toHaveBeenCalled();
    const embedded = { model, method: chemistry3dMethod(42), warnings: [] };
    worker.reply({ kind: "chemistry3d-result", result: embedded });
    await expect(result).resolves.toEqual(embedded);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const again = runInConformerWorker(jobs[0], new AbortController().signal);
    expect(TestWorker.instances).toHaveLength(1);
    worker.reply({ kind: "chemistry3d-result", result: embedded });
    await expect(again).resolves.toEqual(embedded);
  });
  it("does not start a worker for an already ended command", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(runInConformerWorker(jobs[0], controller.signal)).rejects.toThrow();
    expect(TestWorker.instances).toHaveLength(0);
  });
  it("runs Promise.all of 20 calls on at most two live workers and drains cancelled queues", async () => {
    const controllers = Array.from({ length: 20 }, () => new AbortController());
    const results = controllers.map(controller => runInConformerWorker(jobs[0], controller.signal));
    const all = Promise.all(results.map(result => result.catch(error => error)));
    expect(TestWorker.instances).toHaveLength(2);
    const embedded = { model, method: chemistry3dMethod(42), warnings: [] };
    // Finishing a call dispatches a queued one on that same initialized worker.
    for (let i = 0; i < 6; i++) TestWorker.instances[i % 2].reply({ kind: "chemistry3d-result", result: embedded });
    expect(TestWorker.instances).toHaveLength(2);
    // Abort queued calls first so cancellation cannot dispatch them.
    for (const controller of controllers.slice(8)) controller.abort();
    for (const controller of controllers.slice(6, 8)) controller.abort();
    const settled = await all;
    expect(settled.filter(result => !(result instanceof Error))).toHaveLength(6);
    expect(settled.filter(result => result instanceof Error)).toHaveLength(14);
    expect(TestWorker.instances).toHaveLength(2);
    expect(TestWorker.instances.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("charges global queue time to the deadline and does not reset it on first-component progress", async () => {
    const blocking = [new AbortController(), new AbortController()];
    const active = blocking.map(controller => runInConformerWorker(jobs[1], controller.signal).catch(error => error));
    const queued = runInConformerWorker(jobs[0], new AbortController().signal);
    const failed = expect(queued).rejects.toThrow("embed3d timed out after 15 seconds including queue time.");
    await vi.advanceTimersByTimeAsync(14000);
    TestWorker.instances[0].reply({ kind: "chemistry3d-result", result: { model, method: chemistry3dMethod(42), warnings: [] } });
    TestWorker.instances[0].reply({ kind: "chemistry3d-progress" });
    await vi.advanceTimersByTimeAsync(1000);
    await failed;
    expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce();
    blocking.forEach(controller => controller.abort());
    await Promise.all(active);
  });
  it("expires waiting calls without creating a third worker", async () => {
    const controllers = [new AbortController(), new AbortController()];
    const active = controllers.map(controller => runInConformerWorker(jobs[1], controller.signal).catch(error => error));
    const failed = expect(runInConformerWorker(jobs[2], new AbortController().signal)).rejects.toThrow("flatten3d timed out after 5 seconds including queue time.");
    await vi.advanceTimersByTimeAsync(5000);
    await failed;
    expect(TestWorker.instances).toHaveLength(2);
    controllers.forEach(controller => controller.abort());
    await Promise.all(active);
  });
  it.each([false, true])("gives a two-component embed 30 s total including a busy global queue (expires=%s)", async expires => {
    const controllers = [new AbortController(), new AbortController()];
    const active = controllers.map(controller => runInConformerWorker(jobs[1], controller.signal).catch(error => error));
    const job: Chemistry3dJob = { method: "embed3d", request: { components: [{ smiles: "C" }, { smiles: "O" }] } };
    const queued = runInConformerWorker(job, new AbortController().signal);
    const embedded = { model, method: chemistry3dMethod(42), warnings: [] };
    const assertion = expires ? expect(queued).rejects.toThrow("embed3d timed out after 30 seconds including queue time.") :
      expect(queued).resolves.toEqual(embedded);
    await vi.advanceTimersByTimeAsync(20000);
    expect(TestWorker.instances).toHaveLength(2);
    expect(TestWorker.instances[0].postMessage).toHaveBeenCalledTimes(1);
    if (!expires) {
      TestWorker.instances[0].reply({ kind: "chemistry3d-result", result: embedded });
      expect(TestWorker.instances[0].postMessage).toHaveBeenLastCalledWith({ kind: "chemistry3d", id: expect.any(Number), job });
      await vi.advanceTimersByTimeAsync(9000);
      TestWorker.instances[0].reply({ kind: "chemistry3d-result", result: embedded });
    } else {
      await vi.advanceTimersByTimeAsync(10001);
      expect(TestWorker.instances[0].postMessage).toHaveBeenCalledTimes(1);
      expect(TestWorker.instances[1].postMessage).toHaveBeenCalledTimes(1);
    }
    await assertion;
    controllers.forEach(controller => controller.abort());
    await Promise.all(active);
  });
  it("component progress cannot extend the total embed deadline", async () => {
    const queued = runInConformerWorker({ method: "embed3d", request: { components: [{ smiles: "C" }, { smiles: "O" }] } }, new AbortController().signal);
    const failed = expect(queued).rejects.toThrow("embed3d timed out after 30 seconds including queue time.");
    await vi.advanceTimersByTimeAsync(29000);
    TestWorker.instances[0].reply({ kind: "chemistry3d-progress" });
    await vi.advanceTimersByTimeAsync(1000);
    await failed;
  });
});
