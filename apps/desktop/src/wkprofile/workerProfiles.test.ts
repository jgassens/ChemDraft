import { afterEach, expect, it, vi } from "vitest";
import { WorkerProfiles, workerReply } from "./workerProfiles";
import { recordWorkerEntryEvaluation } from "../workers/entryEvaluation";

function setWorkerProfileFlag(value: string): void {
  vi.stubEnv("CHEMDRAFT_WKPROFILE", value);
  Object.assign(import.meta.env, { CHEMDRAFT_WKPROFILE: value });
}

const counterKey = Symbol.for("org.chemdraft.workerEntryEvaluations");
const listenerKey = Symbol.for("org.chemdraft.workerEntryProfileListener");
afterEach(() => {
  Reflect.deleteProperty(globalThis, counterKey);
  Reflect.deleteProperty(globalThis, listenerKey);
  Reflect.deleteProperty(globalThis, Symbol.for("org.chemdraft.workerActivity"));
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("counts reevaluations across distinct module instances on the same worker global", async () => {
  setWorkerProfileFlag("1");
  const add = vi.fn();
  vi.stubGlobal("addEventListener", add);
  vi.resetModules();
  const { recordWorkerEntryEvaluation: record } = await import("../workers/entryEvaluation");
  record("conformer", "http://localhost/assets/worker.js");
  vi.resetModules();
  const otherInstance = await import("../workers/entryEvaluation");
  otherInstance.recordWorkerEntryEvaluation("conformer", "http://localhost/assets/worker.js");
  expect(Reflect.get(globalThis, counterKey).conformer.evaluations).toBe(2);
  expect(add).toHaveBeenCalledOnce();
});

it("exposes the latest counters only in profiler builds and keeps probes out of chemistry handlers", () => {
  setWorkerProfileFlag("1");
  const workerScope = new EventTarget();
  vi.stubGlobal("addEventListener", workerScope.addEventListener.bind(workerScope));
  const post = vi.fn();
  vi.stubGlobal("postMessage", post);
  const chemistry = vi.fn();
  recordWorkerEntryEvaluation("depiction2d", "http://localhost/assets/worker.js");
  recordWorkerEntryEvaluation("depiction2d", "http://localhost/assets/worker.js");
  workerScope.addEventListener("message", chemistry);
  workerScope.dispatchEvent(new MessageEvent("message", { data: { kind: "chemdraft-worker-profile-request", requestId: 7 } }));
  expect(post).toHaveBeenCalledExactlyOnceWith({ kind: "chemdraft-worker-profile", requestId: 7,
    entries: [{ worker: "depiction2d", entryUrl: "http://localhost/assets/worker.js", evaluations: 2 }] });
  expect(chemistry).not.toHaveBeenCalled();
  workerScope.dispatchEvent(new MessageEvent("message", { data: { kind: "analyze" } }));
  expect(chemistry).toHaveBeenCalledOnce();
});

it("does not record worker entries when the profiler flag is off", () => {
  setWorkerProfileFlag("");
  recordWorkerEntryEvaluation("conformer", "http://localhost/assets/worker.js");
  expect(Reflect.get(globalThis, counterKey)).toBeUndefined();
  expect(Reflect.get(globalThis, listenerKey)).toBeUndefined();
});

class TestWorker extends EventTarget {
  terminate = vi.fn();
  send: (request: { requestId: number }) => void = request => this.dispatchEvent(new MessageEvent("message", { data: {
    kind: "chemdraft-worker-profile", requestId: request.requestId,
    entries: [{ worker: "conformer", entryUrl: "http://localhost/entry.js", evaluations: 1 }]
  } }));
  postMessage(request: { requestId: number }): void { this.send(request); }
}

it("snapshots after lazy work, ignores unrelated replies and disposes each tracked worker", async () => {
  const profiles = new WorkerProfiles();
  const worker = new TestWorker();
  profiles.track(worker as unknown as Worker);
  expect(await profiles.snapshot()).toEqual([{ worker: "conformer", entryUrl: "http://localhost/entry.js", evaluations: 1 }]);
  worker.send = () => {
    worker.dispatchEvent(new MessageEvent("message", { data: { id: 2 } }));
    worker.dispatchEvent(new MessageEvent("message", { data: { id: 1, value: "real result" } }));
  };
  expect(await workerReply<{ id: number; value: string }>(worker as unknown as Worker, {}, reply => reply.id === 1))
    .toEqual({ id: 1, value: "real result" });
  profiles.dispose();
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it("fails explicitly instead of reporting zero when a worker never answers the counter query", async () => {
  vi.useFakeTimers();
  const profiles = new WorkerProfiles();
  const worker = new TestWorker();
  worker.send = () => undefined;
  profiles.track(worker as unknown as Worker);
  const assertion = expect(profiles.snapshot()).rejects.toThrow("did not report entry evaluations");
  await vi.advanceTimersByTimeAsync(5000);
  await assertion;
});
