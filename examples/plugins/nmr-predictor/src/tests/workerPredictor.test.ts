import { describe, expect, it, vi } from "vitest";

import type { NmrPredictionResult } from "../domain/contracts";
import type { NmrWorkerClient } from "../worker/nmrWorkerClient";
import { createWorkerBackedPredictor } from "../application/workerPredictor";

const CAPABILITIES = {
  id: "chemdraft.fixture-hose",
  version: "1",
  execution: "worker-js" as const,
  nuclei: ["13C" as const],
  supportsAtomAssignments: true,
  supportsUncertainty: true,
  supportsCouplings: false,
  supportsSolvent: false,
  supportsConformers: false,
  supportsStereochemistry: false
};

const RESULT: NmrPredictionResult = {
  schemaVersion: "1",
  sourceFingerprint: "fp",
  backend: { id: "chemdraft.fixture-hose", version: "1", method: "fixture-fragment" },
  resonances: [],
  warnings: [],
  generatedAt: "t"
};

describe("createWorkerBackedPredictor", () => {
  it("initializes the worker once and caches capabilities", async () => {
    const client: NmrWorkerClient = {
      initialize: vi.fn(async () => CAPABILITIES),
      predict: vi.fn(async () => RESULT),
      dispose: vi.fn()
    };
    const predictor = createWorkerBackedPredictor(client, "chemdraft.fixture-hose");

    await predictor.getCapabilities();
    await predictor.getCapabilities();
    expect(client.initialize).toHaveBeenCalledTimes(1);
    expect(client.initialize).toHaveBeenCalledWith("chemdraft.fixture-hose");
  });

  it("forwards the request and its source fingerprint to the client", async () => {
    const predict = vi.fn(async () => RESULT);
    const client: NmrWorkerClient = { initialize: vi.fn(async () => CAPABILITIES), predict, dispose: vi.fn() };
    const predictor = createWorkerBackedPredictor(client);

    const request = {
      structure: { format: "smiles" as const, value: "c1ccccc1" },
      nuclei: ["13C" as const],
      options: { statistic: "median" as const, hoseLevels: [2], ignoreLabileHydrogens: true },
      sourceFingerprint: "sel-fp"
    };
    await predictor.predict(request);
    expect(predict).toHaveBeenCalledWith(request, "sel-fp", undefined);
  });
});
