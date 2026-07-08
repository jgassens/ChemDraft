import { describe, expect, it } from "vitest";

import type { NmrPredictor, NmrPredictionResult } from "../domain/contracts";
import { createNmrWorkerHandler } from "../worker/nmrWorkerCore";
import type { NmrWorkerResponse } from "../worker/protocol";

const FP = "fp-1";
const OPTIONS = { statistic: "median" as const, hoseLevels: [2], ignoreLabileHydrogens: true };

function collector() {
  const responses: NmrWorkerResponse[] = [];
  return { responses, post: (response: NmrWorkerResponse) => responses.push(response) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createNmrWorkerHandler", () => {
  it("initializes and reports the provider capabilities", async () => {
    const { responses, post } = collector();
    const handle = createNmrWorkerHandler(post);
    handle({ type: "initialize", requestId: "i1", providerId: "chemdraft.fixture-hose" });
    await flush();
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ type: "ready", requestId: "i1", capabilities: { id: "chemdraft.fixture-hose" } });
  });

  it("predicts and returns a result for the requested structure", async () => {
    const { responses, post } = collector();
    const handle = createNmrWorkerHandler(post);
    handle({
      type: "predict",
      requestId: "p1",
      sourceFingerprint: FP,
      request: { structure: { format: "smiles", value: "c1ccccc1" }, nuclei: ["13C"], options: OPTIONS }
    });
    await flush();
    const result = responses.find((response) => response.type === "result");
    expect(result).toBeDefined();
    expect(result && result.type === "result" && result.result.sourceFingerprint).toBe(FP);
  });

  it("normalizes a domain error into an error response", async () => {
    const { responses, post } = collector();
    const handle = createNmrWorkerHandler(post);
    handle({
      type: "predict",
      requestId: "p1",
      sourceFingerprint: FP,
      request: { structure: { format: "smiles", value: "" }, nuclei: ["13C"], options: OPTIONS }
    });
    await flush();
    expect(responses[0]).toMatchObject({ type: "error", requestId: "p1", error: { code: "NMR_EMPTY_STRUCTURE" } });
  });

  it("cancels the prior calculation when a new predict arrives (one active per client)", async () => {
    // A controllable predictor keeps the first predict in-flight until we release it.
    let releaseFirst: ((result: NmrPredictionResult) => void) | undefined;
    const result: NmrPredictionResult = {
      schemaVersion: "1",
      sourceFingerprint: FP,
      backend: { id: "x", version: "1", method: "fixture-fragment" },
      resonances: [],
      warnings: [],
      generatedAt: "t"
    };
    let call = 0;
    const predictor: NmrPredictor = {
      getCapabilities: () => ({
        id: "x",
        version: "1",
        execution: "worker-js",
        nuclei: ["13C"],
        supportsAtomAssignments: true,
        supportsUncertainty: true,
        supportsCouplings: false,
        supportsSolvent: false,
        supportsConformers: false,
        supportsStereochemistry: false
      }),
      predict: (_request, signal) => {
        call += 1;
        if (call === 1) {
          return new Promise<NmrPredictionResult>((resolve, reject) => {
            // Mirror the real provider: an already-aborted signal rejects up front (a fresh
            // "abort" listener never fires for a signal that aborted before it was attached).
            if (signal?.aborted) {
              reject(new Error("aborted"));
              return;
            }
            releaseFirst = resolve;
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
        return Promise.resolve(result);
      }
    };

    const { responses, post } = collector();
    const handle = createNmrWorkerHandler(post, { createPredictor: () => predictor });

    handle({ type: "predict", requestId: "a", sourceFingerprint: FP, request: baseRequest() });
    handle({ type: "predict", requestId: "b", sourceFingerprint: FP, request: baseRequest() });
    await flush();

    // The second predict resolves; the first was aborted → reported cancelled, not a result.
    expect(responses.some((response) => response.type === "result" && response.requestId === "b")).toBe(true);
    expect(responses.some((response) => response.type === "cancelled" && response.requestId === "a")).toBe(true);
    expect(responses.some((response) => response.type === "result" && response.requestId === "a")).toBe(false);
    // Releasing the (already-aborted) first predict must not emit a stray result for "a".
    releaseFirst?.(result);
    await flush();
    expect(responses.filter((response) => response.type === "result").map((response) => response.requestId)).toEqual(["b"]);
  });

  it("acknowledges an explicit cancel for the active request", async () => {
    const { responses, post } = collector();
    const handle = createNmrWorkerHandler(post);
    handle({ type: "predict", requestId: "p1", sourceFingerprint: FP, request: baseRequest() });
    handle({ type: "cancel", requestId: "p1" });
    await flush();
    expect(responses.some((response) => response.type === "cancelled" && response.requestId === "p1")).toBe(true);
  });
});

function baseRequest() {
  return { structure: { format: "smiles" as const, value: "c1ccccc1" }, nuclei: ["13C" as const], options: OPTIONS };
}
