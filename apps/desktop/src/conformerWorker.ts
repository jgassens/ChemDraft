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
  generate3DConformerProgressive as oclGenerate3DConformerProgressive,
  setOclResourcesUrl,
  withOclConformerTrace
} from "@chemdraft/ocl-adapter";
import {
  ensureRdkit,
  generate3DConformerProgressive as rdkitGenerate3DConformerProgressive
} from "@chemdraft/rdkit-adapter";
import type {
  ConformerEngineName,
  Generate3DConformerOptions,
  Generate3DConformerResult,
  ProgressiveConformerResult
} from "@chemdraft/chemistry-adapter";
import { oclResourcesUrl } from "./oclResources";
import { registerRdkitWasmLoader } from "./rdkitWasmLoader";
import { qualityRefineIterationsFor } from "./spin3dRefineCaps";
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
  /** Conformer refinement options for this request (Spin 3D mode → engine options).
   *  Embedding ignores these (it is force-field-independent and cached by molfile);
   *  only the refinement stage reads `optimize` / `maxMinimiseIterations`. */
  options?: Generate3DConformerOptions;
}

export interface ConformerWorkResponse {
  id: number;
  stage: "embedded" | "refined" | "error" | "warmed" | "trace" | "complete";
  result?: Generate3DConformerResult;
  message?: string;
  trace?: Spin3dTraceEvent;
}

/** Speculative work only: structures above this never prefetch-refine in the
 *  background — the (size-capped) refine runs on demand when actually spun. */
const BACKGROUND_REFINE_MAX_ATOMS = 40;
const CACHE_LIMIT = 6;

/**
 * Stable key for a refined result within a single embedded conformer. Embedding is
 * force-field-independent, so the cache holds ONE embed per molfile and memoises the
 * refined coordinates per refinement mode here — switching Fast/Balanced/Quality
 * reuses the embed and never reuses another mode's refined geometry. `"none"` (Fast)
 * is never stored: it has no refined stage. All OCL force fields collapse to MMFF94
 * today, so the key is just the iteration cap.
 */
function refinementKeyFor(
  options: Generate3DConformerOptions | undefined,
  atomCount: number | undefined
): string {
  const optimize = options?.optimize ?? "auto";
  if (optimize === "none") return "none";
  const maxIts = options?.maxMinimiseIterations ?? qualityRefineIterationsFor(atomCount);
  return `mmff94:${maxIts}`;
}

interface CacheEntry {
  embedded: Generate3DConformerResult;
  /** Which engine produced this embed. A cached entry is reused only when it matches the
   *  engine currently in effect (so an OCL-fallback embed is never served as an RDKit one). */
  engine: ConformerEngineName;
  traceSessionId?: string;
  traceRequestId?: number;
  /** Refined coordinates memoised per refinement mode (see refinementKeyFor). */
  refinedByMode: Map<string, Generate3DConformerResult>;
  /** Re-runnable minimisation from the embedded coordinates (each run starts from the
   *  pristine embed), so different modes can be derived from the one embed without
   *  re-embedding. Absent only when the embed itself failed. */
  refineFromEmbedded?: (maxIts?: number) => Generate3DConformerResult;
  /** Release any engine-held native/WASM resources for this entry. Called on eviction.
   *  (RDKit keeps no long-lived handle, so this is a no-op there; the contract is kept so
   *  an engine that DOES hold handles can free them deterministically.) */
  dispose?: () => void;
}

const cache = new Map<string, CacheEntry>();

function cachePut(molfile: string, entry: CacheEntry): void {
  const existing = cache.get(molfile);
  if (existing && existing !== entry) existing.dispose?.(); // replaced by a different entry
  cache.delete(molfile);
  cache.set(molfile, entry);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.get(oldest)?.dispose?.(); // free engine-held resources before eviction
    cache.delete(oldest);
    if (pendingRefine?.molfile === oldest) pendingRefine = null; // evicted — nothing left to refine
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
// molfile with a cached entry awaiting idle refinement, plus the mode to refine it in
let pendingRefine: { molfile: string; options?: Generate3DConformerOptions } | null = null;
let pendingWarmup: ConformerWorkRequest | null = null;

type WorkItem =
  | { kind: "request"; request: ConformerWorkRequest }
  | { kind: "refine"; molfile: string; options?: Generate3DConformerOptions };

function takeNextWorkItem(): WorkItem | null {
  const generate = pendingGenerates.shift();
  if (generate) return { kind: "request", request: generate };
  if (pendingPrefetch) {
    const prefetch = pendingPrefetch;
    pendingPrefetch = null;
    return { kind: "request", request: prefetch };
  }
  if (pendingRefine !== null) {
    const { molfile: refineMolfile, options: refineOptions } = pendingRefine;
    pendingRefine = null;
    return { kind: "refine", molfile: refineMolfile, options: refineOptions };
  }
  if (pendingWarmup) {
    const warmup = pendingWarmup;
    pendingWarmup = null;
    return { kind: "request", request: warmup };
  }
  return null;
}

/**
 * Run the requested mode's MMFF94 minimisation as ONE size-capped call, memoising the
 * refined result on the entry (per mode) and returning it.
 *
 * CRITICAL: OCL's `ForceFieldMMFF94.minimise()` runs to termination in a single,
 * uninterruptible call — it cannot be time-boxed or split into resumable batches (an
 * earlier "chunked" design left structures at ~6 iterations, i.e. the raw non-planar
 * embed, warping flat aromatics). `refineFromEmbedded(cap)` is therefore one capped
 * call. It IS re-runnable across modes because it restores the pristine embed first,
 * so deriving a second mode from the same embed is safe (and cheap — no re-embed).
 *
 *   • cap  — iteration ceiling for this mode (request options, else the size default).
 *
 * `preemptible` only governs whether we START: if a user `generate` is already queued we
 * skip and KEEP the embed's refine capability (an on-demand re-spin refines then), rather
 * than block the click behind a minimisation we can't interrupt once begun. The embedded
 * conformer is already on screen, so this stage-2 polish hot-swaps under the live overlay.
 */
async function runRefine(
  entry: CacheEntry,
  request: ConformerWorkRequest,
  options: { preemptible: boolean; stage: string }
): Promise<Generate3DConformerResult | undefined> {
  if ((request.options?.optimize ?? "auto") === "none") return undefined; // Fast — no refine stage

  const atomCount = entry.embedded.originalAtomCount;
  const key = refinementKeyFor(request.options, atomCount);
  const cached = entry.refinedByMode.get(key);
  if (cached) return cached; // this mode already refined for this embed

  const refine = entry.refineFromEmbedded;
  if (!refine) return undefined; // embed produced no refinement capability
  if (options.preemptible && pendingGenerates.length > 0) {
    return undefined; // a click is waiting — refine this on demand instead of blocking it
  }

  const cap = request.options?.maxMinimiseIterations ?? qualityRefineIterationsFor(atomCount);
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
  let refined: Generate3DConformerResult | undefined;
  try {
    refined = refine(cap);
    entry.refinedByMode.set(key, refined);
    status = refined.forceField?.returnCode === 0 ? "converged" : "capped";
  } catch {
    status = "error"; // leave the entry at its embedded coords
  }
  span.complete({
    message: `${cap} iters · ${status} · ${Date.now() - startedAt}ms · ${key}`,
    warningCount: refined?.warnings.length
  });
  return refined;
}

function scheduleBackgroundRefine(molfile: string, options: Generate3DConformerOptions | undefined): void {
  // Newest wins: a superseded molecule keeps its embed (and refine capability) in the
  // cache and refines on demand if the user actually spins it.
  pendingRefine = { molfile, options };
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
            originalAtomCount: entry.embedded.originalAtomCount,
            options: item.options
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

// Engine selection. RDKit ETKDG is the fast embed; it is used when its WASM module is
// available (a loader has been registered and initialised). Otherwise — including when no
// loader is registered (the default until the WASM ships) — OpenChemLib is used. The probe
// runs once: an init/load failure permanently selects OCL (a transparent fallback). NOTE: an
// RDKit *embed* failure is NOT a fallback trigger — it surfaces as a failed embed so the slow
// OCL embed is never silently re-run behind the user's back.
let rdkitState: "unknown" | "available" | "unavailable" = "unknown";

async function currentEngine(): Promise<ConformerEngineName> {
  if (rdkitState === "unknown") {
    try {
      await ensureRdkit();
      rdkitState = "available";
    } catch {
      rdkitState = "unavailable";
    }
  }
  return rdkitState === "available" ? "rdkit-wasm" : "openchemlib";
}

async function embedConformer(
  request: ConformerWorkRequest,
  engine: ConformerEngineName
): Promise<ProgressiveConformerResult> {
  const input = { molfile: request.molfile ?? "", originalAtomCount: request.originalAtomCount };
  // Embedding is force-field-independent; always request the refine capability so any mode
  // can be derived from this one embed. The per-mode iteration cap is applied in runRefine.
  if (engine === "rdkit-wasm") {
    return rdkitGenerate3DConformerProgressive(input, { optimize: "auto" });
  }
  return withOclConformerTrace(
    (event) => postOclTrace(request, event),
    () => oclGenerate3DConformerProgressive(input, { optimize: "auto" })
  );
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
    const engine = await currentEngine();
    const hit = cache.get(molfile);
    if (hit && hit.engine === engine) {
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
      if (pendingRefine?.molfile === molfile) pendingRefine = null; // consuming it here
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
    const { embedded, refineFromEmbedded } = await embedConformer(request, engine);
    if (embedded.embed.status !== "ok") {
      if (!isPrefetch) post({ id: request.id, stage: "embedded", result: embedded });
      runSpan.complete({ cacheStatus: "miss", warningCount: embedded.warnings.length });
      return; // never cache failures — a retry should re-attempt
    }
    if (!isPrefetch) post({ id: request.id, stage: "embedded", result: embedded });
    const entry: CacheEntry = {
      embedded,
      engine,
      refineFromEmbedded,
      refinedByMode: new Map(),
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
        scheduleBackgroundRefine(molfile, request.options);
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
  const warmupMolfile = [
    "", "  warmup", "",
    "  3  2  0  0  0  0  0  0  0  0999 V2000",
    "    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
    "    1.5000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
    "    2.2500    1.2990    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0",
    "  1  2  1  0  0  0  0",
    "  2  3  1  0  0  0  0",
    "M  END"
  ].join("\n");
  try {
    // Warm whichever engine is in effect first, so the first real embed skips its
    // first-call cost (RDKit: WASM module init + JIT; OCL: torsion tables + JIT).
    const engine = await currentEngine();
    if (engine === "rdkit-wasm") {
      await rdkitGenerate3DConformerProgressive({ molfile: warmupMolfile }, { optimize: "none" });
    }
    await withOclConformerTrace((event) => postOclTrace(request, event), async () => {
      await ensureOclResources();
      // A tiny throwaway embed warms OCL's lazily-built torsion tables + JIT so the first
      // real molecule doesn't pay the ~1s first-call cost (OCL is always the fallback).
      await oclGenerate3DConformerProgressive({ molfile: warmupMolfile }, { optimize: "none" });
    });
    span.complete();
  } catch (error) {
    // Warmup is best-effort; real requests will surface real errors.
    span.fail(error);
  }
  post({ id: request.id, stage: "warmed" });
}

setOclResourcesUrl(oclResourcesUrl);
// Register the RDKit ETKDG WASM loader so currentEngine() can select it. If the vendored
// module is absent or fails to init, currentEngine() falls back to OCL (transparently).
registerRdkitWasmLoader();

globalThis.addEventListener("message", (event: MessageEvent<ConformerWorkRequest>) => {
  submit(event.data);
});
