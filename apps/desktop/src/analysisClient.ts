/**
 * Main-thread client for the analysis worker (PLANS.md §5).
 *
 * Two responsibilities, and it is worth keeping them separate in your head:
 *
 * - **This file** owns the Worker: creating it lazily, restarting it if it dies, and matching replies
 *   to requests. That is the part that cannot be tested without a Worker, so it is kept thin.
 * - **`AnalysisScheduler`** (in `@chemdraft/analysis-core`) owns the policy: debounce, supersession,
 *   the session cache, and the size guards. That is the part worth testing hard, so it lives in a
 *   package and runs in Node against a fake transport.
 *
 * Callers see one method. `analyze(slot, spec)` always resolves with an `AnalysisRun` — an answer, or
 * a result-less run whose status says why not.
 */
import {
  AnalysisScheduler,
  AnalysisSessionCache,
  type AnalysisRequestSpec,
  type AnalysisRun,
  type ScheduleOptions
} from "@chemdraft/analysis-core";
import { PINNED_ISOSPEC_WASM_SHA256 } from "@chemdraft/isospec-adapter";
import { PINNED_RDKIT_WASM_SHA256, sourceInterpretation } from "@chemdraft/rdkit-adapter";

import type { AnalysisWorkRequest, AnalysisWorkResponse } from "./analysisWorker";

/**
 * Refuse anything larger than this many heavy atoms. Enforced in the adapter, which is the only layer
 * that knows the count; the number is a UI budget, not a chemistry limit — a 500-atom structure
 * analyses fine, it just is not something to run on every keystroke.
 */
const MAX_HEAVY_ATOMS = 500;

/** Stop recreating a crashed worker after this many restarts; something is systematically wrong. */
const MAX_WORKER_RESTARTS = 3;

export interface AnalysisClient {
  /**
   * Analyse `spec` for `slot`, superseding whatever that slot was doing. Never rejects: a superseded
   * or refused request resolves with a result-less run carrying the reason.
   */
  analyze(slot: string, spec: AnalysisRequestSpec, options?: ScheduleOptions): Promise<AnalysisRun>;
  /** Abandon a slot's in-flight analysis — call when the selection clears. */
  cancel(slot: string): void;
  /** Load the WASM and warm the JIT before the user's first request. Idempotent, best-effort. */
  warmup(): void;
  readonly cache: AnalysisSessionCache;
  dispose(): void;
}

let singleton: AnalysisClient | null | undefined;

export function createAnalysisClient(workerFactory?: () => Worker): AnalysisClient | null {
  if (!workerFactory && typeof Worker === "undefined") return null;

  const factory =
    workerFactory ?? (() => new Worker(new URL("./analysisWorker.ts", import.meta.url), { type: "module" }));

  let worker: Worker | null = null;
  let restarts = 0;
  let disposed = false;
  let nextId = 1;
  let warmed = false;
  const pending = new Map<number, { settle(run: AnalysisRun): void; fail(error: Error): void }>();

  const failAllPending = (message: string): void => {
    for (const [, entry] of pending) entry.fail(new Error(message));
    pending.clear();
  };

  const ensureWorker = (): Worker | null => {
    if (disposed) return null;
    if (worker) return worker;
    if (restarts > MAX_WORKER_RESTARTS) return null;

    const created = factory();
    created.addEventListener("message", (event: MessageEvent<AnalysisWorkResponse>) => {
      const { id, kind, run, message } = event.data;
      if (kind === "ready") return;
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (kind === "run" && run) entry.settle(run);
      else entry.fail(new Error(message ?? "The analysis worker returned no run."));
    });
    const onDeath = (): void => {
      // A dead worker's pending requests can never be answered. Failing them turns into `failed` runs
      // at the scheduler, which is a state the UI already renders — better than promises that hang.
      worker = null;
      restarts += 1;
      failAllPending("The analysis worker stopped unexpectedly.");
    };
    created.addEventListener("error", onDeath);
    created.addEventListener("messageerror", onDeath);

    worker = created;
    return created;
  };

  // Both engines: a run can carry an isotope envelope, so rebuilding IsoSpec has to invalidate the
  // session cache exactly as rebuilding RDKit does.
  const engineHashes = [`sha256:${PINNED_RDKIT_WASM_SHA256}`, `sha256:${PINNED_ISOSPEC_WASM_SHA256}`];

  const scheduler = new AnalysisScheduler({
    interpretationFor: (spec) => sourceInterpretation(spec.format, spec.value),
    now: () => new Date().toISOString(),
    engineHashes,
    run: (spec, signal) =>
      new Promise<AnalysisRun>((resolve, reject) => {
        const active = ensureWorker();
        if (!active) {
          reject(new Error("The analysis worker is unavailable."));
          return;
        }

        const id = nextId;
        nextId += 1;
        pending.set(id, { settle: resolve, fail: reject });

        signal.onCancel(() => {
          // Tell the worker so it can drop the reply, and stop waiting here. The scheduler ignores
          // whatever this promise does from now on.
          pending.delete(id);
          worker?.postMessage({ kind: "cancel", id } satisfies AnalysisWorkRequest);
        });

        active.postMessage({
          kind: "analyze",
          id,
          request: {
            format: spec.format as "smiles" | "molfile-v2000" | "molfile-v3000",
            value: spec.value,
            runId: `analysis-${id}`,
            startedAt: new Date().toISOString(),
            maxHeavyAtoms: MAX_HEAVY_ATOMS,
            ...(spec.methodIds ? { methodIds: [...spec.methodIds] } : {}),
            ...(spec.fallbackInterpretations
              ? { fallbackInterpretations: spec.fallbackInterpretations as never }
              : {}),
            ...(spec.interpretationOverride
              ? { interpretationOverride: spec.interpretationOverride as never }
              : {})
          }
        } satisfies AnalysisWorkRequest);
      })
  });

  return {
    analyze: (slot, spec, options) => scheduler.request(slot, spec, options),
    cancel: (slot) => scheduler.cancel(slot),
    warmup: () => {
      if (warmed) return;
      warmed = true;
      const active = ensureWorker();
      active?.postMessage({ kind: "warmup", id: 0 } satisfies AnalysisWorkRequest);
    },
    cache: scheduler.cache,
    dispose: () => {
      disposed = true;
      scheduler.cancelAll();
      failAllPending("The analysis client was disposed.");
      worker?.terminate();
      worker = null;
    }
  };
}

/** The app's shared client. `null` where Worker is unavailable (jsdom tests, exotic webviews). */
export function analysisClient(): AnalysisClient | null {
  if (singleton === undefined) singleton = createAnalysisClient();
  return singleton;
}

/** Test-only: drop the shared client so the next call builds a fresh one. */
export function resetAnalysisClientForTesting(): void {
  singleton?.dispose();
  singleton = undefined;
}
