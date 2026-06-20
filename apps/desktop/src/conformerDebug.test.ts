// @vitest-environment jsdom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { Spin3dDebuggerWindow } from "./Spin3dDebuggerWindow";
import {
  appendSpin3dTraceEvent,
  computedSpin3dTraceStatus,
  createSpin3dTraceEvent,
  mergeSpin3dTraceRows,
  startSpin3dTraceSpan
} from "./conformerDebug";

afterEach(() => {
  window.history.replaceState({}, "", "/");
});

describe("3D conformer trace helpers", () => {
  it("creates stable serializable trace events and merges span completions", () => {
    const started = createSpin3dTraceEvent({
      sessionId: "spin:1",
      requestId: 7,
      kind: "worker",
      stage: "worker.generate",
      status: "started",
      startedAt: 100,
      atomCount: 4,
      queueDepth: 1,
      path: "worker"
    }, 100);
    const completed = createSpin3dTraceEvent({
      sessionId: "spin:1",
      requestId: 7,
      kind: "worker",
      stage: "worker.generate",
      status: "completed",
      spanId: started.spanId,
      startedAt: 100,
      endedAt: 145,
      atomCount: 4,
      cacheStatus: "miss",
      path: "worker"
    }, 145);

    expect(JSON.parse(JSON.stringify(started))).toMatchObject({
      sessionId: "spin:1",
      requestId: "7",
      stage: "worker.generate",
      status: "started",
      atomCount: 4
    });
    expect(mergeSpin3dTraceRows([started, completed])).toEqual([
      expect.objectContaining({
        spanId: started.spanId,
        status: "completed",
        durationMs: 45,
        cacheStatus: "miss"
      })
    ]);
  });

  it("marks long-running spans as stale and likely hung", () => {
    const started = createSpin3dTraceEvent({
      sessionId: "spin:2",
      kind: "ocl",
      stage: "ocl.embed-conformer",
      status: "started",
      startedAt: 1000
    }, 1000);
    const row = mergeSpin3dTraceRows([started])[0];

    expect(computedSpin3dTraceStatus(row, 1500)).toBe("running");
    expect(computedSpin3dTraceStatus(row, 2600)).toBe("still-running");
    expect(computedSpin3dTraceStatus(row, 7000)).toBe("likely-hung");
  });

  it("builds trace spans with paired started and completed events", () => {
    const events: ReturnType<typeof createSpin3dTraceEvent>[] = [];
    const span = startSpin3dTraceSpan({
      sessionId: "spin:3",
      requestId: 8,
      kind: "spin",
      stage: "spin.molfile"
    }, (event) => events.push(event), makeClock([10, 28]));

    span.complete({ atomCount: 6 });

    expect(events).toEqual([
      expect.objectContaining({ status: "started", startedAt: 10 }),
      expect.objectContaining({ status: "completed", startedAt: 10, endedAt: 28, durationMs: 18, atomCount: 6 })
    ]);
  });

  it("keeps a bounded trace event log", () => {
    const events = Array.from({ length: 4 }, (_, index) => createSpin3dTraceEvent({
      sessionId: "spin:bounded",
      kind: "spin",
      stage: `stage.${index}`,
      status: "info",
      startedAt: index
    }, index));

    expect(events.reduce((log, event) => appendSpin3dTraceEvent(log, event, 2), [] as typeof events)).toEqual([
      expect.objectContaining({ stage: "stage.2" }),
      expect.objectContaining({ stage: "stage.3" })
    ]);
  });
});

describe("3D debugger window", () => {
  it("renders the debugger empty state", () => {
    const markup = renderToStaticMarkup(createElement(Spin3dDebuggerWindow));

    expect(markup).toContain("3D Debugger");
    expect(markup).toContain("No 3D trace events yet");
  });

  it("renders active, failed, and completed trace rows", () => {
    const now = Date.now();
    const active = createSpin3dTraceEvent({
      sessionId: "spin:active",
      kind: "ocl",
      stage: "ocl.mmff94-refine",
      status: "started",
      startedAt: now - 6000,
      atomCount: 12,
      path: "in-page"
    });
    const failed = createSpin3dTraceEvent({
      sessionId: "spin:failed",
      kind: "worker-client",
      stage: "worker.crash",
      status: "failed",
      startedAt: now - 20,
      endedAt: now - 10,
      error: "conformer worker crashed",
      path: "worker"
    });
    const done = createSpin3dTraceEvent({
      sessionId: "spin:done",
      kind: "worker",
      stage: "worker.cache",
      status: "info",
      startedAt: now - 5,
      cacheStatus: "hit",
      queueDepth: 0,
      path: "worker"
    });
    const markup = renderToStaticMarkup(createElement(Spin3dDebuggerWindow, {
      initialEvents: [active, failed, done]
    }));

    expect(markup).toContain("Likely hung");
    expect(markup).toContain("ocl.mmff94-refine");
    expect(markup).toContain("conformer worker crashed");
    expect(markup).toContain("cache hit");
  });

  it("routes the debugger route without rendering the document canvas", () => {
    window.history.replaceState({}, "", "/?window=spin3d-debugger");

    const markup = renderToStaticMarkup(createElement(App));

    expect(markup).toContain("3D Debugger");
    expect(markup).not.toContain("canvas-region");
    expect(markup).not.toContain("tool-palette");
  });
});

function makeClock(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}
