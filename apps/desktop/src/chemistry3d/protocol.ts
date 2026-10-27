import type { PluginEmbed3DRequest, PluginEmbed3DResult, PluginMinimize3DRequest, PluginMinimize3DResult,
  PluginFlatten3DRequest, PluginFlatten3DResult, Plugin3DMethod } from "@chemdraft/plugin-api";
import type { Chemistry3dTiming, Chemistry3dTimingSink } from "./timing";

export type Chemistry3dJob =
  | { method: "embed3d"; request: PluginEmbed3DRequest }
  | { method: "minimize3d"; request: PluginMinimize3DRequest; provenance: Plugin3DMethod }
  | { method: "flatten3d"; request: PluginFlatten3DRequest; provenance: Plugin3DMethod };
export type Chemistry3dResult = PluginEmbed3DResult | PluginMinimize3DResult | PluginFlatten3DResult;
export type Chemistry3dWorkRequest = { kind: "chemistry3d"; id: number; job: Chemistry3dJob; profile?: boolean };
/** Shared page/worker clock, diagnostic only; never part of a chemistry result. */
export interface Chemistry3dTransportTrace {
  workerReceivedAtEpochMs: number;
  workerPostedAtEpochMs: number;
}
type Chemistry3dWorkReply = { kind: "chemistry3d-ready" } | { kind: "chemistry3d-progress" } |
  { kind: "chemistry3d-timing"; timing: Chemistry3dTiming } |
  { kind: "chemistry3d-result"; result: Chemistry3dResult; transportTrace?: Chemistry3dTransportTrace } | { kind: "chemistry3d-error"; message: string };
export type Chemistry3dWorkResponse = Chemistry3dWorkReply & { id: number };

/** All reply paths, including import/engine failures, carry the originating job's id. */
export async function handleChemistry3dRequest(request: Chemistry3dWorkRequest,
  post: (message: Chemistry3dWorkResponse) => void): Promise<void> {
  const workerReceivedAtEpochMs = request.profile ? performance.timeOrigin + performance.now() : 0;
  const send = (reply: Chemistry3dWorkReply) => post({ ...reply, id: request.id });
  try {
    const result = await runChemistry3dJob(request.job, () => send({ kind: "chemistry3d-progress" }),
      request.profile ? timing => send({ kind: "chemistry3d-timing", timing }) : undefined,
      () => send({ kind: "chemistry3d-ready" }));
    // No await/timer/cleanup between this clock and the actual result postMessage.
    send({ kind: "chemistry3d-result", result, ...(request.profile ? { transportTrace: {
      workerReceivedAtEpochMs, workerPostedAtEpochMs: performance.timeOrigin + performance.now()
    } } : {}) });
  } catch (error) {
    send({ kind: "chemistry3d-error", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function runChemistry3dJob(job: Chemistry3dJob, progress?: () => void, timing?: Chemistry3dTimingSink, ready?: () => void): Promise<Chemistry3dResult> {
  if (timing) {
    const started = performance.now();
    try {
      const { profileChemistry3d } = await import("./timing");
      timing({ stage: "worker.module.timing-import", ms: performance.now() - started });
      return await profileChemistry3d(sink => execute(job, progress, sink, ready), timing);
    } finally {
      // Includes dynamic imports, WASM initialization, computation and streaming timing sends.
      // Ends before the terminal result's postMessage/structured clone.
      timing({ stage: "worker.protocol-total", ms: performance.now() - started });
    }
  }
  return execute(job, progress, undefined, ready);
}

async function execute(job: Chemistry3dJob, progress?: () => void, timing?: Chemistry3dTimingSink, ready?: () => void): Promise<Chemistry3dResult> {
  const importing = timing ? performance.now() : 0;
  const engine = await import("./engine");
  timing?.({ stage: "worker.module.engine-import", ms: performance.now() - importing });
  const initializing = timing ? performance.now() : 0;
  await engine.initializeChemistry3dWorker();
  timing?.({ stage: "worker.initialize", ms: performance.now() - initializing });
  ready?.();
  switch (job.method) {
    case "embed3d": return engine.embed3dInWorker(job.request, progress, timing);
    case "minimize3d": return engine.minimize3dInWorker(job.request, job.provenance, timing);
    case "flatten3d": return engine.flatten3dInWorker(job.request, job.provenance, timing);
  }
}
