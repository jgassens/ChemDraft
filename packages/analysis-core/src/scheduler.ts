/**
 * Interactive analysis scheduling (PLANS.md §5).
 *
 * "Cancellation and supersession when the structure edits mid-calculation. Debouncing for interactive
 * analysis. Memory and molecule-size limits."
 *
 * Engine-neutral on purpose: the scheduler owns *when* an analysis runs and *whether* the answer is
 * still wanted, and knows nothing about RDKit. Both engine-facing pieces are injected, so the whole
 * policy is testable in Node against a fake that never loads a byte of WASM.
 *
 * The organising idea is a **slot**. A slot is a thing being analysed — the current selection, a
 * particular molecule id — and it holds at most one live analysis. A second request for the same slot
 * supersedes the first, because the user edited and the older answer is now about a molecule that no
 * longer exists. Different slots do not interfere.
 *
 * Every outcome is an `AnalysisRun`. A superseded request resolves with status `cancelled` and no
 * results, not a rejected promise — §5 says runtime failures map onto `AnalysisStatus`, "never onto
 * prose warnings", and a scheduling outcome is no different. Callers that only render `run.results`
 * need no special case at all.
 */
import type { MolecularInterpretation } from "./interpretation";
import {
  AnalysisSessionCache,
  analysisRequestKey,
  emptyAnalysisRun,
  type AnalysisRequestSpec
} from "./session";
import type { AnalysisWarning } from "./provenance";
import type { AnalysisRun } from "./results";

/** Trips when the caller has lost interest. The transport should stop as soon as it notices. */
export interface AnalysisSignal {
  readonly cancelled: boolean;
  /** Fires once, when the request is superseded or cancelled. */
  onCancel(listener: () => void): void;
}

export interface AnalysisSchedulerOptions {
  /**
   * Execute one analysis. May resolve with a run of any status; may also honour `signal` and resolve
   * early. A rejection is turned into a `failed` run rather than propagated, so a caller never has to
   * handle two error channels for one question.
   */
  run(spec: AnalysisRequestSpec, signal: AnalysisSignal): Promise<AnalysisRun>;
  /**
   * The `source` interpretation for a spec, used to build the result-less runs that scheduling
   * outcomes produce. Injected because the policy strings ("as-drawn", "rdkit-default") are the
   * engine's vocabulary, not the scheduler's.
   */
  interpretationFor(spec: AnalysisRequestSpec): MolecularInterpretation;
  /** Monotonic ids and timestamps, supplied so a run's identity never depends on a clock this owns. */
  now(): string;
  cache?: AnalysisSessionCache;
  /**
   * Coalescing window for interactive requests. Typing in a formula or dragging a bond produces a
   * request per keystroke; only the last one is about a structure the user still has.
   */
  debounceMs?: number;
  /**
   * Refuse an input longer than this before anything parses it. The cheap guard: a pasted megabyte of
   * text costs nothing to reject and a lot to sanitise.
   */
  maxInputLength?: number;
  /** Engine artifact hashes, folded into the cache key so a rebuilt WASM cannot serve stale numbers. */
  engineHashes?: readonly string[];
}

export interface ScheduleOptions {
  /** Skip the debounce — for an explicit "Analyze" click, where the user already waited. */
  immediate?: boolean;
}

interface SlotState {
  timer?: ReturnType<typeof setTimeout>;
  /** Resolves the promise handed to the caller for the request currently occupying the slot. */
  settle?: (run: AnalysisRun) => void;
  signal?: MutableSignal;
  spec?: AnalysisRequestSpec;
}

class MutableSignal implements AnalysisSignal {
  #cancelled = false;
  readonly #listeners: (() => void)[] = [];

  get cancelled(): boolean {
    return this.#cancelled;
  }

  onCancel(listener: () => void): void {
    if (this.#cancelled) {
      listener();
      return;
    }
    this.#listeners.push(listener);
  }

  cancel(): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    for (const listener of this.#listeners.splice(0)) listener();
  }
}

const DEFAULT_DEBOUNCE_MS = 120;
const DEFAULT_MAX_INPUT_LENGTH = 100_000;

export class AnalysisScheduler {
  readonly #options: AnalysisSchedulerOptions;
  readonly #slots = new Map<string, SlotState>();
  readonly #cache: AnalysisSessionCache;
  #nextRunId = 1;

  constructor(options: AnalysisSchedulerOptions) {
    this.#options = options;
    this.#cache = options.cache ?? new AnalysisSessionCache();
  }

  get cache(): AnalysisSessionCache {
    return this.#cache;
  }

  /**
   * Request analysis for `slot`, superseding whatever that slot was doing.
   *
   * Resolves with the run, or with a result-less `cancelled` run if a newer request for the same slot
   * arrived first. Never rejects.
   */
  request(slot: string, spec: AnalysisRequestSpec, options: ScheduleOptions = {}): Promise<AnalysisRun> {
    this.#supersede(slot);

    // Refuse FIRST. `#refuse` is an O(1) length compare; `analysisRequestKey` hashes the entire input
    // with a BigInt-multiply-per-character FNV-1a, measured at 6.6 ms for 100 KB and 47 ms for 1 MB in
    // JavaScriptCore — the engine the WKWebView actually runs. Hashing before refusing meant an
    // oversized paste was fully hashed and then rejected by a length check, which is the opposite of
    // this module's own stated intent ("a pasted megabyte of text costs nothing to reject"). Nothing
    // is lost by reordering: `#refuse` reads only `spec.value.length`, and a refusal is never cached.
    const refusal = this.#refuse(spec);
    if (refusal) return Promise.resolve(refusal);

    const key = analysisRequestKey(spec, this.#options.engineHashes ?? []);
    const cached = this.#cache.get(key);
    // A cache hit skips the debounce entirely: there is nothing to coalesce, and making an instant
    // answer wait 120 ms would defeat the reason the cache exists.
    if (cached) return Promise.resolve(cached);

    const state: SlotState = { spec };
    this.#slots.set(slot, state);

    return new Promise<AnalysisRun>((resolve) => {
      state.settle = resolve;
      const start = (): void => {
        state.timer = undefined;
        const signal = new MutableSignal();
        state.signal = signal;

        const failed = (error: unknown): void => {
          if (signal.cancelled) return;
          this.#settle(
            slot,
            state,
            this.#emptyRun(spec, "failed", [
              {
                code: "analysis.engine_error",
                severity: "error",
                message: error instanceof Error ? error.message : String(error),
                affectedResultIds: []
              }
            ])
          );
        };

        // `run` is called SYNCHRONOUSLY and its throw caught here, rather than being deferred through
        // `Promise.resolve().then(...)`. A transport that throws synchronously used to escape both
        // paths: on the debounce path the throw unwound out of a `setTimeout` callback, so the slot's
        // promise never settled and the caller hung forever; on the immediate path it propagated out
        // of `request`, which this method's docstring promises never happens ("Never rejects").
        // Deferring would fix that too, but it would also move worker creation and `postMessage` a
        // microtask later — an observable timing change for every caller, to fix a throw.
        let started: Promise<AnalysisRun>;
        try {
          started = this.#options.run(spec, signal);
        } catch (error) {
          failed(error);
          return;
        }

        void started.then((run) => {
          if (signal.cancelled) return;
          // Only cache a run that carries an answer. A `failed` run is a transport or engine fault,
          // not a property of the input — caching it made a single transient failure permanent for
          // that structure for the rest of the session, with no way to retry.
          if (run.status !== "failed") this.#cache.set(key, run);
          this.#settle(slot, state, run);
        }, failed);
      };

      if (options.immediate) start();
      else state.timer = setTimeout(start, this.#options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    });
  }

  /** Abandon whatever `slot` is doing. Its pending promise resolves as `cancelled`. */
  cancel(slot: string): void {
    this.#supersede(slot, "the analysis was cancelled");
  }

  cancelAll(): void {
    for (const slot of [...this.#slots.keys()]) this.cancel(slot);
  }

  /** Slots with work pending or in flight. */
  activeSlots(): string[] {
    return [...this.#slots.keys()];
  }

  #settle(slot: string, state: SlotState, run: AnalysisRun): void {
    if (this.#slots.get(slot) === state) this.#slots.delete(slot);
    state.settle?.(run);
    state.settle = undefined;
  }

  #supersede(slot: string, reason = "a newer request for the same selection replaced it"): void {
    const state = this.#slots.get(slot);
    if (!state) return;
    this.#slots.delete(slot);
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.signal?.cancel();
    if (state.settle && state.spec) {
      state.settle(
        this.#emptyRun(state.spec, "cancelled", [
          {
            code: "analysis.superseded",
            severity: "info",
            message: `Analysis did not complete: ${reason}.`,
            affectedResultIds: []
          }
        ])
      );
      state.settle = undefined;
    }
  }

  /** Size guards, applied before anything parses the input. */
  #refuse(spec: AnalysisRequestSpec): AnalysisRun | undefined {
    const limit = this.#options.maxInputLength ?? DEFAULT_MAX_INPUT_LENGTH;
    if (spec.value.length > limit) {
      return this.#emptyRun(spec, "unsupported", [
        {
          code: "structure.input_too_large",
          severity: "warning",
          message:
            `The structure input is ${spec.value.length} characters, over the ${limit}-character limit ` +
            "for interactive analysis.",
          affectedResultIds: []
        }
      ]);
    }
    return undefined;
  }

  #emptyRun(spec: AnalysisRequestSpec, status: "cancelled" | "failed" | "unsupported", warnings: AnalysisWarning[]): AnalysisRun {
    const runId = `scheduled-${this.#nextRunId}`;
    this.#nextRunId += 1;
    const startedAt = this.#options.now();
    return emptyAnalysisRun({
      runId,
      startedAt,
      finishedAt: startedAt,
      interpretation: this.#options.interpretationFor(spec),
      status,
      warnings
    });
  }
}
