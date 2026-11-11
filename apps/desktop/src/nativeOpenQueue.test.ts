import { describe, expect, it, vi } from "vitest";
import { formatDocumentOpenBatchStatus, formatDocumentOpenFailure, listenAndDrainNativeOpenQueue } from "./nativeOpenQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("document open status", () => {
  it("leaves empty and all-successful batches unchanged", () => {
    expect(formatDocumentOpenBatchStatus([])).toBeUndefined();
    expect(formatDocumentOpenBatchStatus([{ displayName: "a.chemdraft" }])).toBeUndefined();
    expect(formatDocumentOpenBatchStatus([{ displayName: "a.chemdraft" }, { displayName: "b.cdxml" }])).toBeUndefined();
  });

  it("names a single failed file and preserves the specific reason", () => {
    expect(formatDocumentOpenBatchStatus([{ displayName: "notes.txt", error: new Error("it is not JSON.") }]))
      .toBe("Could not open notes.txt: it is not JSON.");
    expect(formatDocumentOpenFailure("C:\\Drawings\\notes.txt", "read refused"))
      .toBe("Could not open notes.txt: read refused");
    expect(formatDocumentOpenFailure("/drawings/notes.txt", new Error("first line\nsecond line")))
      .toBe("Could not open notes.txt: first line second line");
  });

  it("summarizes one failed member even when a later file succeeded", () => {
    expect(formatDocumentOpenBatchStatus([
      { displayName: "a.chemdraft" }, { displayName: "notes.txt", error: "it is not JSON." }, { displayName: "c.cdxml" }
    ])).toBe("Opened 2 of 3 files. Could not open notes.txt: it is not JSON.");
  });

  it("lists several failed files on one line with the first reason", () => {
    expect(formatDocumentOpenBatchStatus([
      { displayName: "/drawings/a.txt", error: "it is not JSON." },
      { displayName: "C:\\Drawings\\b.cdx", error: "unsupported bond" }, { displayName: "c.cdxml" }
    ])).toBe("Opened 1 of 3 files. Could not open a.txt, b.cdx: it is not JSON.");
    expect(formatDocumentOpenBatchStatus([
      { displayName: "a.txt", error: "invalid input" }, { displayName: "b.txt", error: "invalid input" }
    ])).toBe("Opened 0 of 2 files. Could not open a.txt, b.txt: invalid input");
  });
});

describe("native open queue notifications", () => {
  it("subscribes before draining and preserves files arriving during listener registration", async () => {
    const subscribed = deferred<() => void>();
    const stop = vi.fn();
    const consume = vi.fn();
    const drain = vi.fn(async () => ["before setup", "during subscribe", "third"]);
    let changed!: () => void;
    const dispose = listenAndDrainNativeOpenQueue({
      subscribe: handler => { changed = handler; return subscribed.promise; },
      drain, consumeBatch: consume, onError: vi.fn()
    });
    changed();
    expect(drain).not.toHaveBeenCalled();
    subscribed.resolve(stop);
    await vi.waitFor(() => expect(consume.mock.calls.flat(2)).toEqual(["before setup", "during subscribe", "third"]));
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
      subscribe: async handler => { changed = handler; return () => {}; },
      drain, consumeBatch: consume, onError: vi.fn()
    });
    await vi.waitFor(() => expect(drain).toHaveBeenCalledTimes(1));
    // An old event for A overlaps the first destructive read, then C arrives during that read.
    changed();
    queue.push("live C");
    changed(); changed();
    expect(drain).toHaveBeenCalledTimes(1);
    first.resolve([]);
    await vi.waitFor(() => expect(consume.mock.calls.flat(2)).toEqual(["cold A", "cold B", "live C"]));
    expect(maximumConcurrent).toBe(1);
    changed();
    await vi.waitFor(() => expect(drain).toHaveBeenCalledTimes(3));
    expect(consume).toHaveBeenCalledTimes(2);
    expect(queue).toEqual([]);
    dispose();
  });

  it("does not discard a destructive drain completed during cleanup", async () => {
    const batch = deferred<string[]>();
    const consume = vi.fn();
    const drain = vi.fn(() => batch.promise);
    const stop = vi.fn();
    const dispose = listenAndDrainNativeOpenQueue({
      subscribe: async () => stop, drain, consumeBatch: consume, onError: vi.fn()
    });
    await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce());
    dispose();
    batch.resolve(["already dequeued"]);
    await vi.waitFor(() => expect(consume).toHaveBeenCalledExactlyOnceWith(["already dequeued"]));
    expect(stop).toHaveBeenCalledOnce();
  });
});
