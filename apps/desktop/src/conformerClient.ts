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

export interface ConformerStageHandlers {
  onEmbedded(result: Generate3DConformerResult): void;
  onRefined(result: Generate3DConformerResult): void;
  onError(message: string): void;
}

export interface ConformerWorkerClient {
  /** Stream a generation; returns a cancel that detaches the handlers (the worker
   *  still finishes and caches, so a cancelled request warms future ones). */
  generate(molfile: string, originalAtomCount: number, handlers: ConformerStageHandlers): () => void;
  /** Fire-and-forget: compute + cache so a subsequent generate is instant. */
  prefetch(molfile: string, originalAtomCount: number): void;
  /** Preload OCL + resources + JIT in the worker (idempotent, best-effort). */
  warmup(): void;
}

let client: ConformerWorkerClient | null | undefined;

function createClient(): ConformerWorkerClient | null {
  if (typeof Worker === "undefined") return null;
  let worker: Worker;
  try {
    worker = new Worker(new URL("./conformerWorker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }

  let nextId = 1;
  const pending = new Map<number, ConformerStageHandlers>();

  worker.addEventListener("message", (event: MessageEvent<ConformerWorkResponse>) => {
    const { id, stage, result, message } = event.data;
    const handlers = pending.get(id);
    if (!handlers) return;
    if (stage === "embedded" && result) {
      if (result.embed.status !== "ok") pending.delete(id);
      handlers.onEmbedded(result);
    } else if (stage === "refined" && result) {
      pending.delete(id); // refined is the final stage for a request
      handlers.onRefined(result);
    } else if (stage === "error") {
      pending.delete(id);
      handlers.onError(message ?? "conformer worker failed");
    }
  });

  worker.addEventListener("error", () => {
    // A crashed worker fails all in-flight requests; callers fall back / retry.
    for (const handlers of pending.values()) handlers.onError("conformer worker crashed");
    pending.clear();
  });

  const send = (request: ConformerWorkRequest) => worker.postMessage(request);

  let warmed = false;
  return {
    generate(molfile, originalAtomCount, handlers) {
      const id = nextId++;
      pending.set(id, handlers);
      send({ kind: "generate", id, molfile, originalAtomCount });
      return () => pending.delete(id);
    },
    prefetch(molfile, originalAtomCount) {
      send({ kind: "prefetch", id: nextId++, molfile, originalAtomCount });
    },
    warmup() {
      if (warmed) return;
      warmed = true;
      send({ kind: "warmup", id: nextId++ });
    }
  };
}

/** The shared worker client, or null where Workers are unavailable. */
export function getConformerWorkerClient(): ConformerWorkerClient | null {
  if (client === undefined) client = createClient();
  return client;
}
