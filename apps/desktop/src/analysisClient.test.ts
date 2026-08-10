import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AnalysisSchemaVersion, type AnalysisRun } from "@chemdraft/analysis-core";
import { sourceInterpretation } from "@chemdraft/rdkit-adapter";

import { createAnalysisClient } from "./analysisClient";
import type { AnalysisWorkRequest, AnalysisWorkResponse } from "./analysisWorker";

class FakeWorker {
  readonly posted: AnalysisWorkRequest[] = [];
  readonly listeners = new Map<string, ((event: MessageEvent<AnalysisWorkResponse>) => void)[]>();
  terminated = false;

  addEventListener(type: string, listener: (event: MessageEvent<AnalysisWorkResponse>) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  postMessage(message: AnalysisWorkRequest): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(message: AnalysisWorkResponse): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: message } as MessageEvent<AnalysisWorkResponse>);
    }
  }

  crash(): void {
    for (const listener of this.listeners.get("error") ?? []) {
      listener({} as MessageEvent<AnalysisWorkResponse>);
    }
  }
}

function okRun(runId: string, value: string): AnalysisRun {
  const interpretation = sourceInterpretation("smiles", value);
  return {
    schemaVersion: AnalysisSchemaVersion,
    runId,
    sourceHash: interpretation.sourceHash,
    interpretations: [interpretation],
    engines: [],
    startedAt: "2026-07-30T12:00:00.000Z",
    status: "ok",
    results: [],
    warnings: [],
    fingerprint: `fnv1a64:${runId.padStart(16, "0")}`
  };
}

function createClient() {
  const workers: FakeWorker[] = [];
  const client = createAnalysisClient(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  })!;
  return { client, workers, current: () => workers[workers.length - 1]! };
}

const ASPIRIN = { format: "smiles", value: "CC(=O)Oc1ccccc1C(=O)O" };
const CAFFEINE = { format: "smiles", value: "Cn1cnc2c1c(=O)n(C)c(=O)n2C" };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createAnalysisClient", () => {
  it("does not create a worker until the debounce actually fires", async () => {
    // The worker owns a 7.5 MB WASM module. Creating it on a request that a keystroke is about to
    // supersede would pay the load cost for an answer nobody wanted.
    const { client, workers } = createClient();
    void client.analyze("selection", ASPIRIN);
    expect(workers).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(200);
    expect(workers).toHaveLength(1);
  });

  it("sends one request carrying the size limit and resolves with the run", async () => {
    const { client, current } = createClient();
    const pending = client.analyze("selection", ASPIRIN);
    await vi.advanceTimersByTimeAsync(200);

    const posted = current().posted[0]!;
    expect(posted.kind).toBe("analyze");
    expect(posted.request).toMatchObject({
      format: "smiles",
      value: ASPIRIN.value,
      maxHeavyAtoms: 500
    });

    current().reply({ id: posted.id, kind: "run", run: okRun("r1", ASPIRIN.value) });
    expect((await pending).runId).toBe("r1");
  });

  it("passes the interpretation policy through to the worker", async () => {
    const { client, current } = createClient();
    void client.analyze(
      "selection",
      { ...ASPIRIN, methodIds: ["rdkit.tpsa"], fallbackInterpretations: [], interpretationOverride: "neutralized" },
      { immediate: true }
    );

    expect(current().posted[0]!.request).toMatchObject({
      methodIds: ["rdkit.tpsa"],
      fallbackInterpretations: [],
      interpretationOverride: "neutralized"
    });
  });

  it("tells the worker to drop a superseded reply", async () => {
    // Without this the worker finishes a job whose answer nobody will read, and — worse — posts it
    // back, where a stale id could match a later request.
    const { client, current } = createClient();
    const first = client.analyze("selection", ASPIRIN);
    await vi.advanceTimersByTimeAsync(200);
    const firstId = current().posted[0]!.id;

    void client.analyze("selection", CAFFEINE);
    expect(current().posted.some((message) => message.kind === "cancel" && message.id === firstId)).toBe(true);
    expect((await first).status).toBe("cancelled");
  });

  it("reuses one worker across requests", async () => {
    const { client, workers, current } = createClient();
    const first = client.analyze("selection", ASPIRIN, { immediate: true });
    current().reply({ id: current().posted[0]!.id, kind: "run", run: okRun("r1", ASPIRIN.value) });
    await first;

    const second = client.analyze("selection", CAFFEINE, { immediate: true });
    current().reply({ id: current().posted[1]!.id, kind: "run", run: okRun("r2", CAFFEINE.value) });
    await second;

    expect(workers).toHaveLength(1);
  });

  it("serves a repeat question from the session cache without touching the worker", async () => {
    const { client, current } = createClient();
    const first = client.analyze("selection", ASPIRIN, { immediate: true });
    current().reply({ id: current().posted[0]!.id, kind: "run", run: okRun("r1", ASPIRIN.value) });
    await first;

    const second = await client.analyze("selection", ASPIRIN);
    expect(second.runId).toBe("r1");
    expect(current().posted.filter((message) => message.kind === "analyze")).toHaveLength(1);
    expect(client.cache.stats().hits).toBe(1);
  });

  it("turns a worker error reply into a failed run", async () => {
    const { client, current } = createClient();
    const pending = client.analyze("selection", ASPIRIN, { immediate: true });
    current().reply({ id: current().posted[0]!.id, kind: "error", message: "RDKit module loader not set" });

    const run = await pending;
    expect(run.status).toBe("failed");
    expect(run.warnings[0]?.message).toBe("RDKit module loader not set");
  });

  it("fails the in-flight request when the worker dies, and rebuilds it for the next one", async () => {
    const { client, workers, current } = createClient();
    const pending = client.analyze("selection", ASPIRIN, { immediate: true });
    current().crash();

    const run = await pending;
    expect(run.status).toBe("failed");
    expect(run.warnings[0]?.message).toMatch(/stopped unexpectedly/);

    void client.analyze("selection", CAFFEINE, { immediate: true });
    expect(workers).toHaveLength(2);
  });

  it("gives up after repeated crashes rather than looping", async () => {
    const { client, workers, current } = createClient();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const pending = client.analyze("selection", { format: "smiles", value: `C${"C".repeat(attempt)}` }, { immediate: true });
      current().crash();
      expect((await pending).status).toBe("failed");
    }
    expect(workers.length).toBeLessThanOrEqual(5);

    const run = await client.analyze("selection", { format: "smiles", value: "CCCCCCCC" }, { immediate: true });
    expect(run.status).toBe("failed");
    expect(run.warnings[0]?.message).toMatch(/unavailable/);
  });

  it("warms up once", () => {
    const { client, current } = createClient();
    client.warmup();
    client.warmup();
    expect(current().posted.filter((message) => message.kind === "warmup")).toHaveLength(1);
  });

  it("terminates the worker and cancels outstanding work on dispose", async () => {
    const { client, current } = createClient();
    const pending = client.analyze("selection", ASPIRIN, { immediate: true });
    client.dispose();

    expect(current().terminated).toBe(true);
    expect((await pending).status).toBe("cancelled");
  });

  it("returns null where Worker is unavailable rather than throwing at import time", () => {
    // jsdom tests and exotic webviews; callers fall back to the in-page path.
    const original = globalThis.Worker;
    // @ts-expect-error — deleting a global for the duration of one assertion.
    delete globalThis.Worker;
    try {
      expect(createAnalysisClient()).toBeNull();
    } finally {
      globalThis.Worker = original;
    }
  });
});

describe("a dead worker is cleaned up, not just dropped", () => {
  it("terminates the crashed worker and re-warms its replacement", async () => {
    // An `error` event reports an uncaught error INSIDE a worker; it does not kill it. Nulling the
    // reference therefore orphaned a live worker with its RDKit and IsoSpec WASM heaps resident, once
    // per event, up to four before `ensureWorker` gives up — and `dispose()` only ever terminated the
    // current one, so the orphans outlived that too. `conformerClient` gets this right and asserts it.
    const { client, workers, current } = createClient();
    const first = client.analyze("selection", ASPIRIN, { immediate: true });
    const crashed = current();
    crashed.crash();
    await expect(first).resolves.toMatchObject({ status: "failed" });
    expect(crashed.terminated, "the crashed worker was abandoned, not terminated").toBe(true);

    // `warmed` must reset with it: a replacement worker has loaded neither engine, and a `warmup()`
    // that short-circuits forever after the first crash leaves it to meet the next request cold —
    // exactly the cost warmup exists to avoid.
    client.warmup();
    const replacement = current();
    expect(replacement).not.toBe(crashed);
    expect(workers.length).toBe(2);
    expect(replacement.posted.some((message) => message.kind === "warmup")).toBe(true);
  });
});
