/**
 * Conformer generation Web Worker — keeps OpenChemLib's embed + MMFF94 work off
 * the main thread so the canvas never freezes, and streams results in two stages:
 *
 *   request          → { kind: "generate" | "prefetch", id, molfile, originalAtomCount }
 *   stage "embedded" → usable conformer (collision-free, parities correct): the UI
 *                      shows the spin overlay NOW.
 *   stage "refined"  → capped MMFF94-minimised coordinates for the same conformer:
 *                      the UI hot-swaps them under the live overlay.
 *
 * Jobs run strictly sequentially (OCL is synchronous); results are LRU-cached by
 * molfile so a prefetch issued when the user selects a molecule makes the actual
 * spin click (and any re-spin) effectively instant.
 */
import {
  ensureOclResources,
  generate3DConformerProgressive,
  setOclResourcesUrl,
  withOclConformerTrace
} from "@chemdraft/ocl-adapter";
import type { Generate3DConformerResult } from "@chemdraft/chemistry-adapter";
import { oclResourcesUrl } from "./oclResources";
import {
  createSpin3dTraceEvent,
  createSpin3dTraceEventFromOcl,
  startSpin3dTraceSpan,
  type Spin3dTraceEvent
} from "./conformerDebug";

export interface ConformerWorkRequest {
  kind: "generate" | "prefetch" | "warmup" | "cancel";
  id: number;
  molfile?: string;
  originalAtomCount?: number;
  sessionId?: string;
}

export interface ConformerWorkResponse {
  id: number;
  stage: "embedded" | "refined" | "error" | "warmed" | "trace" | "complete";
  result?: Generate3DConformerResult;
  message?: string;
  trace?: Spin3dTraceEvent;
}

/**
 * Depiction-grade minimisation caps, scaled by size: MMFF94 cost per iteration grows
 * with the atom-pair count, and the planarising/strain-relief work happens in the
 * early iterations. 800 on a 63-atom branched chain measured ~9s of uninterruptible
 * worker time; these caps bound the worst case while keeping small molecules ideal.
 */
function refineIterationsFor(atomCount: number | undefined): number {
  const n = atomCount ?? 0;
  if (n <= 30) return 800;
  if (n <= 60) return 400;
  return 240;
}

/** Speculative work only: structures above this never prefetch-refine in the
 *  background — the (size-capped) refine runs on demand when actually spun. */
const BACKGROUND_REFINE_MAX_ATOMS = 40;
const CACHE_LIMIT = 6;

interface CacheEntry {
  embedded: Generate3DConformerResult;
  refined?: Generate3DConformerResult;
  traceSessionId?: string;
  traceRequestId?: number;
  /** Pending MMFF94 minimisation on the live OCL conformer. Held until consumed —
   *  run by a background refine job (after a prefetch) or on demand when a real
   *  generate hits this entry. NOTE: OCL's minimise() is single-shot (not resumable),
   *  so this thunk is meant to be invoked exactly ONCE with the size cap; it is cleared
   *  immediately after, or KEPT only when a background run is skipped because a click is
   *  waiting (an on-demand re-spin then runs it). */
  refine?: (maxIts?: number) => Generate3DConformerResult;
}

const cache = new Map<string, CacheEntry>();

function cachePut(molfile: string, entry: CacheEntry): void {
  cache.delete(molfile);
  cache.set(molfile, entry);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
    if (pendingRefine === oldest) pendingRefine = null; // evicted — nothing left to refine
  }
}

const post = (response: ConformerWorkResponse) =>
  (globalThis as unknown as { postMessage(message: ConformerWorkResponse): void }).postMessage(response);

function traceSessionId(request: Pick<ConformerWorkRequest, "id" | "kind" | "sessionId">): string {
  return request.sessionId ?? `${request.kind}:${request.id}`;
}

function queueDepth(): number {
  return pendingGenerates.length +
    (pendingPrefetch ? 1 : 0) +
    (pendingRefine ? 1 : 0) +
    (pendingWarmup ? 1 : 0);
}

/** Human-readable composition for the debugger, so "queue 3" never reads as three
 *  user-blocking jobs when two of them are idle polish/boot work. */
function queueBreakdown(): string {
  const parts: string[] = [];
  if (pendingGenerates.length > 0) parts.push(`${pendingGenerates.length} generate`);
  if (pendingPrefetch) parts.push("1 prefetch");
  if (pendingRefine) parts.push("1 idle refine");
  if (pendingWarmup) parts.push("1 warmup");
  return parts.length > 0 ? `queue ${queueDepth()} = ${parts.join(" · ")}` : "queue 0";
}

function postTrace(request: ConformerWorkRequest, input: Omit<Parameters<typeof createSpin3dTraceEvent>[0], "sessionId" | "requestId">): void {
  post({
    id: request.id,
    stage: "trace",
    trace: createSpin3dTraceEvent({
      ...input,
      sessionId: traceSessionId(request),
      requestId: request.id,
      path: "worker"
    })
  });
}

function postOclTrace(request: ConformerWorkRequest, event: Parameters<typeof createSpin3dTraceEventFromOcl>[0]): void {
  post({
    id: request.id,
    stage: "trace",
    trace: createSpin3dTraceEventFromOcl(event, {
      sessionId: traceSessionId(request),
      requestId: request.id,
      path: "worker"
    })
  });
}

// Single-consumer scheduler with PRIORITY + COALESCING. OCL embeds/minimisations are
// synchronous and uninterruptible once started, so the only lever we have is ordering:
// the work the user is actively waiting on (`generate`) must run before any speculative
// work, and speculative work must never pile up behind a click.
//
//   • generates  → FIFO queue (usually 0–1 deep), always taken first
//   • prefetch   → only the NEWEST is kept; a burst of selection changes collapses to
//                  one job instead of stacking multi-second embeds ahead of a click
//   • refine     → a SINGLE slot (newest wins): only the most recently prefetched
//                  molecule gets an idle MMFF94 polish. Superseded molecules keep their
//                  refine thunk in the cache and refine on demand if actually spun —
//                  browsing across N molecules must not park N multi-second jobs
//                  (that was the `worker.submit queue 3/4` backlog).
//   • warmup     → coalesced to one, lowest priority (a waiting generate warms OCL itself)
let running = false;
const pendingGenerates: ConformerWorkRequest[] = [];
let pendingPrefetch: ConformerWorkRequest | null = null;
let pendingRefine: string | null = null; // molfile with a cached entry awaiting idle refinement
let pendingWarmup: ConformerWorkRequest | null = null;

type WorkItem =
  | { kind: "request"; request: ConformerWorkRequest }
  | { kind: "refine"; molfile: string };

function takeNextWorkItem(): WorkItem | null {
  const generate = pendingGenerates.shift();
  if (generate) return { kind: "request", request: generate };
  if (pendingPrefetch) {
    const prefetch = pendingPrefetch;
    pendingPrefetch = null;
    return { kind: "request", request: prefetch };
  }
  if (pendingRefine !== null) {
    const refineMolfile = pendingRefine;
    pendingRefine = null;
    return { kind: "refine", molfile: refineMolfile };
  }
  if (pendingWarmup) {
    const warmup = pendingWarmup;
    pendingWarmup = null;
    return { kind: "request", request: warmup };
  }
  return null;
}

/**
 * Run the entry's MMFF94 minimisation as ONE size-capped call, upgrading the cache
 * entry in place and returning the refined result.
 *
 * CRITICAL: OCL's `ForceFieldMMFF94.minimise()` is NOT resumable. Only the FIRST call
 * on a force-field instance moves atoms; any later call (capped or not) is a no-op that
 * returns rc 1 with the energy frozen. An earlier "chunked" design called minimise in
 * small batches to stay responsive — it left every structure at ~6 iterations of polish
 * (i.e. the raw, often non-planar embed), which is why flat aromatics came out warped.
 * So the minimisation cannot be split, time-boxed, or resumed across calls: a single
 * `minimise({maxIts: cap})` is the only thing that actually converges the geometry.
 *
 *   • cap  — size-based iteration ceiling (refineIterationsFor). Bounds how long this one
 *            uninterruptible call blocks the worker; small/medium molecules converge well
 *            inside it (e.g. pentacene at ~240 in <100ms).
 *
 * `preemptible` only governs whether we START: if a user `generate` is already queued we
 * skip and KEEP the thunk (an on-demand re-spin will refine then), rather than block the
 * click behind a minimisation we can't interrupt once begun. The embedded conformer is
 * already on screen, so this stage-2 polish hot-swaps under the live overlay when done.
 */
async function runRefine(
  entry: CacheEntry,
  request: ConformerWorkRequest,
  options: { preemptible: boolean; stage: string }
): Promise<Generate3DConformerResult | undefined> {
  const refine = entry.refine;
  if (!refine) return entry.refined; // already refined (or no refinement)
  if (options.preemptible && pendingGenerates.length > 0) {
    return entry.refined; // a click is waiting — refine this on demand instead of blocking it
  }

  const atomCount = entry.embedded.originalAtomCount;
  const cap = refineIterationsFor(atomCount);
  const span = startSpin3dTraceSpan({
    sessionId: traceSessionId(request),
    requestId: request.id,
    kind: "worker",
    stage: options.stage,
    path: "worker",
    atomCount
  }, (trace) => post({ id: request.id, stage: "trace", trace }));

  const startedAt = Date.now();
  let status: "converged" | "capped" | "error" = "capped";
  try {
    entry.refined = refine(cap);
    status = entry.refined.forceField?.returnCode === 0 ? "converged" : "capped";
  } catch {
    status = "error"; // leave the entry at its embedded coords
  }
  entry.refine = undefined; // single shot — minimise can't be resumed, so the thunk is spent
  span.complete({
    message: `${cap} iters · ${status} · ${Date.now() - startedAt}ms`,
    warningCount: entry.refined?.warnings.length
  });
  return entry.refined;
}

function scheduleBackgroundRefine(molfile: string): void {
  // Newest wins: a superseded molecule keeps its refine thunk in the cache and
  // refines on demand if the user actually spins it.
  pendingRefine = molfile;
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    let item: WorkItem | null;
    while ((item = takeNextWorkItem()) !== null) {
      if (item.kind === "refine") {
        const entry = cache.get(item.molfile);
        if (entry) {
          const request: ConformerWorkRequest = {
            kind: "prefetch",
            id: entry.traceRequestId ?? 0,
            sessionId: entry.traceSessionId ?? "background-refine",
            molfile: item.molfile,
            originalAtomCount: entry.embedded.originalAtomCount
          };
          await runRefine(entry, request, {
            preemptible: true,
            stage: "worker.background-refine"
          });
        }
      } else if (item.request.kind === "warmup") {
        await runWarmup(item.request);
      } else {
        await runGenerate(item.request);
      }
      // Macrotask yield between jobs: message events can't interleave with the
      // synchronous OCL work above, so without this a queued generate posted
      // mid-backlog would wait out every remaining speculative job.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    running = false;
  }
}

function submit(request: ConformerWorkRequest): void {
  if (request.kind === "cancel") {
    // Drop the job if it is still queued; a running OCL call cannot be interrupted.
    const queuedIndex = pendingGenerates.findIndex((queued) => queued.id === request.id);
    if (queuedIndex >= 0) {
      const [cancelled] = pendingGenerates.splice(queuedIndex, 1);
      postTrace(cancelled, {
        kind: "worker",
        stage: "worker.cancelled",
        status: "info",
        atomCount: cancelled.originalAtomCount,
        queueDepth: queueDepth()
      });
    } else if (pendingPrefetch?.id === request.id) {
      pendingPrefetch = null;
    }
    return;
  }
  if (request.kind === "generate") {
    // Coalesce duplicate explicit requests: repeated Spin 3D clicks for the same
    // structure must not stack multi-second engine jobs. The newest request keeps
    // the queue slot (its caller token is the only live one); superseded entries
    // finish immediately with a terminal "complete" so the client forgets them.
    for (let i = pendingGenerates.length - 1; i >= 0; i--) {
      if (pendingGenerates[i].molfile === request.molfile) {
        const [superseded] = pendingGenerates.splice(i, 1);
        post({ id: superseded.id, stage: "complete" });
        postTrace(superseded, {
          kind: "worker",
          stage: "worker.superseded",
          status: "info",
          atomCount: superseded.originalAtomCount,
          queueDepth: queueDepth()
        });
      }
    }
    pendingGenerates.push(request);
  } else if (request.kind === "prefetch") {
    // Already computed? Nothing to do. Otherwise keep only the latest pending prefetch.
    if (request.molfile && cache.has(request.molfile)) {
      postTrace(request, {
        kind: "worker",
        stage: "worker.prefetch.skip",
        status: "info",
        cacheStatus: "hit",
        atomCount: request.originalAtomCount,
        queueDepth: queueDepth()
      });
      return;
    }
    pendingPrefetch = request;
  } else {
    pendingWarmup = request;
  }
  postTrace(request, {
    kind: "worker",
    stage: "worker.submit",
    status: "info",
    message: queueBreakdown(),
    atomCount: request.originalAtomCount,
    queueDepth: queueDepth()
  });
  void drain();
}

async function runGenerate(request: ConformerWorkRequest): Promise<void> {
  const molfile = request.molfile ?? "";
  const isPrefetch = request.kind === "prefetch";
  const runSpan = startSpin3dTraceSpan({
    sessionId: traceSessionId(request),
    requestId: request.id,
    kind: "worker",
    stage: isPrefetch ? "worker.prefetch" : "worker.generate",
    path: "worker",
    atomCount: request.originalAtomCount
  }, (trace) => post({ id: request.id, stage: "trace", trace }));
  try {
    const hit = cache.get(molfile);
    if (hit) {
      cachePut(molfile, hit); // refresh LRU position
      postTrace(request, {
        kind: "worker",
        stage: "worker.cache",
        status: "info",
        message: queueBreakdown(),
        cacheStatus: "hit",
        atomCount: request.originalAtomCount,
        queueDepth: queueDepth()
      });
      if (isPrefetch) {
        runSpan.complete({ cacheStatus: "hit" });
        return; // already computed (or computing in background)
      }
      // The embedded stage goes out immediately — the user can start spinning.
      post({ id: request.id, stage: "embedded", result: hit.embedded });
      // If the background refine hasn't landed yet, run it NOW (we're the
      // user-priority job) so double bonds/conjugation reach planar MMFF94
      // geometry; it hot-swaps under the live overlay. The user spun THIS molecule,
      // so refine it even if another generate is queued (not preemptible).
      if (pendingRefine === molfile) pendingRefine = null; // consuming it here
      const refined = await runRefine(hit, request, {
        preemptible: false,
        stage: "worker.refine"
      });
      if (refined) post({ id: request.id, stage: "refined", result: refined });
      else post({ id: request.id, stage: "complete" }); // no refined stage will follow
      runSpan.complete({ cacheStatus: "hit", warningCount: refined?.warnings.length ?? hit.embedded.warnings.length });
      return;
    }

    postTrace(request, {
      kind: "worker",
      stage: "worker.cache",
      status: "info",
      message: queueBreakdown(),
      cacheStatus: "miss",
      atomCount: request.originalAtomCount,
      queueDepth: queueDepth()
    });
    const { embedded, refine } = await withOclConformerTrace(
      (event) => postOclTrace(request, event),
      () => generate3DConformerProgressive(
        { molfile, originalAtomCount: request.originalAtomCount },
        { optimize: "auto", maxMinimiseIterations: refineIterationsFor(request.originalAtomCount) }
      )
    );
    if (embedded.embed.status !== "ok") {
      if (!isPrefetch) post({ id: request.id, stage: "embedded", result: embedded });
      runSpan.complete({ cacheStatus: "miss", warningCount: embedded.warnings.length });
      return; // never cache failures — a retry should re-attempt
    }
    if (!isPrefetch) post({ id: request.id, stage: "embedded", result: embedded });
    const entry: CacheEntry = {
      embedded,
      refine,
      traceSessionId: traceSessionId(request),
      traceRequestId: request.id
    };
    cachePut(molfile, entry);

    if (isPrefetch) {
      // Don't block the queue with the expensive MMFF94 pass — a click must be able
      // to jump in after the embed. Small/medium structures refine as a lowest-
      // priority background job; large ones only refine on demand when actually
      // spun, so speculative work can never occupy the worker for many seconds.
      if ((request.originalAtomCount ?? 0) <= BACKGROUND_REFINE_MAX_ATOMS) {
        scheduleBackgroundRefine(molfile);
      } else {
        postTrace(request, {
          kind: "worker",
          stage: "worker.refine.deferred",
          status: "info",
          atomCount: request.originalAtomCount,
          queueDepth: queueDepth()
        });
      }
      runSpan.complete({ cacheStatus: "stored", warningCount: embedded.warnings.length });
      return;
    }
    const refined = await runRefine(entry, request, {
      preemptible: false, // the user spun this molecule — refine it (the embed is already shown)
      stage: "worker.refine"
    });
    if (refined) post({ id: request.id, stage: "refined", result: refined });
    else post({ id: request.id, stage: "complete" });
    runSpan.complete({ cacheStatus: "stored", warningCount: refined?.warnings.length ?? embedded.warnings.length });
  } catch (error) {
    if (!isPrefetch) post({ id: request.id, stage: "error", message: (error as Error).message });
    runSpan.fail(error);
  }
}

async function runWarmup(request: ConformerWorkRequest): Promise<void> {
  const span = startSpin3dTraceSpan({
    sessionId: traceSessionId(request),
    requestId: request.id,
    kind: "worker",
    stage: "worker.warmup",
    path: "worker"
  }, (trace) => post({ id: request.id, stage: "trace", trace }));
  try {
    await withOclConformerTrace((event) => postOclTrace(request, event), async () => {
      await ensureOclResources();
      // A tiny throwaway embed warms OCL's lazily-built torsion tables + JIT so
      // the first real molecule doesn't pay the ~1s first-call cost.
      await generate3DConformerProgressive(
        {
          molfile: [
            "", "  warmup", "",
            "  3  2  0  0  0  0  0  0  0  0999 V2000",
            "    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
            "    1.5000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
            "    2.2500    1.2990    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0",
            "  1  2  1  0  0  0  0",
            "  2  3  1  0  0  0  0",
            "M  END"
          ].join("\n")
        },
        { optimize: "none" }
      );
    });
    span.complete();
  } catch (error) {
    // Warmup is best-effort; real requests will surface real errors.
    span.fail(error);
  }
  post({ id: request.id, stage: "warmed" });
}

setOclResourcesUrl(oclResourcesUrl);

globalThis.addEventListener("message", (event: MessageEvent<ConformerWorkRequest>) => {
  submit(event.data);
});
