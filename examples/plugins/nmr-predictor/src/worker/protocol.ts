import type { NmrPredictionRequest, NmrPredictionResult, NmrPredictorCapabilities } from "../domain/contracts";

/**
 * Serializable message protocol for the NMR worker boundary, mirroring the repository's conformer
 * worker/client convention (request-id correlated). Every payload is structured-clone safe.
 */
export type NmrWorkerRequest =
  | { type: "initialize"; requestId: string; providerId: string }
  | { type: "predict"; requestId: string; request: NmrPredictionRequest; sourceFingerprint?: string }
  | { type: "cancel"; requestId: string };

export interface NmrWorkerErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

export type NmrWorkerResponse =
  | { type: "ready"; requestId: string; capabilities: NmrPredictorCapabilities }
  | { type: "result"; requestId: string; result: NmrPredictionResult }
  | { type: "cancelled"; requestId: string }
  | { type: "error"; requestId: string; error: NmrWorkerErrorPayload };
