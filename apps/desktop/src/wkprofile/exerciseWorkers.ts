import { PluginHost } from "@chemdraft/plugin-host";
import { PluginManifestSchema } from "@chemdraft/plugin-api";
import { createDepictionWorkerClient, type DepictionWorkerPort } from "@chemdraft/rdkit-adapter/depiction";
import { massAnalyzeCommandId, massFragmentManifest, massFragmentPanelId } from "@chemdraft/plugin-mass-fragment";
import type { PluginWorkerHandle, PluginCommandResult } from "@chemdraft/plugin-api";
import type { AnalysisWorkResponse } from "../analysisWorkerRuntime";
import type { PasteDepiction } from "../depiction2d/depict";
import { PluginWorkerBridge } from "../plugins/PluginWorkerBridge";
import { workerReply, type WorkerProfiles } from "./workerProfiles";

export function createMassFragmentExerciseManifest() {
  return PluginManifestSchema.parse({
    ...massFragmentManifest,
    contributes: {
      ...massFragmentManifest.contributes,
      panels: [...massFragmentManifest.contributes.panels]
    },
    permissions: [...new Set([...massFragmentManifest.permissions, "ui.panel"])]
  });
}

/** Exercise lazy chunks through real transports before reading the evaluation counters. */
export async function exerciseOtherWorkers(profiles: WorkerProfiles) {
  const results: Record<string, unknown> = {};
  const analysis = profiles.track(new Worker(new URL("../analysisWorker.ts", import.meta.url), { type: "module" }));
  const analyzed = await workerReply<AnalysisWorkResponse>(analysis, { kind: "analyze", id: 1,
    request: { format: "smiles", value: "CCO", runId: "wkprofile", startedAt: new Date().toISOString(), methodIds: ["rdkit.composition"] }
  }, reply => reply.id === 1);
  if (analyzed.kind !== "run") throw new Error(`Analysis profile failed: ${analyzed.message ?? analyzed.kind}`);
  results.analysis = { status: "ok" };

  const depict = createDepictionWorkerClient<PasteDepiction>(() =>
    Object.assign(profiles.track(new Worker(new URL("../depiction2d/worker.ts", import.meta.url), { type: "module" })),
      { initializing: true }) as unknown as DepictionWorkerPort<PasteDepiction>);
  const depiction = await depict("CCO");
  results.depiction2d = { status: "ok", atoms: depiction.depiction.atoms.length, warnings: depiction.warnings ?? [] };

  // Both bundled entry variants, including the Windows bootstrap's ordering. The custom-origin
  // nested-worker shim is a no-op on loopback; its WebView2 behavior still needs Windows testing.
  for (const windows of [false, true]) {
    const worker = profiles.track(windows
      ? new Worker(new URL("../plugins/workers/windowsMassFragmentPluginWorker.ts", import.meta.url), { type: "module" })
      : new Worker(new URL("../plugins/workers/massFragmentPluginWorker.ts", import.meta.url), { type: "module" }));
    const bridge = new PluginWorkerBridge({ pluginId: massFragmentManifest.id,
      createWorker: () => worker as unknown as PluginWorkerHandle });
    let records = 0;
    let reports = 0;
    // In-memory diagnostic document, using the actual permission-gated host and bridge.
    const host = new PluginHost({ getSelection: () => ({ objectIds: ["ethanol"], molecules: [{
      objectId: "ethanol", documentId: "wkprofile", pageId: "page", sourceFingerprint: "wkprofile-ethanol",
      structure: "CCO", structureFormat: "smiles"
    }] }), showPanelReport: async () => { reports++; } });
    host.registerPlugin(createMassFragmentExerciseManifest(), { commandHandlers: { [massAnalyzeCommandId]: async context => {
      const result = await bridge.invokeCommand(massAnalyzeCommandId, context) as PluginCommandResult;
      if (!result.ok) throw new Error(`Analyzer profile failed: ${result.error.message}`);
      records++;
      return result;
    } } });
    // A real invocation forces the massAnalysis lazy import; a handshake alone missed the old cycle.
    await host.invokeCommand(massAnalyzeCommandId);
    results[windows ? "mass-fragment-windows" : "mass-fragment"] = { status: "ok", commands: records, reports };
    // Keep the bridge alive until WorkerProfiles takes its final snapshot; dispose terminates all workers.
  }
  return results;
}
