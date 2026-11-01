import { afterEach, expect, it, vi } from "vitest";
import { beginWorkerActivity, installWorkerActivityTimers, profileWorkerActivity, recordWorkerEntryEvaluation } from "../workers/entryEvaluation";
import { WorkerProfiles } from "./workerProfiles";

const keys = ["workerActivity", "workerEntryEvaluations", "workerEntryProfileListener"];
function setWorkerProfileFlag(value: string): void {
  vi.stubEnv("CHEMDRAFT_WKPROFILE", value);
  Object.assign(import.meta.env, { CHEMDRAFT_WKPROFILE: value });
}

afterEach(() => {
  for (const key of keys) Reflect.deleteProperty(globalThis, Symbol.for(`org.chemdraft.${key}`));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("does not read a clock or wrap promises outside the profiler build", async () => {
  setWorkerProfileFlag("");
  const now = vi.spyOn(performance, "now");
  const result = Promise.resolve(3);
  expect(beginWorkerActivity("worker.warmup")).toBeUndefined();
  expect(profileWorkerActivity("worker.warmup", () => result)).toBe(result);
  const work = vi.fn(() => result);
  expect(profileWorkerActivity("worker.warmup", work)).toBe(result);
  expect(work).toHaveBeenCalledOnce();
  recordWorkerEntryEvaluation("conformer", "test:worker");
  expect(now).not.toHaveBeenCalled();
  expect(Reflect.get(globalThis, Symbol.for("org.chemdraft.workerActivity"))).toBeUndefined();
  expect(Reflect.get(globalThis, Symbol.for("org.chemdraft.workerEntryEvaluations"))).toBeUndefined();
  await result;
});

it("snapshots shared-clock background spans even when there is no active chemistry request", async () => {
  setWorkerProfileFlag("1");
  const endpoint = new EventTarget();
  vi.stubGlobal("addEventListener", endpoint.addEventListener.bind(endpoint));
  const now = vi.spyOn(performance, "now").mockReturnValue(10);
  recordWorkerEntryEvaluation("conformer", "test:worker");
  const finish = beginWorkerActivity("worker.scheduler.warmup", { requestId: 4 });
  now.mockReturnValue(1010);
  finish?.();
  await expect(profileWorkerActivity("worker.warmup.failure", async () => { throw new Error("test failure"); }))
    .rejects.toThrow("test failure");
  beginWorkerActivity("worker.unfinished");

  const worker = new EventTarget() as EventTarget & { postMessage(message: unknown): void };
  worker.postMessage = data => { endpoint.dispatchEvent(new MessageEvent("message", { data })); };
  vi.stubGlobal("postMessage", (data: unknown) => { worker.dispatchEvent(new MessageEvent("message", { data })); });
  const profiles = new WorkerProfiles();
  profiles.track(worker as Worker);
  await profiles.snapshot();
  expect(profiles.activity).toEqual([
    { worker: "conformer", stage: "worker.scheduler.warmup", startedAtEpochMs: performance.timeOrigin + 10,
      endedAtEpochMs: performance.timeOrigin + 1010, details: { requestId: 4 } },
    { worker: "conformer", stage: "worker.warmup.failure", startedAtEpochMs: performance.timeOrigin + 1010,
      endedAtEpochMs: performance.timeOrigin + 1010 },
    { worker: "conformer", stage: "worker.unfinished", startedAtEpochMs: performance.timeOrigin + 1010 }
  ]);
});

it("records dependency timer and microtask execution without scheduling extra work", () => {
  setWorkerProfileFlag("1");
  const setTimeout = vi.fn();
  const setInterval = vi.fn();
  const queueMicrotask = vi.fn();
  const scope = { setTimeout, setInterval, queueMicrotask } as unknown as Parameters<typeof installWorkerActivityTimers>[0];
  installWorkerActivityTimers(scope);
  installWorkerActivityTimers(scope);
  expect(setTimeout).not.toHaveBeenCalled();
  expect(setInterval).not.toHaveBeenCalled();
  expect(queueMicrotask).not.toHaveBeenCalled();
  const callback = vi.fn();
  scope.setTimeout(callback, 12, "argument");
  expect(setTimeout).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 12, "argument");
  setTimeout.mock.calls[0][0]("argument");
  expect(callback).toHaveBeenCalledWith("argument");
  const failure = () => { throw new Error("callback failure"); };
  scope.queueMicrotask(failure);
  expect(() => queueMicrotask.mock.calls[0][0]()).toThrow("callback failure");
  const activity = Reflect.get(globalThis, Symbol.for("org.chemdraft.workerActivity"));
  expect(activity).toEqual([
    expect.objectContaining({ stage: "worker.callback.setTimeout", endedAtEpochMs: expect.any(Number),
      details: expect.objectContaining({ delayMs: 12, scheduledAtEpochMs: expect.any(Number) }) }),
    expect.objectContaining({ stage: "worker.callback.queueMicrotask", endedAtEpochMs: expect.any(Number) })
  ]);
});
