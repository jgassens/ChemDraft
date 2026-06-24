// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Generate3DConformerOptions, Generate3DConformerResult } from "@chemdraft/chemistry-adapter";
import { createConformerWorkerClient } from "./conformerClient";
import type { ConformerWorkRequest, ConformerWorkResponse } from "./conformerWorker";

class FakeWorker {
  readonly posted: ConformerWorkRequest[] = [];
  readonly listeners = new Map<string, Array<(event: MessageEvent<ConformerWorkResponse>) => void>>();
  addEventListener(type: string, listener: (event: MessageEvent<ConformerWorkResponse>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  postMessage(message: ConformerWorkRequest) { this.posted.push(message); }
  emit(message: ConformerWorkResponse) {
    for (const listener of this.listeners.get("message") ?? []) listener({ data: message } as MessageEvent<ConformerWorkResponse>);
  }
}

const OPTIONS: Generate3DConformerOptions = { optimize: "mmff94", maxMinimiseIterations: 90 };

it("dispatches tug relax requests and routes relaxed results", () => {
  const fake = new FakeWorker();
  const client = createConformerWorkerClient(() => fake as unknown as Worker)!;
  const onRelaxed = vi.fn();
  const onError = vi.fn();
  const cancel = client.relax("mol", 2, new Float64Array([0, 0, 0, 2, 0, 0]), OPTIONS, { onRelaxed, onError }, { sessionId: "relax:1" });
  expect(fake.posted[0]).toEqual(expect.objectContaining({ kind: "relax", molfile: "mol", originalAtomCount: 2, sessionId: "relax:1" }));
  fake.emit({ id: 1, stage: "relaxed", result: result() });
  expect(onRelaxed).toHaveBeenCalledWith(expect.objectContaining({ forceField: { name: "MMFF94", status: "converged" } }));
  cancel();
  expect(fake.posted).toContainEqual(expect.objectContaining({ kind: "cancel" }));
});

function result(): Generate3DConformerResult {
  return {
    mapping: { coords3dByOriginalAtom: new Float64Array([0, 0, 0, 1, 0, 0]), originalToEngineAtom: [0, 1], engineToOriginalAtom: [0, 1], generatedHydrogenEngineAtoms: [] },
    originalAtomCount: 2,
    generatedAtomCount: 0,
    hydrogens: { added: false, explicitInputHydrogensPreserved: false },
    engine: { name: "rdkit-wasm", version: "test", parameters: {} },
    embed: { status: "ok" },
    forceField: { name: "MMFF94", status: "converged" },
    unsupportedFeatures: [],
    warnings: []
  };
}
