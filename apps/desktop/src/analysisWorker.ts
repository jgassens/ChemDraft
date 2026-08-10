/**
 * Structure-analysis Web Worker (PLANS.md §5).
 *
 * "Persistent, so the engine is not re-initialized per call." That is the whole reason this exists: the
 * vendored RDKit MinimalLib is a 7.5 MB WASM module whose first instantiation costs a few hundred
 * milliseconds, and paying that on every keystroke would make the Analyze panel unusable. The module
 * loads once, on the first request, and stays resident for the session.
 *
 * Separate from `conformerWorker.ts` on purpose: 3D embedding is a long, single job the user waits for,
 * while analysis is a short job fired repeatedly as the structure changes. Sharing a worker would let
 * an embed block a descriptor pass.
 *
 * Core analysis runs here rather than through `PluginWorkerBridge` — the plugin bridge is the isolation
 * precedent, not the transport. Plugins are sandboxed because they are untrusted; the core engine is
 * not, and routing it through a permission-gated host context would buy nothing.
 *
 * Cancellation is cooperative and coarse. `analyzeStructure` is one synchronous WASM call per method
 * with no yield points the worker can interrupt, so a cancel that arrives mid-run does not stop it —
 * it stops the *reply*. The main thread has already moved on, and the scheduler discards the answer.
 * Honest limits beat a cancellation that pretends to be pre-emptive.
 */
import { analyzeStructure, type AnalyzeStructureRequest } from "@chemdraft/rdkit-adapter";
import type { AnalysisRun } from "@chemdraft/analysis-core";

import { registerIsoSpecWasmLoader } from "./isospecWasmLoader";
import { registerRdkitWasmLoader } from "./rdkitWasmLoader";

export interface AnalysisWorkRequest {
  kind: "analyze" | "cancel" | "warmup";
  id: number;
  request?: Omit<AnalyzeStructureRequest, "runId" | "startedAt"> & { runId: string; startedAt: string };
}

export interface AnalysisWorkResponse {
  id: number;
  kind: "run" | "error" | "ready";
  run?: AnalysisRun;
  message?: string;
}

/** Ids the main thread has abandoned. Checked before replying, never mid-computation. */
const cancelled = new Set<number>();

/**
 * Bound the abandoned-id set. A session can produce thousands of superseded requests, and the set is
 * only consulted once per reply, so anything older than the recent window is dead weight.
 */
const MAX_TRACKED_CANCELLATIONS = 256;

function markCancelled(id: number): void {
  cancelled.add(id);
  while (cancelled.size > MAX_TRACKED_CANCELLATIONS) {
    const oldest = cancelled.values().next();
    if (oldest.done) break;
    cancelled.delete(oldest.value);
  }
}

let loaderRegistered = false;

function ensureLoader(): void {
  if (loaderRegistered) return;
  registerRdkitWasmLoader();
  // Registering is not loading: the adapter instantiates IsoSpec only when a run asks for the isotope
  // envelope. Without this the envelope declines with "engine not available" on every structure.
  registerIsoSpecWasmLoader();
  loaderRegistered = true;
}

async function handle(message: AnalysisWorkRequest): Promise<void> {
  const { kind, id } = message;

  if (kind === "cancel") {
    markCancelled(id);
    return;
  }

  ensureLoader();

  if (kind === "warmup") {
    // Instantiate the module and run one trivial analysis so the WASM load, the embind bootstrap, and
    // the JIT all happen before the user's first real request.
    try {
      await analyzeStructure({
        format: "smiles",
        value: "C",
        runId: "warmup",
        startedAt: new Date().toISOString(),
        methodIds: ["rdkit.composition"]
      });
      self.postMessage({ id, kind: "ready" } satisfies AnalysisWorkResponse);
    } catch (error) {
      self.postMessage({
        id,
        kind: "error",
        message: error instanceof Error ? error.message : String(error)
      } satisfies AnalysisWorkResponse);
    }
    return;
  }

  if (!message.request) {
    self.postMessage({ id, kind: "error", message: "Analysis request carried no payload." } satisfies AnalysisWorkResponse);
    return;
  }

  try {
    const run = await analyzeStructure(message.request);
    if (cancelled.delete(id)) return;
    // `run` carries typed arrays for any bulk channel; structured clone moves them intact (§3).
    self.postMessage({ id, kind: "run", run } satisfies AnalysisWorkResponse);
  } catch (error) {
    if (cancelled.delete(id)) return;
    self.postMessage({
      id,
      kind: "error",
      message: error instanceof Error ? error.message : String(error)
    } satisfies AnalysisWorkResponse);
  }
}

self.addEventListener("message", (event: MessageEvent<AnalysisWorkRequest>) => {
  void handle(event.data);
});
