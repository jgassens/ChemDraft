import { describe, expect, it } from "vitest";
import { stageTotal, summarizeStages, transportBreakdown, transportResidual } from "./report";

describe("WKWebView timing report", () => {
  it("sums repeated component/binding timings without adding nested stages to totals", () => {
    const stages = summarizeStages([
      { stage: "worker.protocol-total", ms: 18 },
      { stage: "rdkit.parse", ms: 2 }, { stage: "rdkit.parse", ms: 3 },
      { stage: "host.flatten3d.worker-roundtrip", ms: 1018 }
    ]);
    expect(stages.map(stage => stage.stage)).toEqual(["host.flatten3d.worker-roundtrip", "worker.protocol-total", "rdkit.parse"]);
    expect(stages[2]).toEqual({ stage: "rdkit.parse", calls: 2, totalMs: 5, minMs: 2, maxMs: 3 });
    expect(stageTotal(stages, "worker.protocol-total")).toBe(18);
    expect(transportResidual(stages, "flatten3d")).toBe(1000);
  });

  it("does not disguise missing data or timer precision as zero", () => {
    expect(summarizeStages([])).toEqual([]);
    expect(stageTotal([], "missing")).toBeNull();
    expect(transportResidual(summarizeStages([{ stage: "host.flatten3d.worker-roundtrip", ms: 10 }]), "flatten3d")).toBeNull();
    expect(transportResidual(summarizeStages([
      { stage: "host.flatten3d.worker-roundtrip", ms: 10 }, { stage: "worker.protocol-total", ms: 10.1 }
    ]), "flatten3d")).toBeCloseTo(-0.1);
  });

  it("keeps request delivery, result delivery and host dispatch separate", () => {
    expect(transportBreakdown(summarizeStages([
      { stage: "host.flatten3d.request-delivery", ms: 970 },
      { stage: "host.flatten3d.result-delivery", ms: 1 },
      { stage: "host.flatten3d.reply-dispatch", ms: 0 }
    ]), "flatten3d")).toEqual({ requestDeliveryMs: 970, resultDeliveryMs: 1, replyDispatchMs: 0 });
    expect(transportBreakdown([], "flatten3d"))
      .toEqual({ requestDeliveryMs: null, resultDeliveryMs: null, replyDispatchMs: null });
  });
});
