import { describe, expect, it, vi } from "vitest";
import { listenAndDrainNativeOpenQueue } from "./nativeOpenQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("native open queue notifications", () => {
  it("subscribes before draining and preserves files arriving during listener registration", async () => {
    const subscribed = deferred<() => void>();
    const stop = vi.fn();
    const consume = vi.fn();
    const drain = vi.fn(async () => ["before setup", "during subscribe", "third"]);
    let changed!: () => void;
    const dispose = listenAndDrainNativeOpenQueue({
      listen: handler => { changed = handler; return subscribed.promise; },
      drain, consume, onError: vi.fn()
    });
    changed();
    expect(drain).not.toHaveBeenCalled();
    subscribed.resolve(stop);
    await vi.waitFor(() => expect(consume.mock.calls.flat()).toEqual(["before setup", "during subscribe", "third"]));
    expect(drain).toHaveBeenCalledTimes(1);
    dispose();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("serializes overlapping live notifications and drains each payload exactly once", async () => {
    const first = deferred<string[]>();
    const queue = ["cold A", "cold B"];
    let changed!: () => void;
    let concurrent = 0;
    let maximumConcurrent = 0;
    const consume = vi.fn();
    const drain = vi.fn(async () => {
      maximumConcurrent = Math.max(maximumConcurrent, ++concurrent);
      const batch = queue.splice(0);
      if (drain.mock.calls.length === 1) await first.promise;
      concurrent--;
      return batch;
    });
    const dispose = listenAndDrainNativeOpenQueue({
      listen: async handler => { changed = handler; return () => {}; },
      drain, consume, onError: vi.fn()
    });
    await vi.waitFor(() => expect(drain).toHaveBeenCalledTimes(1));
    // An old event for A overlaps the first destructive read, then C arrives during that read.
    changed();
    queue.push("live C");
    changed(); changed();
    expect(drain).toHaveBeenCalledTimes(1);
    first.resolve([]);
    await vi.waitFor(() => expect(consume.mock.calls.flat()).toEqual(["cold A", "cold B", "live C"]));
    expect(maximumConcurrent).toBe(1);
    changed();
    await vi.waitFor(() => expect(drain).toHaveBeenCalledTimes(3));
    expect(consume).toHaveBeenCalledTimes(3);
    expect(queue).toEqual([]);
    dispose();
  });

  it("does not discard a destructive drain completed during cleanup", async () => {
    const batch = deferred<string[]>();
    const consume = vi.fn();
    const drain = vi.fn(() => batch.promise);
    const stop = vi.fn();
    const dispose = listenAndDrainNativeOpenQueue({
      listen: async () => stop, drain, consume, onError: vi.fn()
    });
    await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce());
    dispose();
    batch.resolve(["already dequeued"]);
    await vi.waitFor(() => expect(consume).toHaveBeenCalledExactlyOnceWith("already dequeued"));
    expect(stop).toHaveBeenCalledOnce();
  });
});
