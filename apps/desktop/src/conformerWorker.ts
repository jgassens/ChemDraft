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
  setOclResourcesUrl
} from "@chemdraft/ocl-adapter";
import type { Generate3DConformerResult } from "@chemdraft/chemistry-adapter";
import { oclResourcesUrl } from "./oclResources";

export interface ConformerWorkRequest {
  kind: "generate" | "prefetch" | "warmup";
  id: number;
  molfile?: string;
  originalAtomCount?: number;
}

export interface ConformerWorkResponse {
  id: number;
  stage: "embedded" | "refined" | "error" | "warmed";
  result?: Generate3DConformerResult;
  message?: string;
}

/** Depiction-grade cap — reaches essentially the converged energy at half the cost. */
const REFINE_MAX_ITERATIONS = 800;
const CACHE_LIMIT = 6;

interface CacheEntry {
  embedded: Generate3DConformerResult;
  refined?: Generate3DConformerResult;
}

const cache = new Map<string, CacheEntry>();

function cachePut(molfile: string, entry: CacheEntry): void {
  cache.delete(molfile);
  cache.set(molfile, entry);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

const post = (response: ConformerWorkResponse) =>
  (globalThis as unknown as { postMessage(message: ConformerWorkResponse): void }).postMessage(response);

// Strictly sequential job chain — OCL calls are synchronous and CPU-bound, so
// there is no benefit to interleaving; ordering keeps cache/in-flight logic trivial.
let queue: Promise<void> = Promise.resolve();

function enqueue(job: () => Promise<void>): void {
  queue = queue.then(job).catch(() => undefined);
}

async function runGenerate(request: ConformerWorkRequest): Promise<void> {
  const molfile = request.molfile ?? "";
  const isPrefetch = request.kind === "prefetch";
  try {
    const hit = cache.get(molfile);
    if (hit) {
      cachePut(molfile, hit); // refresh LRU position
      if (!isPrefetch) {
        post({ id: request.id, stage: "embedded", result: hit.embedded });
        if (hit.refined) post({ id: request.id, stage: "refined", result: hit.refined });
      }
      // A prefetch hit (or a hit still missing refinement) needs no recompute: a
      // missing `refined` means refinement previously failed setup — don't retry.
      return;
    }

    const { embedded, refine } = await generate3DConformerProgressive(
      { molfile, originalAtomCount: request.originalAtomCount },
      { optimize: "auto", maxMinimiseIterations: REFINE_MAX_ITERATIONS }
    );
    if (embedded.embed.status !== "ok") {
      if (!isPrefetch) post({ id: request.id, stage: "embedded", result: embedded });
      return; // never cache failures — a retry should re-attempt
    }
    if (!isPrefetch) post({ id: request.id, stage: "embedded", result: embedded });
    const entry: CacheEntry = { embedded };
    cachePut(molfile, entry);

    if (refine) {
      const refined = refine();
      entry.refined = refined;
      if (!isPrefetch) post({ id: request.id, stage: "refined", result: refined });
    }
  } catch (error) {
    if (!isPrefetch) post({ id: request.id, stage: "error", message: (error as Error).message });
  }
}

setOclResourcesUrl(oclResourcesUrl);

globalThis.addEventListener("message", (event: MessageEvent<ConformerWorkRequest>) => {
  const request = event.data;
  if (request.kind === "warmup") {
    enqueue(async () => {
      try {
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
      } catch {
        // Warmup is best-effort; real requests will surface real errors.
      }
      post({ id: request.id, stage: "warmed" });
    });
    return;
  }
  enqueue(() => runGenerate(request));
});
