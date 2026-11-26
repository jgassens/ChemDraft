// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollPlacementAgainstFit, pollWorkAreaChanges, WORK_AREA_POLL_MS, workAreaKey, workAreaPlacementKey } from "./workAreaPoll";

const area = (right: number, bottom = 1000) => ({ left: 0, top: 0, right, bottom });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("keys a work area by all four edges", () => {
  expect(workAreaKey({ left: -1920, top: 24, right: 0, bottom: 1040 })).toBe("-1920:24:0:1040");
});

it("reports only a change from the previous read, never the first read", async () => {
  const onChange = vi.fn();
  const readArea = vi.fn(async () => area(1920));
  const stop = pollWorkAreaChanges(onChange, readArea, { isHidden: () => false });
  await vi.advanceTimersByTimeAsync(0);
  expect(readArea).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS * 2);
  expect(readArea).toHaveBeenCalledTimes(3);
  expect(onChange).not.toHaveBeenCalled();
  readArea.mockResolvedValue(area(1880));
  await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS);
  expect(onChange).toHaveBeenCalledTimes(1);
  // The same new area again is not another change.
  await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS * 3);
  expect(onChange).toHaveBeenCalledTimes(1);
  stop();
  readArea.mockResolvedValue(area(1280));
  await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS * 3);
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(readArea).toHaveBeenCalledTimes(7);
});

it("skips reads while hidden or while a read is still pending, and ignores a read that ends after stop", async () => {
  const onChange = vi.fn();
  let hidden = true;
  let finish: ((value: ReturnType<typeof area>) => void) | undefined;
  const readArea = vi.fn(() => new Promise<ReturnType<typeof area>>(resolve => { finish = resolve; }));
  const stop = pollWorkAreaChanges(onChange, readArea, { isHidden: () => hidden });
  await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS);
  expect(readArea).not.toHaveBeenCalled();
  hidden = false;
  await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS * 3);
  // The first read never resolved, so no second read started.
  expect(readArea).toHaveBeenCalledTimes(1);
  finish!(area(1920));
  await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS);
  expect(readArea).toHaveBeenCalledTimes(2);
  stop();
  finish!(area(1280));
  await vi.advanceTimersByTimeAsync(0);
  expect(onChange).not.toHaveBeenCalled();
});

it("keeps polling after a failed read", async () => {
  const onChange = vi.fn();
  const readArea = vi.fn(async () => area(1920));
  readArea.mockRejectedValueOnce(new Error("no monitor"));
  const stop = pollWorkAreaChanges(onChange, readArea, { isHidden: () => false });
  await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS);
  readArea.mockResolvedValue(area(1500));
  await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS);
  expect(onChange).toHaveBeenCalledTimes(1);
  stop();
});

it("records a changed area only once onChange handled it, so a refused refit is retried", async () => {
  // Linux 1.2.2 VM: a refit the native side refused must not be forgotten until the next change.
  const answers: (() => Promise<boolean>)[] = [
    async () => false,
    async () => { throw new Error("refit failed"); },
    async () => true
  ];
  const onChange = vi.fn(() => answers.shift()!());
  const readArea = vi.fn(async () => area(1680));
  const stop = pollWorkAreaChanges(onChange, readArea, { isHidden: () => false });
  await vi.advanceTimersByTimeAsync(0);
  readArea.mockResolvedValue(area(1024));
  await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS);
  expect(onChange).toHaveBeenCalledTimes(1);
  // Refused: the same area is still a change on the next read.
  await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS);
  expect(onChange).toHaveBeenCalledTimes(2);
  // Failed: retried again.
  await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS);
  expect(onChange).toHaveBeenCalledTimes(3);
  // Accepted: recorded, so the same area is no longer a change.
  await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS * 3);
  expect(onChange).toHaveBeenCalledTimes(3);
  stop();
});

it("does not record an area whose handling ends after stop", async () => {
  let finish: ((handled: boolean) => void) | undefined;
  const onChange = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const readArea = vi.fn(async () => area(1680));
  const stop = pollWorkAreaChanges(onChange, readArea, { isHidden: () => false });
  await vi.advanceTimersByTimeAsync(0);
  readArea.mockResolvedValue(area(1024));
  await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS);
  expect(onChange).toHaveBeenCalledTimes(1);
  // While the refit is in flight, no second read starts.
  await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS * 2);
  expect(onChange).toHaveBeenCalledTimes(1);
  stop();
  finish!(true);
  await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS * 2);
  expect(onChange).toHaveBeenCalledTimes(1);
});

it("keys a placement by the work area and the display scale", () => {
  const edges = { left: -1920, top: 24, right: 0, bottom: 1040 };
  expect(workAreaPlacementKey(edges, 1)).toBe("-1920:24:0:1040@1");
  expect(workAreaPlacementKey(edges, 2)).not.toBe(workAreaPlacementKey(edges, 1));
});

describe("pollPlacementAgainstFit (Linux content-fit palettes)", () => {
  const key = (right: number, scale = 1) => workAreaPlacementKey(area(right), scale);

  it("compares each read with the last accepted fit, not with an earlier read", async () => {
    // A move fits another area between polls; a silent return to the first area is still a change.
    let fitted: string | undefined = key(1680);
    const refit = vi.fn();
    const readArea = vi.fn(async () => area(1680));
    const stop = pollPlacementAgainstFit(refit, readArea, () => fitted, { isHidden: () => false });
    await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS);
    expect(refit).not.toHaveBeenCalled();
    fitted = key(1024);
    await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS);
    expect(refit).toHaveBeenCalledTimes(1);
    stop();
  });

  it("records nothing itself: only the caller's accepted fit ends the refits", async () => {
    let fitted: string | undefined = key(1680);
    const refit = vi.fn();
    const readArea = vi.fn(async () => area(1024));
    const stop = pollPlacementAgainstFit(refit, readArea, () => fitted, { isHidden: () => false });
    await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS * 2);
    // Refused (the fitted key did not move): retried.
    expect(refit).toHaveBeenCalledTimes(2);
    // The fit used a different area than the poll read: still not the read area, so refit again.
    fitted = key(1280);
    await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS);
    expect(refit).toHaveBeenCalledTimes(3);
    fitted = key(1024);
    await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS * 3);
    expect(refit).toHaveBeenCalledTimes(3);
    stop();
  });

  it("treats a scale change on the same work area as a change", async () => {
    const fitted = key(1680, 1);
    const refit = vi.fn();
    vi.stubGlobal("devicePixelRatio", 2);
    try {
      const stop = pollPlacementAgainstFit(refit, async () => area(1680), () => fitted, { isHidden: () => false });
      await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS);
      expect(refit).toHaveBeenCalledTimes(1);
      stop();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads nothing before a first accepted fit, while hidden, or after stop", async () => {
    let fitted: string | undefined;
    let hidden = false;
    const refit = vi.fn();
    const readArea = vi.fn(async () => area(1024));
    const stop = pollPlacementAgainstFit(refit, readArea, () => fitted, { isHidden: () => hidden });
    await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS * 2);
    expect(readArea).not.toHaveBeenCalled();
    fitted = key(1680);
    hidden = true;
    await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS * 2);
    expect(readArea).not.toHaveBeenCalled();
    hidden = false;
    await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS);
    expect(refit).toHaveBeenCalledTimes(1);
    stop();
    await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS * 2);
    expect(readArea).toHaveBeenCalledTimes(1);
    expect(refit).toHaveBeenCalledTimes(1);
  });
});
