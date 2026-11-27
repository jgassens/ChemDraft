import { describe, expect, it } from "vitest";
import { describeDragEnd, dragTestHarnessRequested, passedDragThreshold } from "./dragTestHarness";

describe("drag test harness gate", () => {
  it("is requested only by a labelled build in a desktop webview", () => {
    expect(dragTestHarnessRequested("checkout [feat/x]", true)).toBe(true);
    // A stable build is unlabelled.
    expect(dragTestHarnessRequested("", true)).toBe(false);
    expect(dragTestHarnessRequested("   ", true)).toBe(false);
    // The web build has no native drag.
    expect(dragTestHarnessRequested("checkout [feat/x]", false)).toBe(false);
  });

  it("defaults to no desktop webview under the test host", () => {
    expect(dragTestHarnessRequested()).toBe(false);
  });
});

describe("drag test pointer and status text", () => {
  it("starts a drag only past the threshold", () => {
    expect(passedDragThreshold({ x: 0, y: 0 }, { x: 3, y: 0 })).toBe(false);
    expect(passedDragThreshold({ x: 0, y: 0 }, { x: 4, y: 0 })).toBe(false);
    expect(passedDragThreshold({ x: 0, y: 0 }, { x: 4, y: 1 })).toBe(true);
    expect(passedDragThreshold({ x: 10, y: 10 }, { x: 10, y: 2 }, 6)).toBe(true);
  });

  it("names how the drag ended", () => {
    expect(describeDragEnd({ outcome: "dropped", x: 10, y: 20 })).toBe("Dropped (pointer at 10, 20).");
    expect(describeDragEnd({ outcome: "cancelled", x: 0, y: 0 })).toMatch(/cancelled/);
  });
});
