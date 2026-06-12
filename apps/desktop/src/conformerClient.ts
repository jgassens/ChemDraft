/**
 * Main-thread client for the conformer worker (see conformerWorker.ts).
 *
 * A lazily-created singleton: the first call spins up the module worker; callers
 * in environments without Worker support (jsdom tests, exotic webviews) get
 * `undefined` and fall back to the in-page adapter path. `warmup()` should be
 * fired once at app idle so the worker's OCL module load, torsion-resource fetch
 * and JIT warmup all happen before the user's first spin click.
 */
import type { Generate3DConformerResult } from "@chemdraft/chemistry-adapter";
import type { ConformerWorkRequest, ConformerWorkResponse } from "./conformerWorker";
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
    handlers: ConformerStageHandlers,
    traceContext?: ConformerTraceContext
  ): () => void;
  /** Fire-and-forget: compute + cache so a subsequent generate is instant. */
  prefetch(molfile: string, originalAtomCount: number, traceContext?: ConformerTraceContext): void;
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
    // Fail all in-flight requests, then RECREATE the worker: a singleton pointing
    // at a dead worker would silently eat every future request for the session.
    for (const [id, request] of pending.entries()) {
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
      ensureWorker(); // recreate eagerly so the next request has a live target
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
    generate(molfile, originalAtomCount, handlers, traceContext) {
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
      if (!send({ kind: "generate", id, molfile, originalAtomCount, sessionId: traceContext?.sessionId })) {
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
    prefetch(molfile, originalAtomCount, traceContext) {
      const id = nextId++;
      send({ kind: "prefetch", id, molfile, originalAtomCount, sessionId: traceContext?.sessionId ?? `prefetch:${id}` });
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

// Boot the worker immediately at module load so the ~1 MB OCL download starts
// in parallel with app startup — not lazily on first spin click.
getConformerWorkerClient();
