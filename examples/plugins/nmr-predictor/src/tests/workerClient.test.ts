import { describe, expect, it } from "vitest";

import type { NmrPredictionResult } from "../domain/contracts";
import { isNmrError, NmrErrorCodes } from "../domain/errors";
import { createNmrWorkerClient } from "../worker/nmrWorkerClient";
import type { NmrWorkerRequest, NmrWorkerResponse } from "../worker/protocol";

/** A hand-driven worker double: records outbound requests and lets the test emit responses. */
class FakeWorker {
  sent: NmrWorkerRequest[] = [];
  terminated = false;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  postMessage(request: NmrWorkerRequest): void {
    this.sent.push(request);
  }
  addEventListener(type: string, callback: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(callback);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, callback: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(callback);
  }
  terminate(): void {
    this.terminated = true;
  }
  emit(response: NmrWorkerResponse): void {
    for (const callback of this.listeners.get("message") ?? []) {
      callback({ data: response });
    }
  }
  crash(): void {
    for (const callback of this.listeners.get("error") ?? []) {
      callback(new Event("error"));
    }
  }
  lastId(): string {
    return this.sent[this.sent.length - 1]!.requestId;
  }
}

function makeClient(fake: FakeWorker) {
  const client = createNmrWorkerClient(() => fake as unknown as Worker);
  if (!client) {
    throw new Error("expected a client when a worker factory is provided");
  }
  return client;
}

const SAMPLE_RESULT: NmrPredictionResult = {
  schemaVersion: "1",
  sourceFingerprint: "fp",
  backend: { id: "chemdraft.fixture-hose", version: "1", method: "fixture-fragment" },
  resonances: [],
  warnings: [],
  generatedAt: "t"
};

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

function predictRequest() {
  return {
    structure: { format: "smiles" as const, value: "c1ccccc1" },
    nuclei: ["13C" as const],
    options: { statistic: "median" as const, hoseLevels: [2], ignoreLabileHydrogens: true }
  };
}

describe("createNmrWorkerClient", () => {
  it("initializes and resolves capabilities from the worker's ready message", async () => {
    const fake = new FakeWorker();
    const client = makeClient(fake);
    const promise = client.initialize("chemdraft.fixture-hose");
    fake.emit({ type: "ready", requestId: fake.lastId(), capabilities: CAPABILITIES });
    await expect(promise).resolves.toMatchObject({ id: "chemdraft.fixture-hose" });
  });

  it("resolves a predict on the worker's result and ignores unknown request ids", async () => {
    const fake = new FakeWorker();
    const client = makeClient(fake);
    const promise = client.predict(predictRequest(), "fp");
    fake.emit({ type: "result", requestId: "bogus", result: SAMPLE_RESULT }); // ignored, no throw
    fake.emit({ type: "result", requestId: fake.lastId(), result: SAMPLE_RESULT });
    await expect(promise).resolves.toBe(SAMPLE_RESULT);
  });

  it("rejects a predict on a worker error, mapping the code", async () => {
    const fake = new FakeWorker();
    const client = makeClient(fake);
    const promise = client.predict(predictRequest(), "fp");
    fake.emit({ type: "error", requestId: fake.lastId(), error: { code: "NMR_STRUCTURE_PARSE_FAILED", message: "bad" } });
    const error = await promise.catch((caught: unknown) => caught);
    expect(isNmrError(error) && error.code).toBe(NmrErrorCodes.StructureParseFailed);
  });

  it("cancels the in-flight request when the abort signal fires", async () => {
    const fake = new FakeWorker();
    const client = makeClient(fake);
    const controller = new AbortController();
    const promise = client.predict(predictRequest(), "fp", controller.signal);
    controller.abort();
    const error = await promise.catch((caught: unknown) => caught);
    expect(isNmrError(error) && error.code).toBe(NmrErrorCodes.PredictionCancelled);
    expect(fake.sent.some((request) => request.type === "cancel")).toBe(true);
  });

  it("drops a superseded predict's late result as cancellation", async () => {
    const fake = new FakeWorker();
    const client = makeClient(fake);
    const first = client.predict(predictRequest(), "fp");
    const firstId = fake.lastId();
    const second = client.predict(predictRequest(), "fp");
    const secondId = fake.lastId();

    fake.emit({ type: "result", requestId: firstId, result: SAMPLE_RESULT }); // superseded
    fake.emit({ type: "result", requestId: secondId, result: SAMPLE_RESULT });

    const firstError = await first.catch((caught: unknown) => caught);
    expect(isNmrError(firstError) && firstError.code).toBe(NmrErrorCodes.PredictionCancelled);
    await expect(second).resolves.toBe(SAMPLE_RESULT);
  });

  it("rejects outstanding work when disposed and terminates the worker", async () => {
    const fake = new FakeWorker();
    const client = makeClient(fake);
    const promise = client.predict(predictRequest(), "fp");
    client.dispose();
    await expect(promise).rejects.toThrow();
    expect(fake.terminated).toBe(true);
  });

  it("returns null when no Worker is available and no factory is provided", () => {
    expect(createNmrWorkerClient()).toBeNull(); // node test env: typeof Worker === "undefined"
  });
});
