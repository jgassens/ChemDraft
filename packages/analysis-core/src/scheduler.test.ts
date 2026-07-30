import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hashInterpretation, type MolecularInterpretation } from "./interpretation";
import { AnalysisRunSchema, AnalysisSchemaVersion, type AnalysisRun } from "./results";
import { AnalysisScheduler, type AnalysisSchedulerOptions, type AnalysisSignal } from "./scheduler";
import { AnalysisSessionCache, type AnalysisRequestSpec } from "./session";

function interpretationFor(spec: AnalysisRequestSpec): MolecularInterpretation {
  const policy = {
    id: "source",
    sourceHash: `fnv1a64:${spec.value.length.toString(16).padStart(16, "0")}`,
    componentPolicy: "whole-input" as const,
    explicitHydrogenPolicy: "as-drawn",
    isotopePolicy: "preserve-labels",
    aromaticityModel: "rdkit-default",
    transformations: []
  };
  return { ...policy, label: "as drawn", interpretationHash: hashInterpretation(policy) };
}

function okRun(runId: string, spec: AnalysisRequestSpec): AnalysisRun {
  const interpretation = interpretationFor(spec);
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

/** A transport whose completion each test drives by hand. */
function createFakeEngine() {
  const calls: { spec: AnalysisRequestSpec; signal: AnalysisSignal; settle: (run: AnalysisRun) => void; fail: (error: Error) => void }[] = [];
  return {
    calls,
    run(spec: AnalysisRequestSpec, signal: AnalysisSignal): Promise<AnalysisRun> {
      return new Promise<AnalysisRun>((resolve, reject) => {
        calls.push({ spec, signal, settle: resolve, fail: reject });
      });
    }
  };
}

function createScheduler(overrides: Partial<AnalysisSchedulerOptions> = {}) {
  const engine = createFakeEngine();
  const scheduler = new AnalysisScheduler({
    run: engine.run,
    interpretationFor,
    now: () => "2026-07-30T12:00:00.000Z",
    ...overrides
  });
  return { engine, scheduler };
}

const ASPIRIN: AnalysisRequestSpec = { format: "smiles", value: "CC(=O)Oc1ccccc1C(=O)O" };
const CAFFEINE: AnalysisRequestSpec = { format: "smiles", value: "Cn1cnc2c1c(=O)n(C)c(=O)n2C" };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("debouncing", () => {
  it("does not touch the engine until the window closes", async () => {
    const { engine, scheduler } = createScheduler();
    void scheduler.request("selection", ASPIRIN);

    expect(engine.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(119);
    expect(engine.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(engine.calls).toHaveLength(1);
  });

  it("runs one analysis for a burst of keystrokes, on the last input", async () => {
    // Typing into a formula field produces a request per keystroke; only the last describes a
    // structure the user still has.
    const { engine, scheduler } = createScheduler();
    const first = scheduler.request("selection", { format: "smiles", value: "C" });
    const second = scheduler.request("selection", { format: "smiles", value: "CC" });
    const third = scheduler.request("selection", { format: "smiles", value: "CCO" });

    await vi.advanceTimersByTimeAsync(200);
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]!.spec.value).toBe("CCO");

    engine.calls[0]!.settle(okRun("r1", { format: "smiles", value: "CCO" }));
    expect((await first).status).toBe("cancelled");
    expect((await second).status).toBe("cancelled");
    expect((await third).status).toBe("ok");
  });

  it("skips the wait for an explicit request", async () => {
    const { engine, scheduler } = createScheduler();
    void scheduler.request("selection", ASPIRIN, { immediate: true });
    expect(engine.calls).toHaveLength(1);
  });
});

describe("supersession", () => {
  it("cancels an in-flight analysis when the structure is edited", async () => {
    const { engine, scheduler } = createScheduler();
    const first = scheduler.request("selection", ASPIRIN);
    await vi.advanceTimersByTimeAsync(200);
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]!.signal.cancelled).toBe(false);

    const second = scheduler.request("selection", CAFFEINE);
    // The engine is told immediately, so a long-running job can stop rather than finish into a void.
    expect(engine.calls[0]!.signal.cancelled).toBe(true);

    const firstRun = await first;
    expect(firstRun.status).toBe("cancelled");
    expect(firstRun.warnings[0]?.code).toBe("analysis.superseded");
    expect(AnalysisRunSchema.safeParse(firstRun).success).toBe(true);

    await vi.advanceTimersByTimeAsync(200);
    engine.calls[1]!.settle(okRun("r2", CAFFEINE));
    expect((await second).status).toBe("ok");
  });

  it("ignores a superseded analysis that completes late", async () => {
    // The race that produces a stale panel: the old job finishes after the new one started. Its result
    // must neither resolve the caller nor enter the cache.
    const { engine, scheduler } = createScheduler();
    const first = scheduler.request("selection", ASPIRIN);
    await vi.advanceTimersByTimeAsync(200);

    const second = scheduler.request("selection", CAFFEINE);
    engine.calls[0]!.settle(okRun("stale", ASPIRIN));
    expect((await first).status).toBe("cancelled");

    await vi.advanceTimersByTimeAsync(200);
    engine.calls[1]!.settle(okRun("fresh", CAFFEINE));
    expect((await second).runId).toBe("fresh");

    // Re-asking the superseded question must actually run it, not serve the abandoned result.
    void scheduler.request("selection", ASPIRIN);
    await vi.advanceTimersByTimeAsync(200);
    expect(engine.calls).toHaveLength(3);
  });

  it("keeps separate slots independent", async () => {
    const { engine, scheduler } = createScheduler();
    const selection = scheduler.request("selection", ASPIRIN);
    const hover = scheduler.request("hover", CAFFEINE);
    await vi.advanceTimersByTimeAsync(200);

    expect(engine.calls).toHaveLength(2);
    engine.calls[0]!.settle(okRun("a", ASPIRIN));
    engine.calls[1]!.settle(okRun("b", CAFFEINE));
    expect((await selection).status).toBe("ok");
    expect((await hover).status).toBe("ok");
  });

  it("cancels on request and reports which slots are live", async () => {
    const { engine, scheduler } = createScheduler();
    const pending = scheduler.request("selection", ASPIRIN);
    expect(scheduler.activeSlots()).toEqual(["selection"]);

    scheduler.cancel("selection");
    const run = await pending;
    expect(run.status).toBe("cancelled");
    expect(run.warnings[0]?.message).toMatch(/cancelled/);
    expect(scheduler.activeSlots()).toEqual([]);

    await vi.advanceTimersByTimeAsync(200);
    expect(engine.calls).toHaveLength(0);
  });

  it("cancels everything at once", async () => {
    const { scheduler } = createScheduler();
    const a = scheduler.request("selection", ASPIRIN);
    const b = scheduler.request("hover", CAFFEINE);
    scheduler.cancelAll();
    expect((await a).status).toBe("cancelled");
    expect((await b).status).toBe("cancelled");
  });
});

describe("session cache", () => {
  it("answers a repeat question without the engine or the debounce", async () => {
    const { engine, scheduler } = createScheduler();
    const first = scheduler.request("selection", ASPIRIN);
    await vi.advanceTimersByTimeAsync(200);
    engine.calls[0]!.settle(okRun("r1", ASPIRIN));
    await first;

    // No timer advance: a cache hit that waited for the debounce would defeat the point of caching.
    const second = await scheduler.request("selection", ASPIRIN);
    expect(second.runId).toBe("r1");
    expect(engine.calls).toHaveLength(1);
    expect(scheduler.cache.stats().hits).toBe(1);
  });

  it("treats a different fallback policy as a different question", async () => {
    const { engine, scheduler } = createScheduler();
    const first = scheduler.request("selection", ASPIRIN);
    await vi.advanceTimersByTimeAsync(200);
    engine.calls[0]!.settle(okRun("r1", ASPIRIN));
    await first;

    void scheduler.request("selection", { ...ASPIRIN, fallbackInterpretations: [] });
    await vi.advanceTimersByTimeAsync(200);
    expect(engine.calls).toHaveLength(2);
  });

  it("does not cache a superseded or failed run", async () => {
    const { engine, scheduler } = createScheduler();
    const first = scheduler.request("selection", ASPIRIN);
    await vi.advanceTimersByTimeAsync(200);
    scheduler.cancel("selection");
    await first;

    expect(scheduler.cache.stats().size).toBe(0);

    const second = scheduler.request("selection", ASPIRIN);
    await vi.advanceTimersByTimeAsync(200);
    engine.calls[1]!.fail(new Error("engine exploded"));
    expect((await second).status).toBe("failed");
    expect(scheduler.cache.stats().size).toBe(0);
  });

  it("shares an injected cache across schedulers", async () => {
    const cache = new AnalysisSessionCache();
    const { engine, scheduler } = createScheduler({ cache });
    const first = scheduler.request("selection", ASPIRIN);
    await vi.advanceTimersByTimeAsync(200);
    engine.calls[0]!.settle(okRun("r1", ASPIRIN));
    await first;

    const other = createScheduler({ cache });
    expect((await other.scheduler.request("selection", ASPIRIN)).runId).toBe("r1");
    expect(other.engine.calls).toHaveLength(0);
  });
});

describe("failures and limits", () => {
  it("turns an engine rejection into a failed run rather than a rejected promise", async () => {
    // One channel for one question: a caller rendering `run.results` never has to also catch.
    const { engine, scheduler } = createScheduler();
    const pending = scheduler.request("selection", ASPIRIN);
    await vi.advanceTimersByTimeAsync(200);
    engine.calls[0]!.fail(new Error("WASM heap exhausted"));

    const run = await pending;
    expect(run.status).toBe("failed");
    expect(run.warnings[0]?.code).toBe("analysis.engine_error");
    expect(run.warnings[0]?.message).toBe("WASM heap exhausted");
    expect(AnalysisRunSchema.safeParse(run).success).toBe(true);
  });

  it("refuses an oversized input before anything parses it", async () => {
    const { engine, scheduler } = createScheduler({ maxInputLength: 32 });
    const run = await scheduler.request("selection", { format: "smiles", value: "C".repeat(33) });

    expect(run.status).toBe("unsupported");
    expect(run.warnings[0]?.code).toBe("structure.input_too_large");
    expect(engine.calls).toHaveLength(0);
    // No timer advance needed: the refusal is synchronous, which is the point of a pre-parse guard.
  });

  it("lets an input at the limit through", async () => {
    const { engine, scheduler } = createScheduler({ maxInputLength: 32 });
    void scheduler.request("selection", { format: "smiles", value: "C".repeat(32) });
    await vi.advanceTimersByTimeAsync(200);
    expect(engine.calls).toHaveLength(1);
  });
});
