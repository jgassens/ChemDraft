import type { AssistantStructureInspection } from "../assistant/AssistantToolContext";
import type { IdentityWorkerPort, StructureInspector } from "./identityProtocol";

export const IDENTITY_VERIFICATION_BUDGET_MS = 4_000;
export const IDENTITY_WORKER_STARTUP_MS = 10_000;
const IDENTITY_WORKER_IDLE_MS = 60_000;

export class IdentityVerificationTimeoutError extends Error {
  constructor(budgetMs: number) {
    super("ChemDraft could not verify this structure's stereochemistry within " +
      `${budgetMs / 1000} s; nothing was inserted.`);
    this.name = "IdentityVerificationTimeoutError";
  }
}

export class IdentityWorkerUnavailableError extends Error {}

/** The caller's timer can terminate synchronous WASM. Requests never run on the calling thread. */
export function createIdentityWorkerClient(
  factory: () => IdentityWorkerPort,
  budgetMs = IDENTITY_VERIFICATION_BUDGET_MS,
  startupMs = IDENTITY_WORKER_STARTUP_MS
): StructureInspector {
  let worker: IdentityWorkerPort | undefined;
  let ready = false;
  let nextId = 0;
  let tail: Promise<unknown> = Promise.resolve();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => {
    clearTimeout(idleTimer);
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      worker = undefined;
    }
    ready = false;
  };

  return (format, value, stereoReference) => {
    const run = (): Promise<AssistantStructureInspection> => new Promise((resolve, reject) => {
      clearTimeout(idleTimer);
      const id = ++nextId;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const finish = (result?: AssistantStructureInspection, error?: Error, kill = false): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (kill) stop();
        else if (worker) {
          worker.onmessage = null;
          worker.onerror = stop;
          worker.onmessageerror = stop;
          worker.unref?.();
          idleTimer = setTimeout(stop, IDENTITY_WORKER_IDLE_MS);
          if (typeof idleTimer === "object") idleTimer.unref?.();
        }
        if (result) resolve(result);
        else reject(error);
      };
      const inspect = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(undefined,
          new IdentityVerificationTimeoutError(budgetMs), true), budgetMs);
        worker?.postMessage({ id, format, value, stereoReference });
      };
      try {
        worker ??= factory();
        worker.ref?.();
        worker.onmessage = ({ data }) => {
          if (data.stage === "ready") {
            if (!ready) { ready = true; inspect(); }
          } else if (data.id === id) {
            if (data.stage === "result") finish(data.result);
            else finish(undefined, new Error(data.message));
          }
        };
        worker.onerror = ({ message }) => finish(undefined, ready
          ? new Error(`The chemical identity worker stopped: ${message}`)
          : new IdentityWorkerUnavailableError(message), true);
        worker.onmessageerror = () => finish(undefined,
          new Error("The chemical identity worker returned an unreadable message."), true);
        if (ready) inspect();
        else timer = setTimeout(() => finish(undefined, new IdentityWorkerUnavailableError(
          `The chemical identity engine did not initialize within ${startupMs / 1000} s.`), true), startupMs);
      } catch (error) {
        finish(undefined, error instanceof Error ? error : new Error(String(error)), true);
      }
    });
    const result = tail.then(run);
    tail = result.catch(() => {});
    return result;
  };
}
