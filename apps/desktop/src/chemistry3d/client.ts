import {
  PluginEmbed3DRequestSchema, PluginMinimize3DRequestSchema, PluginFlatten3DRequestSchema,
  type PluginEmbed3DResult, type PluginMinimize3DResult, type PluginFlatten3DResult
} from "@chemdraft/plugin-api";
import type { PluginHostOptions } from "@chemdraft/plugin-host";
import { chemistry3dTimeoutMs, CHEMISTRY3D_STARTUP_TIMEOUT_MS, pauseChemistry3dDeadlineForStartup } from "@chemdraft/plugin-host";
import { chemistry3dMethod } from "./method";
import { assertFlattenContacts } from "./model";
import { perfProbeRequestedFromWindow } from "../perf/gate";
import { perfHook } from "../perf/runtime";
import { ModelTokenAuthority, sessionModelTokens } from "./token";
import type { Chemistry3dJob, Chemistry3dResult, Chemistry3dWorkResponse } from "./protocol";
import type { Chemistry3dTimingSink } from "./timing";
import { timeHost3d, timeHost3dAsync } from "./hostTiming";

export type Chemistry3dTransport = (job: Chemistry3dJob, signal: AbortSignal) => Promise<Chemistry3dResult>;
export type Chemistry3dProviders = Required<Pick<PluginHostOptions, "embed3d" | "minimize3d" | "flatten3d">>;
export type Chemistry3dReplyLogger = (reply: {
  workerSlot: number;
  replyJobId: number | undefined;
  waitingJobId: number | undefined;
  method: Chemistry3dJob["method"] | undefined;
  kind: string | undefined;
  accepted: boolean;
  resultKeys: string[];
  hostReceivedAtEpochMs?: number;
  workerReceivedAtEpochMs?: number;
  workerPostedAtEpochMs?: number;
}) => void;

// Never reuse an id, even across pool disposal/recreation in the same app session.
let nextChemistry3dJobId = 1;

/** Two lazy, reusable RDKit workers, isolated from the user's live Spin worker.
 * Work timers start on enqueue, pause for bounded cold startup, and resume on RDKit readiness.
 * A timeout/cancellation destroys that worker, interrupting
 * synchronous WASM; successful calls retain its already-loaded engine. */
export function createConformerWorkerPool(options?: { onTiming?: Chemistry3dTimingSink; replyLogger?: Chemistry3dReplyLogger;
  /** Diagnostic/test injection; normal callers use the production module-worker entry below. */
  createWorker?: () => Worker }): { run: Chemistry3dTransport; dispose(): void } {
  interface Slot { worker: Worker; initialized?: boolean; task?: Task }
  interface Task { method: Chemistry3dJob["method"]; start(slot: Slot): void; receive(message: Chemistry3dWorkResponse, workerSlot: number, hostReceivedAtEpochMs?: number): void; cancel(): void; fail(error: Error): void }
  const slots: Slot[] = [];
  const queue: Task[] = [];
  let disposed = false;
  let pumping = false;
  const pump = () => {
    if (pumping) return;
    pumping = true;
    try {
      while (!disposed && queue.length) {
        let slot = slots.find(candidate => !candidate.task);
        if (!slot) {
          if (slots.length >= 2) return;
          // Construction errors must reject the queued call, not escape a reply handler.
          let worker: Worker;
          try { worker = options?.createWorker?.() ?? new Worker(new URL("../conformerWorker.ts", import.meta.url), { type: "module" }); }
          catch (error) { queue.shift()!.fail(error instanceof Error ? error : new Error(String(error))); continue; }
          slot = { worker };
          // Keep one handler for the worker's lifetime. Replacing onmessage during
          // finish/pump lets an already-dispatched reply reach the next task on reuse.
          const ownedSlot = slot;
          worker.onmessage = event => {
            // Capture at entry, before logging, filtering, timing sinks or promise resolution.
            const hostReceivedAtEpochMs = options?.onTiming ? performance.timeOrigin + performance.now() : undefined;
            const task = ownedSlot.task;
            if (!task) {
              if (options?.replyLogger) {
                try {
                  const message = event.data as Chemistry3dWorkResponse;
                  const result = message?.kind === "chemistry3d-result" ? message.result : undefined;
                  options.replyLogger({
                    workerSlot: slots.indexOf(ownedSlot),
                    replyJobId: message?.id,
                    waitingJobId: undefined,
                    method: undefined,
                    kind: message?.kind,
                    accepted: false,
                    resultKeys: result !== null && typeof result === "object" ? Object.keys(result) : [],
                    ...(hostReceivedAtEpochMs === undefined ? {} : { hostReceivedAtEpochMs }),
                    ...(message?.kind === "chemistry3d-result" ? message.transportTrace : {})
                  });
                } catch { /* Logging must never escape a worker event handler. */ }
              }
              return;
            }
            task.receive(event.data, slots.indexOf(ownedSlot), hostReceivedAtEpochMs);
          };
          worker.onerror = event => {
            const task = ownedSlot.task;
            task?.fail(new Error(`${task.method} worker failed: ${event.message}`));
          };
          slots.push(slot);
        }
        const task = queue.shift()!;
        slot.task = task;
        task.start(slot);
      }
    } finally { pumping = false; }
  };
  const run: Chemistry3dTransport = (job, signal) => new Promise((resolve, reject) => {
    const profiling = options?.onTiming !== undefined;
    const started = profiling ? performance.now() : 0;
    signal.throwIfAborted();
    if (disposed) throw new Error("3D chemistry worker pool is closed.");
    const id = nextChemistry3dJobId++;
    const timeout = chemistry3dTimeoutMs(job.method, job.method === "embed3d" ? job.request.components.length : 1);
    let timer: ReturnType<typeof setTimeout>;
    const enqueuedAt = Date.now();
    let resumeOuterStartup: (() => void) | undefined;
    let remaining = timeout;
    let slot: Slot | undefined;
    let postedAt: number | undefined;
    let hostPostedAtEpochMs: number | undefined;
    let finished = false;
    const finish = (result?: Chemistry3dResult, error?: Error) => {
      if (finished) return;
      finished = true;
      if (postedAt !== undefined) options?.onTiming?.({ stage: `host.${job.method}.worker-roundtrip`, ms: performance.now() - postedAt });
      options?.onTiming?.({ stage: `host.${job.method}.roundtrip`, ms: performance.now() - started });
      clearTimeout(timer);
      resumeOuterStartup?.();
      signal.removeEventListener("abort", abort);
      const waiting = queue.indexOf(task);
      if (waiting >= 0) queue.splice(waiting, 1);
      if (slot) {
        slot.task = undefined;
        if (error) {
          slot.worker.terminate();
          const index = slots.indexOf(slot);
          if (index >= 0) slots.splice(index, 1);
        }
      }
      if (error) reject(error); else resolve(result!);
      pump();
    };
    const arm = (ms: number) => { clearTimeout(timer); timer = setTimeout(() => finish(undefined,
      new Error(`${job.method} timed out after ${timeout / 1000} seconds including queue time.`)), ms); };
    const abort = () => finish(undefined, new Error(`chemistry.${job.method} cancelled because the plugin command ended.`));
    const task: Task = { method: job.method, cancel: abort, fail: error => finish(undefined, error), receive: (message, workerSlot, hostReceivedAtEpochMs) => {
      // Kind alone identifies the protocol, not the job. Filter *every* reply,
      // including timing/errors, before it can affect the active task.
      const accepted = !finished && message?.id === id;
      if (options?.replyLogger) {
        try {
          const result = message?.kind === "chemistry3d-result" ? message.result : undefined;
          options.replyLogger({
            workerSlot,
            replyJobId: message?.id,
            waitingJobId: id,
            method: job.method,
            kind: message?.kind,
            accepted,
            resultKeys: result !== null && typeof result === "object" ? Object.keys(result) : [],
            ...(hostReceivedAtEpochMs === undefined ? {} : { hostReceivedAtEpochMs }),
            ...(message?.kind === "chemistry3d-result" ? message.transportTrace : {})
          });
        } catch { /* Diagnostics must never affect reply delivery. */ }
      }
      if (!accepted) return;
      if (message.kind === "chemistry3d-ready") {
        if (slot && !slot.initialized) {
          slot.initialized = true;
          resumeOuterStartup?.();
          resumeOuterStartup = undefined;
          arm(remaining);
        }
        return;
      }
      if (message.kind === "chemistry3d-timing") { options?.onTiming?.(message.timing); return; }
      if (message.kind === "chemistry3d-error") finish(undefined, new Error(message.message));
      else if (message.kind === "chemistry3d-result") {
        const trace = message.transportTrace;
        if (trace && hostPostedAtEpochMs !== undefined && hostReceivedAtEpochMs !== undefined) {
          const details = { hostPostedAtEpochMs, ...trace, hostReceivedAtEpochMs };
          options?.onTiming?.({ stage: `host.${job.method}.request-delivery`,
            ms: trace.workerReceivedAtEpochMs - hostPostedAtEpochMs, details });
          options?.onTiming?.({ stage: `host.${job.method}.result-delivery`,
            ms: hostReceivedAtEpochMs - trace.workerPostedAtEpochMs, details });
          options?.onTiming?.({ stage: `host.${job.method}.reply-dispatch`,
            ms: performance.timeOrigin + performance.now() - hostReceivedAtEpochMs });
        }
        finish(message.result);
      }
    }, start: assigned => {
      slot = assigned;
      if (!slot.initialized) {
        remaining = Math.max(0, timeout - (Date.now() - enqueuedAt));
        clearTimeout(timer);
        resumeOuterStartup = pauseChemistry3dDeadlineForStartup(signal);
        timer = setTimeout(() => finish(undefined, new Error(
          `${job.method} worker startup timed out after ${CHEMISTRY3D_STARTUP_TIMEOUT_MS / 1000} seconds.`)), CHEMISTRY3D_STARTUP_TIMEOUT_MS);
      }
      options?.onTiming?.({ stage: `host.${job.method}.queue+worker-construction`, ms: performance.now() - started });
      const worker = slot.worker;
      try {
        const posting = profiling ? performance.now() : 0;
        if (profiling) { postedAt = posting; hostPostedAtEpochMs = performance.timeOrigin + posting; }
        worker.postMessage({ kind: "chemistry3d", id, job, ...(profiling ? { profile: true } : {}) });
        options?.onTiming?.({ stage: `host.${job.method}.postMessage`, ms: performance.now() - posting });
      }
      catch (error) { finish(undefined, error instanceof Error ? error : new Error(String(error))); }
    } };
    signal.addEventListener("abort", abort, { once: true });
    arm(timeout);
    queue.push(task);
    pump();
  });
  return { run, dispose() {
    disposed = true;
    for (const task of [...queue, ...slots.flatMap(slot => slot.task ? [slot.task] : [])]) task.cancel();
    for (const slot of slots) slot.worker.terminate();
    slots.length = 0;
  } };
}

/** The reply log shares the #212 timing probe's existing agent-bridge gate. */
export function chemistry3dReplyLogRequestedFromWindow(): boolean {
  return typeof window !== "undefined" && perfHook(() => perfProbeRequestedFromWindow()) === true;
}

export function chemistry3dReplyLoggerFromWindow(): Chemistry3dReplyLogger | undefined {
  if (!chemistry3dReplyLogRequestedFromWindow()) return undefined;
  return reply => console.info("[chemistry3d reply]", reply);
}

// Vite replaces this flag at build time. With it unset there are no profiling clocks, timing
// messages, WASM binding wrappers or diagnostic console output on normal jobs.
export const runInConformerWorker: Chemistry3dTransport = createConformerWorkerPool(
  (() => {
    const replyLogger = chemistry3dReplyLoggerFromWindow();
    const timing = import.meta.env?.VITE_CHEMDRAFT_PROFILE_3D === "1";
    return timing || replyLogger ? {
      ...(timing ? { onTiming: (event: Parameters<Chemistry3dTimingSink>[0]) => console.debug("[chemistry3d timing]", event) } : {}),
      ...(replyLogger ? { replyLogger } : {})
    } : undefined;
  })()
).run;

export function createChemistry3dProviders(run: Chemistry3dTransport = runInConformerWorker,
  tokens: ModelTokenAuthority = sessionModelTokens, onTiming?: Chemistry3dTimingSink): Chemistry3dProviders {
  return {
    embed3d: async (input, signal) => {
      const request = timeHost3d(onTiming, "host.embed3d.request-schema", () => PluginEmbed3DRequestSchema.parse(input));
      signal.throwIfAborted();
      const result = await run({ method: "embed3d", request }, signal) as PluginEmbed3DResult;
      signal.throwIfAborted();
      const model = { ...result.model, modelToken: await timeHost3dAsync(onTiming, "host.embed3d.token-sign", () => tokens.sign(result.model, request.seed ?? 42)) };
      signal.throwIfAborted();
      return { ...result, model };
    },
    minimize3d: async (input, signal) => {
      const request = timeHost3d(onTiming, "host.minimize3d.request-schema", () => PluginMinimize3DRequestSchema.parse(input));
      signal.throwIfAborted();
      const { model, seed } = await timeHost3dAsync(onTiming, "host.minimize3d.token-verify", () => tokens.verify(request.model));
      signal.throwIfAborted();
      const result = await run({ method: "minimize3d", request: { ...request, model }, provenance: chemistry3dMethod(seed) }, signal) as PluginMinimize3DResult;
      signal.throwIfAborted();
      return result;
    },
    flatten3d: async (input, signal) => {
      const request = timeHost3d(onTiming, "host.flatten3d.request-schema", () => PluginFlatten3DRequestSchema.parse(input));
      signal.throwIfAborted();
      const { model, seed } = await timeHost3dAsync(onTiming, "host.flatten3d.token-verify", () => tokens.verify(request.model));
      signal.throwIfAborted();
      timeHost3d(onTiming, "host.flatten3d.clash-screen", () => assertFlattenContacts(model));
      const result = await run({ method: "flatten3d", request: { ...request, model }, provenance: chemistry3dMethod(seed) }, signal) as PluginFlatten3DResult;
      signal.throwIfAborted();
      return result;
    }
  };
}
