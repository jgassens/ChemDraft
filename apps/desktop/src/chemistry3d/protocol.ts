import type { PluginEmbed3DRequest, PluginEmbed3DResult, PluginMinimize3DRequest, PluginMinimize3DResult,
  PluginFlatten3DRequest, PluginFlatten3DResult, Plugin3DMethod } from "@chemdraft/plugin-api";
import type { Chemistry3dTiming, Chemistry3dTimingSink } from "./timing";

export type Chemistry3dJob =
  | { method: "embed3d"; request: PluginEmbed3DRequest }
  | { method: "minimize3d"; request: PluginMinimize3DRequest; provenance: Plugin3DMethod }
  | { method: "flatten3d"; request: PluginFlatten3DRequest; provenance: Plugin3DMethod };
export type Chemistry3dResult = PluginEmbed3DResult | PluginMinimize3DResult | PluginFlatten3DResult;
export type Chemistry3dWorkRequest = { kind: "chemistry3d"; id: number; job: Chemistry3dJob; profile?: boolean };
type Chemistry3dWorkReply = { kind: "chemistry3d-ready" } | { kind: "chemistry3d-progress" } |
  { kind: "chemistry3d-timing"; timing: Chemistry3dTiming } |
  { kind: "chemistry3d-result"; result: Chemistry3dResult } | { kind: "chemistry3d-error"; message: string };
export type Chemistry3dWorkResponse = Chemistry3dWorkReply & { id: number };

/** All reply paths, including import/engine failures, carry the originating job's id. */
export async function handleChemistry3dRequest(request: Chemistry3dWorkRequest,
  post: (message: Chemistry3dWorkResponse) => void): Promise<void> {
  const send = (reply: Chemistry3dWorkReply) => post({ ...reply, id: request.id });
  try {
    const result = await runChemistry3dJob(request.job, () => send({ kind: "chemistry3d-progress" }),
      request.profile ? timing => send({ kind: "chemistry3d-timing", timing }) : undefined,
      () => send({ kind: "chemistry3d-ready" }));
    send({ kind: "chemistry3d-result", result });
  } catch (error) {
    send({ kind: "chemistry3d-error", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function runChemistry3dJob(job: Chemistry3dJob, progress?: () => void, timing?: Chemistry3dTimingSink, ready?: () => void): Promise<Chemistry3dResult> {
  if (timing) {
    const { profileChemistry3d } = await import("./timing");
    return profileChemistry3d(sink => execute(job, progress, sink, ready), timing);
  }
  return execute(job, progress, undefined, ready);
}

async function execute(job: Chemistry3dJob, progress?: () => void, timing?: Chemistry3dTimingSink, ready?: () => void): Promise<Chemistry3dResult> {
  const engine = await import("./engine");
  await engine.initializeChemistry3dWorker();
  ready?.();
  switch (job.method) {
    case "embed3d": return engine.embed3dInWorker(job.request, progress, timing);
    case "minimize3d": return engine.minimize3dInWorker(job.request, job.provenance, timing);
    case "flatten3d": return engine.flatten3dInWorker(job.request, job.provenance);
  }
}
