import { afterEach, describe, expect, it, vi } from "vitest";
import { Worker } from "node:worker_threads";
import { createDepictionWorkerClient, type DepictionWorkerPort } from "./depictionWorkerClient";

type Layout = { layout: string; warnings?: string[] };
const standard: Layout = { layout: "standard" };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());
function port(): DepictionWorkerPort<Layout> {
  return { onmessage: null, onerror: null, postMessage: vi.fn(), terminate: vi.fn(), ref: vi.fn(), unref: vi.fn() };
}
function reply(worker: DepictionWorkerPort<Layout>, id = 1) {
  worker.onmessage?.({ data: { id, stage: "result", result: standard } });
}

describe("2D depiction worker deadline", () => {
  it("bounds cold engine loading separately and starts the 2 s layout budget at readiness", async () => {
    vi.useFakeTimers();
    const worker = { ...port(), initializing: true };
    const result = createDepictionWorkerClient(() => worker)("CCO");
    await vi.advanceTimersByTimeAsync(9_000);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(worker.postMessage).not.toHaveBeenCalled();
    worker.onmessage?.({ data: { id: 0, stage: "ready" } });
    expect(worker.postMessage).toHaveBeenCalledWith({ id: 1, smiles: "CCO" });
    worker.onmessage?.({ data: { id: 1, stage: "standard", result: standard } });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ ...standard, warnings: [expect.stringContaining("layout deadline")] });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("terminates startup that never becomes ready without attempting layout", async () => {
    vi.useFakeTimers();
    const worker = { ...port(), initializing: true };
    const rejection = expect(createDepictionWorkerClient(() => worker)("CCO")).rejects.toThrow("initialization exceeded its 10000 ms deadline");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("terminates a real worker blocked in synchronous computation and warns on fallback", async () => {
    const worker = new Worker(`const { parentPort } = require('node:worker_threads');
      parentPort.on('message', ({id}) => {
        parentPort.postMessage({id, stage: 'standard', result: {layout: 'standard'}});
        while (true) {}
      });`, { eval: true, execArgv: [] });
    await new Promise<void>((resolve) => worker.once("online", resolve));
    const transport = { ...port(), postMessage: (request: unknown) => worker.postMessage(request),
      terminate: vi.fn(() => { void worker.terminate(); }) };
    worker.on("message", (data) => transport.onmessage?.({ data }));
    try {
      await expect(createDepictionWorkerClient(() => transport, 200)("stuck CoordGen")).resolves.toMatchObject({
        ...standard, warnings: [expect.stringContaining("200 ms layout deadline")]
      });
      expect(transport.terminate).toHaveBeenCalledOnce();
    } finally { await worker.terminate(); }
  });

  it("retries a missing standard layout once in a fresh worker, after its own bootstrap", async () => {
    vi.useFakeTimers();
    const first = port(), second = { ...port(), initializing: true };
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const result = createDepictionWorkerClient<Layout>(factory)("CCO");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(first.terminate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(second.postMessage).not.toHaveBeenCalled();
    second.onmessage?.({ data: { id: 0, stage: "ready" } });
    expect(second.postMessage).toHaveBeenCalledWith({ id: 2, smiles: "CCO", standardOnly: true });
    reply(second, 2);
    await expect(result).resolves.toMatchObject({ ...standard, warnings: [expect.stringContaining("fresh worker")] });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("fails after one standard-only retry and recovers the queue", async () => {
    vi.useFakeTimers();
    const first = port(), second = port(), third = port();
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second).mockReturnValueOnce(third);
    const depict = createDepictionWorkerClient<Layout>(factory);
    const failed = expect(depict("stuck standard")).rejects.toThrow("layout deadline");
    const queued = depict("CCO");
    await vi.advanceTimersByTimeAsync(4_000);
    await failed;
    expect(first.terminate).toHaveBeenCalledOnce();
    expect(second.terminate).toHaveBeenCalledOnce();
    reply(third, 3);
    await expect(queued).resolves.toEqual(standard);
    expect(factory).toHaveBeenCalledTimes(3);
  });

  it("keeps engines warm for 60 s and unreferences the idle Node worker", async () => {
    vi.useFakeTimers();
    const worker = port(), factory = vi.fn(() => worker);
    const depict = createDepictionWorkerClient(factory);
    const cold = depict("C");
    await flush(); reply(worker); await cold;
    expect(worker.unref).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(worker.terminate).not.toHaveBeenCalled();
    const warm = depict("CC");
    await flush(); reply(worker, 2); await warm;
    expect(factory).toHaveBeenCalledOnce();
    expect(worker.ref).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("cancels queued and active requests independently, then runs interactive paste before list entries", async () => {
    const first = port(), second = port();
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const depict = createDepictionWorkerClient<Layout>(factory);
    const active = new AbortController(), queued = new AbortController();
    const running = expect(depict("long list item", { signal: active.signal })).rejects.toMatchObject({ name: "AbortError" });
    await flush();
    const skipped = expect(depict("cancel queued", { signal: queued.signal })).rejects.toMatchObject({ name: "AbortError" });
    const background = depict("next list item", { priority: "background" });
    const interactive = depict("paste", { priority: "interactive" });
    queued.abort(); active.abort();
    await running; await skipped; await flush();
    expect(first.terminate).toHaveBeenCalledOnce();
    expect(second.postMessage).toHaveBeenCalledWith({ id: 2, smiles: "paste" });
    reply(second, 2); await interactive; await flush();
    expect(second.postMessage).toHaveBeenLastCalledWith({ id: 3, smiles: "next list item" });
    reply(second, 3); await background;
  });

  it("does not load a worker for an already cancelled request", async () => {
    const factory = vi.fn(port), controller = new AbortController(); controller.abort();
    await expect(createDepictionWorkerClient(factory)("C", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(factory).not.toHaveBeenCalled();
  });

  it.each(["error", "messageerror"])("gives a specific worker %s failure and recovers", async (kind) => {
    const first = { ...port(), initializing: true }, second = port();
    const depict = createDepictionWorkerClient(vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second));
    const rejected = expect(depict("C")).rejects.toThrow(kind === "error" ? "2D depiction worker failed to load" : "unreadable message");
    await flush();
    if (kind === "error") first.onerror?.({ message: "" }); else first.onmessageerror?.();
    await rejected;
    expect(first.terminate).toHaveBeenCalledOnce();
    const recovered = depict("CC"); await flush(); reply(second, 2); await recovered;
  });

  it.each(["", "WASM trap"])("keeps an arrived standard depiction when a ready worker crashes (%s)", async (message) => {
    const worker = port();
    const result = createDepictionWorkerClient(() => worker)("CCO");
    await flush();
    worker.onmessage?.({ data: { id: 1, stage: "standard", result: standard } });
    worker.onerror?.({ message });
    await expect(result).resolves.toMatchObject({ ...standard,
      warnings: [expect.stringContaining("2D depiction worker stopped unexpectedly")] });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it.each([true, false])("distinguishes load failure from a mid-layout crash (initializing=%s)", async (initializing) => {
    const worker = { ...port(), initializing };
    const result = expect(createDepictionWorkerClient(() => worker)("CCO")).rejects.toThrow(initializing
      ? "The 2D depiction worker failed to load. WASM trap" : "The 2D depiction worker stopped unexpectedly. WASM trap");
    await flush(); worker.onerror?.({ message: "WASM trap" }); await result;
  });

  it("starts a fresh worker immediately after an idle worker exits", async () => {
    const first = port(), second = port();
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const depict = createDepictionWorkerClient<Layout>(factory);
    const initial = depict("C"); await flush(); reply(first); await initial;
    first.onerror?.({ message: "2D depiction worker exited (0)." });
    const next = depict("CC"); await flush();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(second.postMessage).toHaveBeenCalledWith({ id: 2, smiles: "CC" });
    reply(second, 2); await expect(next).resolves.toEqual(standard);
  });

  it("reports cancelled if cancellation arrives between a depiction deadline failure and retry", async () => {
    vi.useFakeTimers();
    const factory = vi.fn(port), controller = new AbortController();
    const result = expect(createDepictionWorkerClient(factory)("CCO", { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError", message: "2D depiction cancelled." });
    await flush();
    vi.advanceTimersByTime(2_000);
    controller.abort();
    await result;
    expect(factory).toHaveBeenCalledOnce();
  });

  it.each(["smilesChemistryRefusal", "notSmiles"] as const)("keeps the %s marker across the worker boundary", async (marker) => {
    const worker = port();
    const result = createDepictionWorkerClient(() => worker)("bad SMILES");
    const rejection = expect(result).rejects.toMatchObject({ message: "specific reason", [marker]: true });
    await flush();
    worker.onmessage?.({ data: { id: 1, stage: "error", message: "specific reason", [marker]: true } });
    await rejection;
  });
});
