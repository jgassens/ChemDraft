import type {
  NmrPredictionRequest,
  NmrPredictionResult,
  NmrPredictorCapabilities
} from "../domain/contracts";
import { NmrError, NmrErrorCodes, type NmrErrorCode } from "../domain/errors";
import type { NmrWorkerRequest, NmrWorkerResponse } from "./protocol";

export interface NmrWorkerClient {
  initialize(providerId: string): Promise<NmrPredictorCapabilities>;
  predict(
    request: NmrPredictionRequest,
    sourceFingerprint: string,
    signal?: AbortSignal
  ): Promise<NmrPredictionResult>;
  dispose(): void;
}

type PendingInitialize = {
  kind: "initialize";
  resolve: (capabilities: NmrPredictorCapabilities) => void;
  reject: (error: unknown) => void;
};

type PendingPredict = {
  kind: "predict";
  resolve: (result: NmrPredictionResult) => void;
  reject: (error: unknown) => void;
  detach: () => void;
};

type Pending = PendingInitialize | PendingPredict;

/**
 * Main-thread client for the NMR worker, in the conformer client's style: a lazily-created worker
 * (spawned on first use, so a rarely-used feature costs nothing at startup), request-id correlation,
 * and cancellation that does not rely on the provider alone — a result whose request is no longer
 * active is dropped. Pass a `workerFactory` in tests; without one and without `Worker` support, calls
 * reject cleanly rather than throwing at construction.
 */
export function createNmrWorkerClient(workerFactory?: () => Worker): NmrWorkerClient {
  let worker: Worker | null = null;
  let nextId = 1;
  const pending = new Map<string, Pending>();
  let activePredictId: string | undefined;

  const handleMessage = (event: MessageEvent<NmrWorkerResponse>): void => {
    const message = event.data;
    const request = pending.get(message.requestId);
    if (!request) {
      return; // unknown / superseded / already-settled id — ignore
    }
    switch (message.type) {
      case "ready":
        if (request.kind === "initialize") {
          pending.delete(message.requestId);
          request.resolve(message.capabilities);
        }
        return;
      case "result":
        if (request.kind === "predict") {
          pending.delete(message.requestId);
          request.detach();
          if (message.requestId === activePredictId) {
            request.resolve(message.result);
          } else {
            request.reject(new NmrError(NmrErrorCodes.PredictionCancelled, "Prediction was superseded."));
          }
        }
        return;
      case "cancelled":
        pending.delete(message.requestId);
        if (request.kind === "predict") {
          request.detach();
        }
        request.reject(new NmrError(NmrErrorCodes.PredictionCancelled, "Prediction was cancelled."));
        return;
      case "error":
        pending.delete(message.requestId);
        if (request.kind === "predict") {
          request.detach();
        }
        request.reject(
          new NmrError(message.error.code as NmrErrorCode, message.error.message, asDetails(message.error.details))
        );
        return;
    }
  };

  const handleCrash = (): void => {
    const failures = [...pending.values()];
    pending.clear();
    disposeWorker();
    for (const request of failures) {
      if (request.kind === "predict") {
        request.detach();
      }
      request.reject(new NmrError(NmrErrorCodes.ProviderFailure, "The NMR worker crashed."));
    }
  };

  const disposeWorker = (): void => {
    try {
      worker?.terminate?.();
    } catch {
      /* already dead */
    }
    worker = null;
  };

  const ensureWorker = (): Worker | null => {
    if (worker) {
      return worker;
    }
    if (!workerFactory && typeof Worker === "undefined") {
      return null;
    }
    try {
      worker = workerFactory
        ? workerFactory()
        : new Worker(new URL("./nmrWorker.ts", import.meta.url), { type: "module" });
    } catch {
      worker = null;
      return null;
    }
    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleCrash);
    worker.addEventListener("messageerror", handleCrash);
    return worker;
  };

  const send = (request: NmrWorkerRequest): boolean => {
    const target = ensureWorker();
    if (!target) {
      return false;
    }
    target.postMessage(request);
    return true;
  };

  return {
    initialize(providerId) {
      return new Promise<NmrPredictorCapabilities>((resolve, reject) => {
        const requestId = `init-${nextId++}`;
        pending.set(requestId, { kind: "initialize", resolve, reject });
        if (!send({ type: "initialize", requestId, providerId })) {
          pending.delete(requestId);
          reject(
            new NmrError(NmrErrorCodes.ProviderInitializationFailed, "The NMR worker is unavailable in this environment.")
          );
        }
      });
    },
    predict(request, sourceFingerprint, signal) {
      return new Promise<NmrPredictionResult>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new NmrError(NmrErrorCodes.PredictionCancelled, "Prediction was cancelled."));
          return;
        }
        const requestId = `predict-${nextId++}`;
        activePredictId = requestId;
        const onAbort = (): void => {
          const entry = pending.get(requestId);
          if (!entry) {
            return;
          }
          pending.delete(requestId);
          entry.reject(new NmrError(NmrErrorCodes.PredictionCancelled, "Prediction was cancelled."));
          send({ type: "cancel", requestId });
        };
        const detach = (): void => signal?.removeEventListener("abort", onAbort);
        pending.set(requestId, { kind: "predict", resolve, reject, detach });
        signal?.addEventListener("abort", onAbort, { once: true });
        if (!send({ type: "predict", requestId, request, sourceFingerprint })) {
          pending.delete(requestId);
          detach();
          reject(new NmrError(NmrErrorCodes.ProviderFailure, "The NMR worker is unavailable in this environment."));
        }
      });
    },
    dispose() {
      const failures = [...pending.values()];
      pending.clear();
      disposeWorker();
      for (const request of failures) {
        if (request.kind === "predict") {
          request.detach();
        }
        request.reject(new NmrError(NmrErrorCodes.ProviderFailure, "The NMR worker client was disposed."));
      }
    }
  };
}

function asDetails(details: unknown): Readonly<Record<string, unknown>> | undefined {
  return details !== null && typeof details === "object" ? (details as Record<string, unknown>) : undefined;
}
