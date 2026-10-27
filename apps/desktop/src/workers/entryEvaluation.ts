/** Global rather than module-local: WebKit bootstrap/import instances share the worker global. */
export interface WorkerEntryEvaluation { worker: string; entryUrl: string; evaluations: number }
const counterKey = Symbol.for("org.chemdraft.workerEntryEvaluations");
const listenerKey = Symbol.for("org.chemdraft.workerEntryProfileListener");
const activityKey = Symbol.for("org.chemdraft.workerActivity");
const timerKey = Symbol.for("org.chemdraft.workerActivityTimers");

export interface WorkerActivity {
  stage: string;
  startedAtEpochMs: number;
  endedAtEpochMs?: number;
  details?: Record<string, unknown>;
}

/** Buffered rather than streamed: work between jobs must survive with no active host request.
 * Ordinary builds neither read clocks nor allocate records. An unfinished span identifies a hang. */
export function beginWorkerActivity(stage: string, details?: Record<string, unknown>): (() => void) | undefined {
  if (import.meta.env?.CHEMDRAFT_WKPROFILE !== "1") return;
  const scope = globalThis as typeof globalThis & { [activityKey]?: WorkerActivity[] };
  const activities = scope[activityKey] ??= [];
  const record: WorkerActivity = { stage, startedAtEpochMs: performance.timeOrigin + performance.now(),
    ...(details ? { details } : {}) };
  activities.push(record);
  if (activities.length > 1000) activities.shift();
  return () => { record.endedAtEpochMs = performance.timeOrigin + performance.now(); };
}

export function profileWorkerActivity<T>(stage: string, run: () => Promise<T>, details?: Record<string, unknown>): Promise<T> {
  const finish = beginWorkerActivity(stage, details);
  if (!finish) return run();
  try { return run().finally(finish); }
  catch (error) { finish(); throw error; }
}

/** Profiler only. Capture dependency callbacks as well as our scheduler; no heartbeat/timer
 * is created. Installed before OCL evaluates and captures its bound timer functions. */
export function installWorkerActivityTimers(scope: Pick<typeof globalThis, "setTimeout" | "setInterval" | "queueMicrotask">): void {
  if (import.meta.env?.CHEMDRAFT_WKPROFILE !== "1" || Reflect.get(scope, timerKey)) return;
  Reflect.set(scope, timerKey, true);
  for (const name of ["setTimeout", "setInterval", "queueMicrotask"] as const) {
    const original = scope[name];
    const wrapped = (callback: unknown, ...args: unknown[]) => {
      if (typeof callback !== "function") return Reflect.apply(original, scope, [callback, ...args]);
      const scheduledAtEpochMs = performance.timeOrigin + performance.now();
      return Reflect.apply(original, scope, [(...delivered: unknown[]) => {
        const finish = beginWorkerActivity(`worker.callback.${name}`, {
          scheduledAtEpochMs, callback: callback.name, ...(name === "queueMicrotask" ? {} : { delayMs: args[0] ?? 0 })
        });
        try { return Reflect.apply(callback, name === "queueMicrotask" ? undefined : scope, delivered); }
        finally { finish?.(); }
      }, ...args]);
    };
    Reflect.set(scope, name, wrapped);
  }
}

export function recordWorkerEntryEvaluation(worker: string, entryUrl: string): void {
  if (import.meta.env?.CHEMDRAFT_WKPROFILE !== "1") return;
  const scope = globalThis as typeof globalThis & {
    [counterKey]?: Record<string, WorkerEntryEvaluation>;
    [listenerKey]?: boolean;
  };
  const counters = scope[counterKey] ??= {};
  const previous = counters[worker];
  counters[worker] = { worker, entryUrl, evaluations: (previous?.evaluations ?? 0) + 1 };
  installProfileListener();
}

function installProfileListener(): void {
  const scope = globalThis as typeof globalThis & {
    [counterKey]?: Record<string, WorkerEntryEvaluation>;
    [listenerKey]?: boolean;
    [activityKey]?: WorkerActivity[];
  };
  // Only the opt-in profiler build exposes counters over messages. Ordinary workers add no listener.
  if (import.meta.env?.CHEMDRAFT_WKPROFILE !== "1" || scope[listenerKey]) return;
  // Worker detection keeps page imports and Node test runners' own timers untouched.
  if (typeof Reflect.get(scope, "WorkerGlobalScope") === "function") installWorkerActivityTimers(scope);
  scope[listenerKey] = true;
  scope.addEventListener("message", event => {
    const message = event as MessageEvent;
    if (message.data?.kind !== "chemdraft-worker-profile-request") return;
    // Installed before runtime listeners: diagnostic requests must not enter chemistry protocols.
    message.stopImmediatePropagation();
    scope.postMessage({ kind: "chemdraft-worker-profile", requestId: message.data.requestId,
      entries: Object.values(scope[counterKey] ?? {}),
      ...(scope[activityKey]?.length ? { activity: scope[activityKey] } : {}) });
  });
}

// An entry may statically import a runtime with evaluation-time listeners. Import this module
// first so diagnostic messages are intercepted before those listeners, without any async boundary.
installProfileListener();
