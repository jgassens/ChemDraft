import type { Chemistry3dTiming } from "../chemistry3d/timing";

export interface StageSummary {
  stage: string;
  calls: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
}

/** Aggregate repeated calls within ONE method. Nested stages deliberately remain separate. */
export function summarizeStages(events: readonly Chemistry3dTiming[]): StageSummary[] {
  const stages = new Map<string, StageSummary>();
  for (const event of events) {
    const previous = stages.get(event.stage);
    if (previous) {
      previous.calls++;
      previous.totalMs += event.ms;
      previous.minMs = Math.min(previous.minMs, event.ms);
      previous.maxMs = Math.max(previous.maxMs, event.ms);
    } else {
      stages.set(event.stage, { stage: event.stage, calls: 1, totalMs: event.ms, minMs: event.ms, maxMs: event.ms });
    }
  }
  return [...stages.values()].sort((a, b) => b.totalMs - a.totalMs || a.stage.localeCompare(b.stage));
}

export function stageTotal(stages: readonly StageSummary[], name: string): number | null {
  return stages.find(stage => stage.stage === name)?.totalMs ?? null;
}

/** A residual is evidence of uninstrumented time, not an attribution to one transport step.
 * Keep signed values (clock resolution/rounding) and missing measurements visible. */
export function transportResidual(stages: readonly StageSummary[], method: string): number | null {
  const roundtrip = stageTotal(stages, `host.${method}.worker-roundtrip`);
  const worker = stageTotal(stages, "worker.protocol-total");
  return roundtrip === null || worker === null ? null : roundtrip - worker;
}

/** These stages use absolute performance.timeOrigin + performance.now on both threads. */
export function transportBreakdown(stages: readonly StageSummary[], method: string) {
  return {
    requestDeliveryMs: stageTotal(stages, `host.${method}.request-delivery`),
    resultDeliveryMs: stageTotal(stages, `host.${method}.result-delivery`),
    replyDispatchMs: stageTotal(stages, `host.${method}.reply-dispatch`)
  };
}
