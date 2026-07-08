import type { NmrPredictor } from "../domain/contracts";
import { NmrErrorCodes, isNmrError } from "../domain/errors";
import { FixtureHosePredictor } from "../providers/fixture/FixtureHosePredictor";
import { OclHosePredictor } from "../providers/ocl/OclHosePredictor";
import type { NmrWorkerErrorPayload, NmrWorkerRequest, NmrWorkerResponse } from "./protocol";

/** Default provider selection by id: the experimental OCL-native predictor unless the fixture is
 *  explicitly requested (kept for deterministic tests). */
function defaultPredictor(providerId: string): NmrPredictor {
  return providerId === "chemdraft.fixture-hose" ? new FixtureHosePredictor() : new OclHosePredictor();
}

export interface NmrWorkerHandlerDeps {
  /** Provider factory, keyed by the initialize message's providerId. Defaults to the fixture provider. */
  createPredictor?: (providerId: string) => NmrPredictor;
}

/**
 * Pure message handler for the NMR worker — the whole worker boundary minus the `self` wiring, so it
 * unit-tests without a real Worker. It keeps one active calculation, aborts the prior one when a new
 * predict arrives, ignores results whose request is no longer active, and normalizes every error into
 * a serializable payload. Deterministic fixture behavior is preserved (the provider is deterministic).
 */
export function createNmrWorkerHandler(
  post: (response: NmrWorkerResponse) => void,
  deps: NmrWorkerHandlerDeps = {}
): (message: NmrWorkerRequest) => void {
  const createPredictor = deps.createPredictor ?? defaultPredictor;
  let predictor: NmrPredictor | undefined;
  let activeController: AbortController | undefined;
  let activeRequestId: string | undefined;

  const ensurePredictor = (providerId: string): NmrPredictor => {
    predictor ??= createPredictor(providerId);
    return predictor;
  };

  return (message) => {
    switch (message.type) {
      case "initialize": {
        // Lazy-load the provider; getCapabilities may be sync or async.
        Promise.resolve()
          .then(() => ensurePredictor(message.providerId).getCapabilities())
          .then(
            (capabilities) => post({ type: "ready", requestId: message.requestId, capabilities }),
            (error) => post({ type: "error", requestId: message.requestId, error: toErrorPayload(error) })
          );
        return;
      }
      case "predict": {
        activeController?.abort(); // one active calculation per client: cancel the predecessor
        const controller = new AbortController();
        activeController = controller;
        activeRequestId = message.requestId;
        const request = { ...message.request, sourceFingerprint: message.sourceFingerprint };
        Promise.resolve()
          .then(() => ensurePredictor("").predict(request, controller.signal))
          .then(
            (result) => {
              if (controller.signal.aborted || activeRequestId !== message.requestId) {
                post({ type: "cancelled", requestId: message.requestId });
                return;
              }
              post({ type: "result", requestId: message.requestId, result });
            },
            (error) => {
              if (controller.signal.aborted || isCancellation(error)) {
                post({ type: "cancelled", requestId: message.requestId });
                return;
              }
              post({ type: "error", requestId: message.requestId, error: toErrorPayload(error) });
            }
          );
        return;
      }
      case "cancel": {
        if (activeRequestId === message.requestId) {
          activeController?.abort();
        }
        post({ type: "cancelled", requestId: message.requestId });
        return;
      }
    }
  };
}

function isCancellation(error: unknown): boolean {
  return isNmrError(error) && error.code === NmrErrorCodes.PredictionCancelled;
}

function toErrorPayload(error: unknown): NmrWorkerErrorPayload {
  if (isNmrError(error)) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return {
    code: NmrErrorCodes.ProviderFailure,
    message: error instanceof Error ? error.message : String(error)
  };
}
