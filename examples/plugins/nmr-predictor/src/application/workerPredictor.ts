import type {
  NmrPredictionRequest,
  NmrPredictor,
  NmrPredictorCapabilities
} from "../domain/contracts";
import type { NmrWorkerClient } from "../worker/nmrWorkerClient";

/**
 * Adapt an {@link NmrWorkerClient} to the {@link NmrPredictor} interface the command consumes, so the
 * command is agnostic to whether prediction runs in a worker or in-thread. `getCapabilities`
 * initializes the worker once (cached); `predict` forwards the request's `sourceFingerprint`. The
 * worker owns cancellation, so an omitted `AbortSignal` is fine.
 */
export function createWorkerBackedPredictor(
  client: NmrWorkerClient,
  providerId = "chemdraft.ocl-hose"
): NmrPredictor {
  let capabilities: Promise<NmrPredictorCapabilities> | undefined;
  return {
    getCapabilities() {
      capabilities ??= client.initialize(providerId);
      return capabilities;
    },
    predict(request: NmrPredictionRequest, signal?: AbortSignal) {
      return client.predict(request, request.sourceFingerprint, signal);
    }
  };
}
