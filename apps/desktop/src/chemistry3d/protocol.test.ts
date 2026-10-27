import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleChemistry3dRequest, type Chemistry3dJob, type Chemistry3dResult, type Chemistry3dWorkResponse } from "./protocol";
import { initializeChemistry3dWorker, embed3dInWorker, minimize3dInWorker, flatten3dInWorker } from "./engine";
import { chemistry3dMethod } from "./method";
import type { Chemistry3dTimingSink } from "./timing";

vi.mock("./engine", () => ({ initializeChemistry3dWorker: vi.fn(), embed3dInWorker: vi.fn(), minimize3dInWorker: vi.fn(), flatten3dInWorker: vi.fn() }));
vi.mock("./timing", () => ({ profileChemistry3d: async (run: (sink: Chemistry3dTimingSink) => Promise<unknown>, sink: Chemistry3dTimingSink) => {
  sink({ stage: "worker.job", ms: 1 });
  return run(sink);
} }));

const model = { atoms: [{ element: "C", charge: 0, component: 0, addedHydrogen: false }], bonds: [], coords: [0, 0, 0],
  components: [{ smiles: "C", atomStart: 0, atomCount: 1 }], modelToken: "test" };
const method = chemistry3dMethod(42);
const embedded = { model, method, warnings: [] };
const cases: { job: Chemistry3dJob; run: (...args: never[]) => Promise<Chemistry3dResult> }[] = [
  { job: { method: "embed3d", request: { components: [{ smiles: "C" }] } }, run: embed3dInWorker },
  { job: { method: "minimize3d", request: { model, interfragment: false }, provenance: method }, run: minimize3dInWorker },
  { job: { method: "flatten3d", request: { model, view: "auto" }, provenance: method }, run: flatten3dInWorker }
];
beforeEach(() => vi.resetAllMocks());

describe("conformer worker 3D reply protocol", () => {
  it("announces readiness only after loading and before computation, and tags startup failures", async () => {
    let ready!: () => void;
    vi.mocked(initializeChemistry3dWorker).mockImplementationOnce(() => new Promise(resolve => { ready = resolve; }));
    vi.mocked(embed3dInWorker).mockResolvedValue(embedded);
    const post = vi.fn();
    const running = handleChemistry3dRequest({ kind: "chemistry3d", id: 1, job: cases[0].job }, post);
    await vi.waitFor(() => expect(initializeChemistry3dWorker).toHaveBeenCalled());
    expect(post).not.toHaveBeenCalled();
    expect(embed3dInWorker).not.toHaveBeenCalled();
    ready();
    await running;
    expect(post.mock.calls[0][0]).toEqual({ kind: "chemistry3d-ready", id: 1 });
    vi.mocked(initializeChemistry3dWorker).mockRejectedValueOnce(new Error("WASM failed"));
    post.mockClear();
    await handleChemistry3dRequest({ kind: "chemistry3d", id: 2, job: cases[0].job }, post);
    expect(post).toHaveBeenCalledExactlyOnceWith({ kind: "chemistry3d-error", id: 2, message: "WASM failed" });
  });
  it.each(cases)("echoes the id on every $job.method reply and sends exactly one terminal result", async ({ job, run }) => {
    const result = job.method === "flatten3d" ? { objects: [], depthByAtom: [], method, warnings: [] } :
      job.method === "minimize3d" ? { ...embedded, clash: false,
        forceField: { name: "mmff94s" as const, status: "converged" as const, energy: 0, iterationsBudget: 1000 } } : embedded;
    vi.mocked(run).mockResolvedValue(result);
    if (job.method === "embed3d") vi.mocked(embed3dInWorker).mockImplementation(async (_request, progress, timing) => {
      progress?.();
      timing?.({ stage: "embed.component", ms: 1 });
      return embedded;
    });
    const replies: Chemistry3dWorkResponse[] = [];
    await handleChemistry3dRequest({ kind: "chemistry3d", id: 123, job, profile: true }, reply => replies.push(reply));
    expect(replies.every(reply => reply.id === 123)).toBe(true);
    expect(replies.filter(reply => reply.kind === "chemistry3d-timing").length).toBeGreaterThan(0);
    if (job.method === "embed3d") expect(replies).toContainEqual({ kind: "chemistry3d-progress", id: 123 });
    expect(replies.filter(reply => reply.kind === "chemistry3d-result" || reply.kind === "chemistry3d-error"))
      .toEqual([{ kind: "chemistry3d-result", id: 123, result, transportTrace: {
        workerReceivedAtEpochMs: expect.any(Number), workerPostedAtEpochMs: expect.any(Number)
      } }]);
  });
  it.each(cases)("echoes the id on $job.method failures without posting a result", async ({ job, run }) => {
    vi.mocked(run).mockRejectedValue(new Error("engine failed"));
    const post = vi.fn();
    await handleChemistry3dRequest({ kind: "chemistry3d", id: 456, job }, post);
    expect(post.mock.calls.map(([reply]) => reply)).toEqual([
      { id: 456, kind: "chemistry3d-ready" },
      { id: 456, kind: "chemistry3d-error", message: "engine failed" }
    ]);
  });
  it("does not emit timing messages when profiling is off", async () => {
    vi.mocked(embed3dInWorker).mockResolvedValue(embedded);
    const post = vi.fn();
    await handleChemistry3dRequest({ kind: "chemistry3d", id: 789, job: cases[0].job }, post);
    expect(post.mock.calls.map(([reply]) => reply)).toEqual([
      { id: 789, kind: "chemistry3d-ready" }, { id: 789, kind: "chemistry3d-result", result: embedded }
    ]);
    expect(embed3dInWorker).toHaveBeenCalledWith(cases[0].job.request, expect.any(Function), undefined);
  });
  it("stamps result posting on the shared clock and posts without waiting for a timer", async () => {
    vi.useFakeTimers();
    const now = vi.spyOn(performance, "now").mockReturnValue(10);
    try {
      vi.mocked(embed3dInWorker).mockImplementation(async () => {
        now.mockReturnValue(26);
        return embedded;
      });
      const post = vi.fn();
      await handleChemistry3dRequest({ kind: "chemistry3d", id: 900, job: cases[0].job, profile: true }, post);
      expect(post).toHaveBeenLastCalledWith({ kind: "chemistry3d-result", id: 900, result: embedded,
        transportTrace: { workerReceivedAtEpochMs: performance.timeOrigin + 10,
          workerPostedAtEpochMs: performance.timeOrigin + 26 } });
      expect(vi.getTimerCount()).toBe(0);
    } finally { now.mockRestore(); vi.useRealTimers(); }
  });
});
