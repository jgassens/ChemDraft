// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Generate3DConformerResult } from "@chemdraft/chemistry-adapter";
import { createConformerWorkerClient } from "./conformerClient";
import { DOM_SPIN3D_TRACE_EVENT, createSpin3dTraceEvent, type Spin3dTraceEvent } from "./conformerDebug";
import type { ConformerWorkRequest, ConformerWorkResponse } from "./conformerWorker";

class FakeWorker {
  readonly posted: ConformerWorkRequest[] = [];
  readonly listeners = new Map<string, Array<(event: MessageEvent<ConformerWorkResponse>) => void>>();
  terminated = false;

  addEventListener(type: string, listener: (event: MessageEvent<ConformerWorkResponse>) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  postMessage(message: ConformerWorkRequest) {
    this.posted.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  emit(message: ConformerWorkResponse) {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: message } as MessageEvent<ConformerWorkResponse>);
    }
  }

  crash() {
    for (const listener of this.listeners.get("error") ?? []) {
      listener({} as MessageEvent<ConformerWorkResponse>);
    }
  }
}

afterEach(() => {
  window.dispatchEvent(new CustomEvent(DOM_SPIN3D_TRACE_EVENT, { detail: undefined }));
});

describe("conformer worker client tracing", () => {
  it("sends trace context to generate, prefetch, and warmup requests", () => {
    const fake = new FakeWorker();
    const client = createConformerWorkerClient(() => fake as unknown as Worker);

    client?.generate("mol", 2, noopHandlers(), { sessionId: "spin:generate" });
    client?.prefetch("prefetch-mol", 3, { sessionId: "spin:prefetch" });
    client?.warmup({ sessionId: "spin:warmup" });

    expect(fake.posted).toEqual([
      expect.objectContaining({ kind: "generate", sessionId: "spin:generate", originalAtomCount: 2 }),
      expect.objectContaining({ kind: "prefetch", sessionId: "spin:prefetch", originalAtomCount: 3 }),
      expect.objectContaining({ kind: "warmup", sessionId: "spin:warmup" })
    ]);
  });

  it("broadcasts worker trace messages before handler lookup", () => {
    const fake = new FakeWorker();
    const traces: Spin3dTraceEvent[] = [];
    window.addEventListener(DOM_SPIN3D_TRACE_EVENT, (event) => {
      const trace = (event as CustomEvent<Spin3dTraceEvent>).detail;
      if (trace?.stage === "worker.prefetch") traces.push(trace);
    });
    const client = createConformerWorkerClient(() => fake as unknown as Worker);

    client?.prefetch("mol", 2, { sessionId: "spin:prefetch" });
    fake.emit({
      id: 1,
      stage: "trace",
      trace: createSpin3dTraceEvent({
        sessionId: "spin:prefetch",
        requestId: 1,
        kind: "worker",
        stage: "worker.prefetch",
        status: "completed",
        atomCount: 2,
        cacheStatus: "stored",
        path: "worker"
      })
    });

    expect(traces).toEqual([
      expect.objectContaining({
        sessionId: "spin:prefetch",
        stage: "worker.prefetch",
        cacheStatus: "stored"
      })
    ]);
  });

  it("routes embedded/refined results and emits a crash trace for fallback", () => {
    const fake = new FakeWorker();
    const embedded = vi.fn();
    const refined = vi.fn();
    const error = vi.fn();
    const traces: Spin3dTraceEvent[] = [];
    window.addEventListener(DOM_SPIN3D_TRACE_EVENT, (event) => {
      const trace = (event as CustomEvent<Spin3dTraceEvent>).detail;
      if (trace?.stage === "worker.crash") traces.push(trace);
    });
    const client = createConformerWorkerClient(() => fake as unknown as Worker);

    client?.generate("mol", 2, {
      onEmbedded: embedded,
      onRefined: refined,
      onError: error
    }, { sessionId: "spin:generate" });
    fake.emit({ id: 1, stage: "embedded", result: conformerResult("not-run") });
    fake.emit({ id: 1, stage: "refined", result: conformerResult("converged") });

    expect(embedded).toHaveBeenCalledWith(expect.objectContaining({ forceField: { name: "MMFF94", status: "not-run" } }));
    expect(refined).toHaveBeenCalledWith(expect.objectContaining({ forceField: { name: "MMFF94", status: "converged" } }));

    client?.generate("mol2", 2, noopHandlers(error), { sessionId: "spin:crash" });
    fake.crash();

    expect(error).toHaveBeenCalledWith("conformer worker crashed", { workerCrashed: true });
    expect(traces).toEqual([
      expect.objectContaining({
        sessionId: "spin:crash",
        stage: "worker.crash",
        status: "failed"
      })
    ]);
  });

  it("recreates the worker after a crash and keeps dispatching", () => {
    const workers: FakeWorker[] = [];
    const client = createConformerWorkerClient(() => {
      const next = new FakeWorker();
      workers.push(next);
      return next as unknown as Worker;
    });

    client?.generate("mol", 2, noopHandlers(), { sessionId: "spin:1" });
    expect(workers).toHaveLength(1);
    workers[0].crash();
    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(2); // recreated eagerly

    client?.generate("mol2", 2, noopHandlers(), { sessionId: "spin:2" });
    expect(workers[1].posted).toContainEqual(
      expect.objectContaining({ kind: "generate", sessionId: "spin:2" })
    );
  });

  it("posts a cancel message when the returned canceller runs", () => {
    const fake = new FakeWorker();
    const client = createConformerWorkerClient(() => fake as unknown as Worker);
    const cancel = client!.generate("mol", 2, noopHandlers(), { sessionId: "spin:cancel" });
    cancel();
    expect(fake.posted).toContainEqual(expect.objectContaining({ kind: "cancel" }));
  });

  it("clears a pending request on a terminal complete stage", () => {
    const fake = new FakeWorker();
    const client = createConformerWorkerClient(() => fake as unknown as Worker);
    const refined = vi.fn();
    client?.generate("mol", 2, noopHandlers(vi.fn()), { sessionId: "spin:complete" });
    // complete is terminal bookkeeping — no handler fires, but a later stray
    // refined for the same id must not reach a (now-forgotten) handler.
    fake.emit({ id: 1, stage: "complete" });
    fake.emit({ id: 1, stage: "refined", result: conformerResult("converged"), });
    expect(refined).not.toHaveBeenCalled();
  });
});

function noopHandlers(onError = vi.fn()) {
  return {
    onEmbedded: vi.fn(),
    onRefined: vi.fn(),
    onError
  };
}

function conformerResult(status: NonNullable<Generate3DConformerResult["forceField"]>["status"]): Generate3DConformerResult {
  return {
    mapping: {
      coords3dByOriginalAtom: new Float64Array([0, 0, 0, 1, 0, 0]),
      originalToEngineAtom: [0, 1],
      engineToOriginalAtom: [0, 1],
      generatedHydrogenEngineAtoms: []
    },
    originalAtomCount: 2,
    generatedAtomCount: 2,
    hydrogens: { added: false, explicitInputHydrogensPreserved: false },
    engine: { name: "openchemlib", version: "test", parameters: {} },
    embed: { status: "ok" },
    forceField: { name: "MMFF94", status },
    unsupportedFeatures: [],
    warnings: []
  };
}
