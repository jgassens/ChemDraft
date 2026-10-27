import {
  PluginEmbed3DRequestSchema, PluginMinimize3DRequestSchema, PluginFlatten3DRequestSchema,
  type PluginEmbed3DRequest, type PluginEmbed3DResult, type PluginMinimize3DRequest,
  type PluginMinimize3DResult, type PluginFlatten3DRequest, type PluginFlatten3DResult
} from "@chemdraft/plugin-api";
import { chemistry3dTimeoutMs } from "@chemdraft/plugin-host";
// Deliberate internal imports in this diagnostic page: execute the actual host queue and validator,
// including chem-core's DocumentObjectSchema, without replacing either with a benchmark facsimile.
import { Chemistry3dQueue } from "../../../../packages/plugin-host/src/chemistry3dQueue";
import { chemistry3dResultError } from "../../../../packages/plugin-host/src/chemistry3dResult";
import { createChemistry3dProviders, createConformerWorkerPool } from "../chemistry3d/client";
import { timeHost3d, timeHost3dAsync } from "../chemistry3d/hostTiming";
import { ModelTokenAuthority } from "../chemistry3d/token";
import { CBPQT, centerGuest, pegTtf } from "../chemistry3d/perfFixtures";
import type { Chemistry3dTiming, Chemistry3dTimingSink } from "../chemistry3d/timing";
import { summarizeStages, transportBreakdown, transportResidual } from "./report";
import { WorkerProfiles } from "./workerProfiles";
import { exerciseOtherWorkers } from "./exerciseWorkers";
import type { WorkerEntryEvaluation } from "../workers/entryEvaluation";

type Method = "embed3d" | "minimize3d" | "flatten3d";
type TimedEvent = Chemistry3dTiming & { observedAtMs: number };
interface Measurement {
  sample: number;
  method: Method;
  workerState: string;
  status: "running" | "ok" | "error";
  wallMs?: number;
  transportResidualMs?: number | null;
  transport?: ReturnType<typeof transportBreakdown>;
  stages?: ReturnType<typeof summarizeStages>;
  events: TimedEvent[];
  result?: Record<string, unknown>;
  error?: { message: string; stack?: string };
}

export async function runProfile(progress: (value: unknown) => void) {
  const started = performance.now();
  const measurements: Measurement[] = [];
  const setup: { sample: number; centerGuestMs: number }[] = [];
  const replies: unknown[] = [];
  const workerProfiles = new WorkerProfiles();
  let workers: WorkerEntryEvaluation[] = [];
  let workerExercises: Record<string, unknown> = {};
  let active: Measurement | undefined;
  let sequence = 0;
  const onTiming: Chemistry3dTimingSink = event => {
    active?.events.push({ ...event, observedAtMs: performance.now() - started });
  };
  const pool = createConformerWorkerPool({ onTiming,
    createWorker: () => workerProfiles.track(new Worker(new URL("../conformerWorker.ts", import.meta.url), { type: "module" })),
    replyLogger: reply => {
    replies.push({ ...reply, sample: active?.sample, observedAtMs: performance.now() - started });
  } });
  const providers = createChemistry3dProviders(pool.run, new ModelTokenAuthority(onTiming), onTiming);
  const queue = new Chemistry3dQueue();
  const pluginId = "org.chemdraft.wkprofile";

  // Match PluginHost.runChemistry3d's parse -> queue -> provider -> result check order.
  // Calling its shared parts directly lets us put clocks around both validation boundaries.
  // No plugin registration, command dispatch, document edit or plugin worker is simulated here.
  async function measure<T, R>(sample: number, method: Method, input: T, parse: (input: T) => T,
    provide: (input: T, signal: AbortSignal) => Promise<R>, summarize: (result: R) => Record<string, unknown>): Promise<R> {
    const record: Measurement = { sample, method,
      workerState: sample === 1 && method === "embed3d" ? "cold (first pool call)" : "reused (same pool, sequential calls)",
      status: "running", events: [] };
    active = record;
    measurements.push(record);
    progress({ stage: "method-start", sample, method, completedMethods: measurements.length - 1 });
    const start = performance.now();
    try {
      const request = timeHost3d(onTiming, `pluginHost.${method}.request-schema`, () => parse(input));
      const controller = new AbortController();
      const components = method === "embed3d" ? (request as PluginEmbed3DRequest).components.length : 1;
      const enqueued = performance.now();
      const result = await queue.run(pluginId, method, controller, chemistry3dTimeoutMs(method, components), signal => {
        onTiming({ stage: `pluginHost.${method}.queue-wait`, ms: performance.now() - enqueued });
        return timeHost3dAsync(onTiming, `host.${method}.provider-total`, () => provide(request, signal));
      });
      timeHost3d(onTiming, `pluginHost.${method}.result-validation`, () => {
        const error = chemistry3dResultError(method, result);
        if (error) throw new Error(error);
      });
      // Same envelope as PluginWorkerBridge.sendCapabilityValue. This is an isolated clone
      // benchmark, not a plugin-worker roundtrip; actual worker scheduling remains unmeasured.
      const bridged = timeHost3d(onTiming, `bridge.${method}.structuredClone`, () =>
        structuredClone({ kind: "capabilityResult", requestId: ++sequence, ok: true, value: result }));
      record.wallMs = performance.now() - start;
      record.status = "ok";
      record.result = summarize(bridged.value);
      return bridged.value;
    } catch (error) {
      record.wallMs = performance.now() - start;
      record.status = "error";
      record.error = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) };
      throw error;
    } finally {
      record.stages = summarizeStages(record.events);
      record.transportResidualMs = transportResidual(record.stages, method);
      record.transport = transportBreakdown(record.stages, method);
      active = undefined;
      progress({ stage: "method-finished", ...record });
    }
  }

  let failure: string | undefined;
  try {
    if (!isSecureContext || !crypto.subtle) throw new Error("WebCrypto requires a secure context; use the Swift runner's 127.0.0.1 HTTP origin.");
    for (let sample = 1; sample <= 3; sample++) {
      const embedded = await measure<PluginEmbed3DRequest, PluginEmbed3DResult>(sample, "embed3d",
        { components: [{ smiles: CBPQT }, { smiles: pegTtf(2) }], seed: 42 },
        input => PluginEmbed3DRequestSchema.parse(input), providers.embed3d,
        result => ({ atoms: result.model.atoms.length, components: result.model.components.length,
          method: result.method, warnings: result.warnings }));
      // Same centred fixture preparation as profile-flatten-jsc.mjs; token permits coordinate edits.
      const centering = performance.now();
      const model = centerGuest(embedded.model);
      setup.push({ sample, centerGuestMs: performance.now() - centering });
      const minimized = await measure<PluginMinimize3DRequest, PluginMinimize3DResult>(sample, "minimize3d",
        { model, forceField: "mmff94s", interfragment: true, maxIters: 20000 },
        input => PluginMinimize3DRequestSchema.parse(input), providers.minimize3d,
        result => ({ atoms: result.model.atoms.length, clash: result.clash,
          closestInterComponentHeavyAtomA: result.closestInterComponentHeavyAtomA,
          forceField: result.forceField, method: result.method, warnings: result.warnings }));
      await measure<PluginFlatten3DRequest, PluginFlatten3DResult>(sample, "flatten3d",
        { model: minimized.model, view: "auto" }, input => PluginFlatten3DRequestSchema.parse(input), providers.flatten3d,
        result => ({ objects: result.objects.length,
          retainedAtoms: result.depthByAtom.map(depths => depths.length), method: result.method, warnings: result.warnings }));
    }
    progress({ stage: "exercising-other-workers" });
    workerExercises = await exerciseOtherWorkers(workerProfiles);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      workers = await workerProfiles.snapshot();
      if (workers.some(worker => worker.evaluations !== 1)) {
        failure = [failure, "Worker entry evaluated more than once; inspect workers."].filter(Boolean).join(" ");
      }
    } catch (error) {
      failure = [failure, error instanceof Error ? error.message : String(error)].filter(Boolean).join(" ");
    }
    pool.dispose();
    workerProfiles.dispose();
  }

  return {
    schemaVersion: 1,
    status: failure ? "error" : "ok",
    ...(failure ? { error: failure } : {}),
    elapsedMs: performance.now() - started,
    environment: { userAgent: navigator.userAgent, platform: navigator.platform, url: location.href,
      secureContext: isSecureContext, visibilityState: document.visibilityState, hasFocus: document.hasFocus(),
      hardwareConcurrency: navigator.hardwareConcurrency, buildStamp: __BUILD_STAMP__ },
    fixture: { name: "CBPQT4+ / PEG2-TTF", components: [CBPQT, pegTtf(2)], seed: 42,
      placement: "full explicit-H guest centroid translated onto host centroid, no rotation",
      minimize: { forceField: "mmff94s", interfragment: true, maxIters: 20000 }, flatten: { view: "auto" }, samples: 3 },
    interpretation: {
      units: "milliseconds, performance.now wall time",
      nesting: "Stages overlap/nest. Do not sum stage totals to get wallMs; repeated calls within a stage are summed.",
      warmup: "All samples retained. First embed includes cold worker/WASM startup; every flatten follows embed and minimize on a reused worker.",
      transportResidualMs: "host.<method>.worker-roundtrip minus worker.protocol-total: outbound/inbound cloning, message dispatch, initial worker bootstrap, scheduling and timing delivery. Not pure clone time.",
      transport: "Shared page/worker clock (performance.timeOrigin + performance.now): requestDeliveryMs is host post to worker handler entry; resultDeliveryMs is worker result post to host onmessage entry; replyDispatchMs is host entry through filtering/logging before resolution. Raw clocks are in the delivery events' details and result reply log.",
      bridge: "structuredClone of the real capabilityResult envelope, including deserialization. No PluginWorkerBridge dispatch or plugin-worker scheduling is measured.",
      host: "Real plugin-host request schemas, Chemistry3dQueue and per-method chemistry3dResultError, real createChemistry3dProviders and conformerWorker.ts. No plugin command registration/permission-dispatch overhead measured.",
      overhead: "Opt-in onTiming streams worker timing messages and wraps RDKit bindings; event delivery and logging affect these observations. Native progress messages occur outside method wallMs."
    },
    workers, workerExercises, workerActivity: workerProfiles.activity,
    workersNotCovered: ["chemistry3d/perfWorker.ts (Node-only benchmark, not WKWebView)",
      "test/depictionNodeWorker.mjs (Node-only test transport)",
      "Installed third-party plugin entries and their nested workers (external packages, not app build)",
      "Windows custom-origin blob bootstrap/shim execution (requires WebView2 at http://tauri.localhost)"],
    setup, measurements, replies
  };
}
