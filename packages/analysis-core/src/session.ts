/**
 * Session cache and request identity (PLANS.md §5).
 *
 * "A session cache on the §1 keys — nearly free, and it is what makes the Analyze panel feel instant."
 *
 * The §1 key is source hash + interpretation hash + method + parameters + engine/model/data hashes.
 * `analysisCacheKey` in ./interpretation covers one method against one interpretation, which is the
 * right grain for a per-method memo. A *request* is coarser — a set of methods, a fallback policy, an
 * override — and `analysisRequestKey` below is its counterpart: computable **before** the run, which
 * `runFingerprint` is not, because a fingerprint reads the interpretations the run actually derived.
 *
 * The two must not be confused. A key you can only compute after doing the work is not a cache key.
 */
import { analysisHash } from "./interpretation";
import type { MolecularInterpretation } from "./interpretation";
import type { AnalysisWarning } from "./provenance";
import {
  AnalysisSchemaVersion,
  runFingerprint,
  type AnalysisRun,
  type AnalysisStatus,
  type EngineEnvironment
} from "./results";

/** Everything about a request that can change its answer. */
export interface AnalysisRequestSpec {
  format: string;
  value: string;
  /** Restrict to these methods. Order-insensitive: the key sorts them. */
  methodIds?: readonly string[];
  /** Derived interpretations to fall back to, in preference order. Order IS significant. */
  fallbackInterpretations?: readonly string[];
  interpretationOverride?: string;
}

/**
 * A cache key for a whole request.
 *
 * `methodIds` sorts because asking for {tpsa, logP} and {logP, tpsa} is one question;
 * `fallbackInterpretations` does **not**, because preference order decides which derived interpretation
 * answers first. `undefined` and `[]` are deliberately different keys: the first means "every method",
 * the second means "no fallbacks at all".
 */
export function analysisRequestKey(spec: AnalysisRequestSpec, engineHashes: readonly string[] = []): string {
  return analysisHash(
    [
      spec.format,
      spec.value,
      spec.methodIds ? `methods:${[...spec.methodIds].sort().join(",")}` : "methods:*",
      spec.fallbackInterpretations
        ? `fallbacks:${spec.fallbackInterpretations.join(">")}`
        : "fallbacks:default",
      `override:${spec.interpretationOverride ?? ""}`,
      `engines:${[...engineHashes].sort().join(",")}`
    ].join(" ")
  );
}

export interface AnalysisSessionCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
}

/**
 * A bounded, least-recently-used session cache.
 *
 * Bounded because runs are not small — a spectrum or an orbital grid is a typed array whose length
 * scales with the molecule — and an unbounded memo on an interactive panel is a leak with a nicer name.
 * Recency rather than insertion order, because the interactive pattern is "edit, re-analyse, undo,
 * re-analyse", and undo should hit.
 *
 * Deliberately not persisted. The key includes engine artifact hashes, so a cache that outlived the
 * process would still be correct — but a session cache is what §5 asks for, and correctness across
 * restarts is a different problem with a different budget.
 */
export class AnalysisSessionCache {
  readonly #entries = new Map<string, AnalysisRun>();
  readonly #maxEntries: number;
  #hits = 0;
  #misses = 0;
  #evictions = 0;

  constructor(options: { maxEntries?: number } = {}) {
    const maxEntries = options.maxEntries ?? 64;
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error(`AnalysisSessionCache maxEntries must be a positive integer, received ${maxEntries}.`);
    }
    this.#maxEntries = maxEntries;
  }

  get(key: string): AnalysisRun | undefined {
    const run = this.#entries.get(key);
    if (!run) {
      this.#misses += 1;
      return undefined;
    }
    // Re-insert to mark it most-recently-used; Map preserves insertion order.
    this.#entries.delete(key);
    this.#entries.set(key, run);
    this.#hits += 1;
    return run;
  }

  set(key: string, run: AnalysisRun): void {
    if (this.#entries.has(key)) this.#entries.delete(key);
    this.#entries.set(key, run);
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
      this.#evictions += 1;
    }
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  stats(): AnalysisSessionCacheStats {
    return { hits: this.#hits, misses: this.#misses, evictions: this.#evictions, size: this.#entries.size };
  }
}

/**
 * A run that never reached the engine — superseded, cancelled, timed out, or refused for size.
 *
 * §5: runtime failures "map onto `AnalysisStatus` and `applicability`, **never** onto prose warnings".
 * That applies to scheduling outcomes too. A superseded analysis is a run with status `cancelled` and
 * no results, not a rejected promise the caller has to pattern-match on, and it validates against
 * `AnalysisRunSchema` like any other.
 */
export function emptyAnalysisRun(input: {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  interpretation: MolecularInterpretation;
  status: AnalysisStatus;
  warnings: AnalysisWarning[];
  engines?: readonly EngineEnvironment[];
}): AnalysisRun {
  if (input.status === "ok") {
    // "ok" with nothing in it would render as a successful analysis that found nothing to say.
    throw new Error('emptyAnalysisRun cannot produce an "ok" run; a run with no results did not succeed.');
  }
  if (input.warnings.length === 0) {
    throw new Error(`emptyAnalysisRun requires a warning explaining status "${input.status}".`);
  }

  return {
    schemaVersion: AnalysisSchemaVersion,
    runId: input.runId,
    sourceHash: input.interpretation.sourceHash,
    interpretations: [input.interpretation],
    engines: [...(input.engines ?? [])],
    startedAt: input.startedAt,
    ...(input.finishedAt ? { finishedAt: input.finishedAt } : {}),
    status: input.status,
    results: [],
    warnings: input.warnings,
    fingerprint: runFingerprint({
      sourceHash: input.interpretation.sourceHash,
      interpretationHashes: [input.interpretation.interpretationHash],
      methodKeys: [],
      engineHashes: (input.engines ?? []).flatMap((engine) => engine.artifactHashes)
    })
  };
}
