/** Shared browser/Node transport. A timer on the calling thread can interrupt stuck WASM. */
export const DEPICTION_DEADLINE_MS = 2_000;
export const DEPICTION_STARTUP_DEADLINE_MS = 10_000;
export const DEPICTION_IDLE_MS = 60_000;
export const DEPICTION_LOAD_FAILURE = "The 2D depiction worker failed to load.";
export const DEPICTION_CRASH_FAILURE = "The 2D depiction worker stopped unexpectedly.";

export type DepictionReply<T> =
  | { id: number; stage: "ready" }
  | { id: number; stage: "standard"; result: T }
  | { id: number; stage: "result"; result: T }
  | { id: number; stage: "error"; message: string; name?: string; smilesChemistryRefusal?: boolean; notSmiles?: boolean };

export interface DepictionWorkerPort<T> {
  /** Readiness means at least one engine loaded and both initialization attempts settled. */
  initializing?: boolean;
  postMessage(request: { id: number; smiles: string; standardOnly?: boolean }): void;
  terminate(): void;
  ref?(): void;
  unref?(): void;
  onmessage: ((event: { data: DepictionReply<T> }) => void) | null;
  onerror: ((event: { message: string }) => void) | null;
  onmessageerror?: (() => void) | null;
}

export interface DepictionRequestOptions {
  signal?: AbortSignal;
  /** Interactive paste can pass queued list entries, without interrupting another layout. */
  priority?: "interactive" | "background";
}

interface WarnableDepiction { warnings?: string[] }

/** Serializes layouts, with independent cancellation and budgets for bootstrap and each attempt. */
export function createDepictionWorkerClient<T extends WarnableDepiction>(
  factory: () => DepictionWorkerPort<T>,
  deadlineMs = DEPICTION_DEADLINE_MS
): (smiles: string, options?: DepictionRequestOptions) => Promise<T> {
  let worker: DepictionWorkerPort<T> | undefined;
  let nextId = 0;
  let active = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  type Task = { priority: number; start(): Promise<void> };
  const queue: Task[] = [];
  const stop = (): void => {
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      worker = undefined;
    }
  };
  const idle = (): void => {
    // Keep death listeners installed between requests; a dead worker cannot be reused.
    if (worker) {
      worker.onerror = stop;
      worker.onmessageerror = stop;
    }
    worker?.unref?.();
    idleTimer = setTimeout(stop, DEPICTION_IDLE_MS);
    // Node commands must not wait for an idle worker or its eviction timer to exit.
    (idleTimer as unknown as { unref?: () => void }).unref?.();
  };
  const pump = (): void => {
    if (active) return;
    const task = queue.shift();
    if (!task) return;
    active = true;
    void task.start().finally(() => { active = false; pump(); });
  };
  const abortError = (): Error => Object.assign(new Error("2D depiction cancelled."), { name: "AbortError" });
  const warned = (result: T, warning: string): T => ({ ...result, warnings: [...(result.warnings ?? []), warning] });

  return (smiles, options = {}) => new Promise<T>((resolve, reject) => {
    const signal = options.signal;
    if (signal?.aborted) { reject(abortError()); return; }
    let cancelActive: (() => void) | undefined;
    const abort = (): void => {
      const index = queue.indexOf(task);
      if (index >= 0) {
        queue.splice(index, 1);
        signal?.removeEventListener("abort", abort);
        reject(abortError());
      } else cancelActive?.();
    };
    const attempt = (standardOnly: boolean): Promise<T> => new Promise<T>((accept, refuse) => {
      if (signal?.aborted) { refuse(abortError()); return; }
      clearTimeout(idleTimer);
      const id = ++nextId;
      let standard: T | undefined;
      let timer: ReturnType<typeof setTimeout>;
      let done = false;
      const finish = (result: T | undefined, error?: Error, kill = false): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cancelActive = undefined;
        if (worker) { worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; }
        if (kill) stop();
        else idle();
        if (result !== undefined) accept(result);
        else refuse(error);
      };
      const startLayout = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const warning = `2D depiction exceeded its ${deadlineMs} ms layout deadline; used the standard layout.`;
          finish(standard === undefined ? undefined : warned(standard, warning),
            Object.assign(new Error(`2D depiction exceeded its ${deadlineMs} ms layout deadline before a standard layout was available.`),
              { retryStandard: true }), true);
        }, deadlineMs);
        worker!.postMessage({ id, smiles, ...(standardOnly ? { standardOnly: true } : {}) });
      };
      cancelActive = () => finish(undefined, abortError(), true);
      try {
        worker ??= factory();
        worker.ref?.();
        worker.onmessage = ({ data }) => {
          if (data.stage === "ready") {
            if (worker?.initializing) { worker.initializing = false; startLayout(); }
            return;
          }
          if (data.id !== id) return;
          if (data.stage === "standard") { standard = data.result; return; }
          if (data.stage === "result") { finish(data.result); return; }
          finish(undefined, Object.assign(new Error(data.message || "The 2D depiction engine failed."), {
            name: data.name ?? "Error", smilesChemistryRefusal: data.smilesChemistryRefusal === true,
            notSmiles: data.notSmiles === true
          }));
        };
        worker.onerror = ({ message }) => {
          const summary = worker?.initializing ? DEPICTION_LOAD_FAILURE : DEPICTION_CRASH_FAILURE;
          const detail = message.trim();
          const failure = detail ? `${summary} ${detail}` : summary;
          finish(standard === undefined ? undefined : warned(standard, `${failure} Used the standard layout.`),
            new Error(failure), true);
        };
        worker.onmessageerror = () => finish(undefined, new Error("The 2D depiction worker returned an unreadable message."), true);
        if (worker.initializing) {
          timer = setTimeout(() => finish(undefined,
            new Error(`2D depiction engine initialization exceeded its ${DEPICTION_STARTUP_DEADLINE_MS} ms deadline.`), true
          ), DEPICTION_STARTUP_DEADLINE_MS);
        } else startLayout();
      } catch (error) {
        finish(undefined, error instanceof Error ? error : new Error(String(error)), true);
      }
    });
    const task: Task = {
      priority: options.priority === "interactive" ? 1 : 0,
      async start() {
        try {
          let result: T;
          try { result = await attempt(false); }
          catch (error) {
            if (signal?.aborted) throw abortError();
            if (!(error as { retryStandard?: boolean })?.retryStandard) throw error;
            // A fresh worker gets a separate bootstrap cap, then one standard/OCL-only layout try.
            result = warned(await attempt(true),
              "2D depiction reached its layout deadline; retried the standard layout in a fresh worker.");
          }
          if (signal?.aborted) throw abortError();
          resolve(result);
        } catch (error) { reject(error); }
        finally { signal?.removeEventListener("abort", abort); }
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    const before = queue.findIndex((queued) => queued.priority < task.priority);
    if (before < 0) queue.push(task);
    else queue.splice(before, 0, task);
    queueMicrotask(pump);
  });
}
