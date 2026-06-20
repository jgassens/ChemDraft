/**
 * Main-thread client for the conformer worker (see conformerWorker.ts).
 *
 * A lazily-created singleton: the first call spins up the module worker; callers
 * in environments without Worker support (jsdom tests, exotic webviews) get
 * `undefined` and fall back to the in-page adapter path. `warmup()` should be
 * fired once at app idle so the worker's OCL module load, torsion-resource fetch
 * and JIT warmup all happen before the user's first spin click.
 */
import type { Generate3DConformerOptions, Generate3DConformerResult } from "@chemdraft/chemistry-adapter";
import type { ConformerWorkRequest, ConformerWorkResponse } from "./conformerWorker";
import type { Spin3dEnginePreference } from "./spin3dSettings";
import {
  broadcastSpin3dTraceEvent,
  createSpin3dTraceEvent
} from "./conformerDebug";

export interface ConformerStageHandlers {
  onEmbedded(result: Generate3DConformerResult): void;
  onRefined(result: Generate3DConformerResult): void;
  /** `info.workerCrashed` distinguishes a dead/restarted worker (retry is sensible)
   *  from a deterministic engine failure (retrying would fail the same way). */
  onError(message: string, info?: { workerCrashed?: boolean }): void;
}

export interface ConformerTraceContext {
  sessionId: string;
}

export interface ConformerWorkerClient {
  /** Stream a generation; returns a cancel that detaches the handlers (the worker
   *  still finishes and caches, so a cancelled request warms future ones). */
  generate(
    molfile: string,
    originalAtomCount: number,
    options: Generate3DConformerOptions,
    enginePreference: Spin3dEnginePreference,
    handlers: ConformerStageHandlers,
    traceContext?: ConformerTraceContext
  ): () => void;
  /** Fire-and-forget: compute + cache so a subsequent generate is instant. */
  prefetch(
    molfile: string,
    originalAtomCount: number,
    options: Generate3DConformerOptions,
    enginePreference: Spin3dEnginePreference,
    traceContext?: ConformerTraceContext
  ): void;
  /** Preload OCL + resources + JIT in the worker (idempotent, best-effort). */
  warmup(traceContext?: ConformerTraceContext): void;
}

let client: ConformerWorkerClient | null | undefined;

type PendingRequest = {
  handlers: ConformerStageHandlers;
  traceContext?: ConformerTraceContext;
};

/** Stop recreating crashed workers after this many restarts — something is
 *  systematically wrong and an in-page fallback / error status takes over. */
const MAX_WORKER_RESTARTS = 3;

export function createConformerWorkerClient(
  workerFactory?: () => Worker
): ConformerWorkerClient | null {
  if (!workerFactory && typeof Worker === "undefined") return null;

  let nextId = 1;
  const pending = new Map<number, PendingRequest>();
  let worker: Worker | null = null;
  let restarts = 0;
  let warmed = false;

  const handleMessage = (event: MessageEvent<ConformerWorkResponse>): void => {
    const { id, stage, result, message, trace } = event.data;
    if (trace) {
      broadcastSpin3dTraceEvent(trace);
    }
    if (stage === "trace") return;
    if (stage === "complete") {
      // Terminal bookkeeping for requests that will never get a "refined" stage
      // (refinement skipped/failed) or were superseded by a newer duplicate.
      pending.delete(id);
      return;
    }

    const request = pending.get(id);
    if (!request) return;
    const { handlers } = request;
    if (stage === "embedded" && result) {
      if (result.embed.status !== "ok") pending.delete(id);
      handlers.onEmbedded(result);
    } else if (stage === "refined" && result) {
      pending.delete(id); // refined is the final stage for a request
      handlers.onRefined(result);
    } else if (stage === "error") {
      pending.delete(id);
      // Deterministic engine failure — the worker itself is healthy.
      handlers.onError(message ?? "conformer worker failed", { workerCrashed: false });
    }
  };

  const handleCrash = (): void => {
    // Snapshot and clear the in-flight requests, recreate the worker, and ONLY THEN fire
    // onError. The consumer's onError synchronously re-dispatches (generate → pending.set),
    // so if we cleared pending or recreated the worker after firing, that retry entry would
    // be wiped (or posted to the dead worker) — turning the documented transparent retry
    // into a hard "could not generate" failure.
    const snapshot = [...pending.entries()];
    pending.clear();
    try {
      worker?.terminate?.();
    } catch {
      /* already dead */
    }
    worker = null;
    warmed = false; // a fresh worker needs OCL + torsion tables again
    if (restarts < MAX_WORKER_RESTARTS) {
      restarts += 1;
      ensureWorker(); // recreate eagerly so the retry has a live target
    }
    for (const [id, request] of snapshot) {
      broadcastSpin3dTraceEvent(createSpin3dTraceEvent({
        sessionId: request.traceContext?.sessionId ?? "worker-client",
        requestId: id,
        kind: "worker-client",
        stage: "worker.crash",
        status: "failed",
        path: "worker",
        error: "conformer worker crashed"
      }));
      request.handlers.onError("conformer worker crashed", { workerCrashed: true });
    }
  };

  const ensureWorker = (): Worker | null => {
    if (worker) return worker;
    if (restarts > MAX_WORKER_RESTARTS) return null;
    try {
      worker = workerFactory
        ? workerFactory()
        : new Worker(new URL("./conformerWorker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      worker = null;
      broadcastSpin3dTraceEvent(createSpin3dTraceEvent({
        sessionId: "worker-client",
        kind: "worker-client",
        stage: "worker.create",
        status: "failed",
        path: "worker",
        error: error instanceof Error ? error.message : String(error)
      }));
      return null;
    }
    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleCrash);
    // A structured-clone deserialization failure fires "messageerror" (not "error" or
    // "message"); without this the pending request would leak and the UI would hang in
    // "Generating 3D conformer…" forever. Treat it as a crash so the request fails over.
    worker.addEventListener("messageerror", handleCrash);
    broadcastSpin3dTraceEvent(createSpin3dTraceEvent({
      sessionId: "worker-client",
      kind: "worker-client",
      stage: restarts > 0 ? "worker.restart" : "worker.create",
      status: "completed",
      path: "worker"
    }));
    return worker;
  };

  if (!ensureWorker()) return null;

  const send = (request: ConformerWorkRequest): boolean => {
    const target = ensureWorker();
    if (!target) return false;
    target.postMessage(request);
    return true;
  };

  return {
    generate(molfile, originalAtomCount, options, enginePreference, handlers, traceContext) {
      const id = nextId++;
      pending.set(id, { handlers, traceContext });
      broadcastSpin3dTraceEvent(createSpin3dTraceEvent({
        sessionId: traceContext?.sessionId ?? `generate:${id}`,
        requestId: id,
        kind: "worker-client",
        stage: "worker.generate.dispatch",
        status: "info",
        atomCount: originalAtomCount,
        path: "worker"
      }));
      if (!send({ kind: "generate", id, molfile, originalAtomCount, options, enginePreference, sessionId: traceContext?.sessionId })) {
        pending.delete(id);
        // Crash-looped beyond the restart budget — report asynchronously so the
        // caller's handler wiring is complete before the callback fires.
        setTimeout(() => handlers.onError("conformer worker unavailable", { workerCrashed: true }), 0);
        return () => undefined;
      }
      return () => {
        // Detach handlers AND tell the worker to drop the job if still queued
        // (a running OCL call is synchronous and cannot be interrupted).
        pending.delete(id);
        send({ kind: "cancel", id });
      };
    },
    prefetch(molfile, originalAtomCount, options, enginePreference, traceContext) {
      const id = nextId++;
      send({ kind: "prefetch", id, molfile, originalAtomCount, options, enginePreference, sessionId: traceContext?.sessionId ?? `prefetch:${id}` });
    },
    warmup(traceContext) {
      if (warmed) return;
      const id = nextId++;
      if (send({ kind: "warmup", id, sessionId: traceContext?.sessionId ?? `warmup:${id}` })) {
        warmed = true;
      }
    }
  };
}

/** The shared worker client, or null where Workers are unavailable. */
export function getConformerWorkerClient(): ConformerWorkerClient | null {
  if (client === undefined) client = createConformerWorkerClient();
  return client;
}

// NOTE: the worker is intentionally NOT booted at module load. App.tsx statically imports
// MainWindow (and therefore this module) on every route, so a module-load spawn would start
// the ~1 MB OCL download in windows that never spin a molecule (the palette window, the
// Spin 3D debugger pop-out). MainWindow's idle warmup effect boots it on the main document
// window instead.
