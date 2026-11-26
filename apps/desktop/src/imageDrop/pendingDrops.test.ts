import { describe, expect, it, vi } from "vitest";
import type { DocumentFileDropPayload } from "./dropPosition";
import { listenAndDrainDocumentDrops, oversizedDropStatus, pendingDocumentDropsFrom, refusalsStatus, refusedDropsStatus, type PendingDocumentDrops } from "./pendingDrops";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const drop = (...paths: string[]): DocumentFileDropPayload => ({ paths, position: { x: 1, y: 2 }, units: "css", topInsetRemoved: 0, scaleFactor: 2 });

/** A model of `file_drop_queue.rs`: drops wait whole, in order, and a drain takes them all. */
function rustQueue() {
  const drops: DocumentFileDropPayload[] = [];
  let refusedDrops = 0;
  let changed: (() => void) | undefined;
  return {
    drop(payload: DocumentFileDropPayload) { drops.push(payload); changed?.(); },
    refuse() { refusedDrops += 1; changed?.(); },
    subscribe: vi.fn(async (handler: () => void) => { changed = handler; return () => { changed = undefined; }; }),
    take: vi.fn(async () => {
      const batch = { drops: drops.splice(0), refusedDrops, oversizedDrops: [] };
      refusedDrops = 0;
      return batch;
    }),
    get pending() { return drops.length; }
  };
}

const delivered = (consume: ReturnType<typeof vi.fn<(batch: PendingDocumentDrops) => void>>) =>
  consume.mock.calls.flatMap(([batch]) => batch.drops.map(({ paths }) => paths.join("+")));

describe("pending document drops", () => {
  it("keeps only well-formed drops and a positive whole refused count", () => {
    expect(pendingDocumentDropsFrom(null)).toEqual({ drops: [], refusedDrops: 0, oversizedDrops: [] });
    expect(pendingDocumentDropsFrom({ drops: [drop("/a.png"), { paths: [1] }, { paths: "/b.png" }, null], refusedDrops: 2 }))
      .toEqual({ drops: [drop("/a.png")], refusedDrops: 2, oversizedDrops: [] });
    for (const refusedDrops of [-1, 1.5, "3", Number.NaN]) {
      expect(pendingDocumentDropsFrom({ drops: [], refusedDrops }).refusedDrops).toBe(0);
    }
  });

  it("keeps only well-formed oversized drops", () => {
    const good = { files: 5000, kind: "files", limit: 4096 };
    const text = { files: 1, kind: "pathText", limit: 4194304 };
    expect(pendingDocumentDropsFrom({ drops: [], refusedDrops: 0, oversizedDrops: [good, text, null, { files: 0, kind: "files", limit: 4096 },
      { files: 3, kind: "other", limit: 4096 }, { files: "3", kind: "files", limit: 4096 }, { files: 3, kind: "files" }] }).oversizedDrops)
      .toEqual([good, text]);
    expect(pendingDocumentDropsFrom({ drops: [], oversizedDrops: "x" }).oversizedDrops).toEqual([]);
  });

  it("says of a drop too large on its own how big it was and what the limit is", () => {
    expect(oversizedDropStatus({ files: 5000, kind: "files", limit: 4096 })).toBe("Couldn't take a drop of 5000 files: at most 4096 files per drop.");
    expect(oversizedDropStatus({ files: 1, kind: "pathText", limit: 4 * 1024 * 1024 }))
      .toBe("Couldn't take a drop of 1 file: their paths are too long; at most 4.0 MB of path text per drop.");
    expect(refusalsStatus({ refusedDrops: 0, oversizedDrops: [] })).toBe("");
    expect(refusalsStatus({ refusedDrops: 1, oversizedDrops: [{ files: 5000, kind: "files", limit: 4096 }] }))
      .toBe("Couldn't take a drop of 5000 files: at most 4096 files per drop. "
        + "Couldn't take 1 more drop: too many arrived before the window was ready. Drop it again.");
  });

  it("names how many drops were refused and why", () => {
    expect(refusedDropsStatus(1)).toBe("Couldn't take 1 more drop: too many arrived before the window was ready. Drop it again.");
    expect(refusedDropsStatus(3)).toBe("Couldn't take 3 more drops: too many arrived before the window was ready. Drop them again.");
  });

  it("subscribes first, then delivers drops made before the page listened, once ready, in order", async () => {
    const queue = rustQueue();
    queue.drop(drop("/before-1.png"));
    queue.drop(drop("/before-2.png", "/before-2.cdxml"));
    const ready = deferred<void>();
    const consume = vi.fn<(batch: PendingDocumentDrops) => void>();
    const dispose = listenAndDrainDocumentDrops({ subscribe: queue.subscribe, take: queue.take, ready: () => ready.promise, consume, onError: vi.fn() });
    await vi.waitFor(() => expect(queue.subscribe).toHaveBeenCalledOnce());
    // Not ready: nothing is taken, so the drops wait in Rust; one made now joins them.
    queue.drop(drop("/while-loading.png"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(queue.take).not.toHaveBeenCalled();
    expect(queue.pending).toBe(3);
    ready.resolve();
    await vi.waitFor(() => expect(delivered(consume)).toEqual(["/before-1.png", "/before-2.png+/before-2.cdxml", "/while-loading.png"]));
    // Positions travel with each drop unchanged.
    expect(consume.mock.calls[0]![0].drops[1]).toEqual(drop("/before-2.png", "/before-2.cdxml"));
    queue.drop(drop("/live.png"));
    await vi.waitFor(() => expect(delivered(consume)).toHaveLength(4));
    expect(delivered(consume).at(-1)).toBe("/live.png");
    dispose();
  });

  it("serializes drains, so a drop made during a drain is delivered exactly once, by the next one", async () => {
    const queue = rustQueue();
    const firstTake = deferred<void>();
    let concurrent = 0;
    let maximum = 0;
    const take = queue.take.getMockImplementation()!;
    queue.take.mockImplementation(async () => {
      maximum = Math.max(maximum, ++concurrent);
      const batch = await take();
      if (queue.take.mock.calls.length === 1) await firstTake.promise;
      concurrent -= 1;
      return batch;
    });
    queue.drop(drop("/a.png"));
    const consume = vi.fn<(batch: PendingDocumentDrops) => void>();
    const dispose = listenAndDrainDocumentDrops({ subscribe: queue.subscribe, take: queue.take, ready: async () => {}, consume, onError: vi.fn() });
    await vi.waitFor(() => expect(queue.take).toHaveBeenCalledOnce());
    queue.drop(drop("/during-1.png"));
    queue.drop(drop("/during-2.png"));
    expect(queue.take).toHaveBeenCalledOnce();
    firstTake.resolve();
    await vi.waitFor(() => expect(delivered(consume)).toEqual(["/a.png", "/during-1.png", "/during-2.png"]));
    expect(maximum).toBe(1);
    expect(queue.take).toHaveBeenCalledTimes(2);
    dispose();
  });

  it("hands over a refused count alone, and takes nothing it has no drops or refusals for", async () => {
    const queue = rustQueue();
    const consume = vi.fn<(batch: PendingDocumentDrops) => void>();
    const dispose = listenAndDrainDocumentDrops({ subscribe: queue.subscribe, take: queue.take, ready: async () => {}, consume, onError: vi.fn() });
    await vi.waitFor(() => expect(queue.take).toHaveBeenCalledOnce());
    expect(consume).not.toHaveBeenCalled();
    queue.refuse();
    queue.refuse();
    await vi.waitFor(() => expect(consume).toHaveBeenCalledOnce());
    expect(consume.mock.calls[0]![0]).toEqual({ drops: [], refusedDrops: 2, oversizedDrops: [] });
    dispose();
  });

  it("leaves the drops in Rust when the page goes away before it was ready", async () => {
    const queue = rustQueue();
    queue.drop(drop("/kept.png"));
    const ready = deferred<void>();
    const consume = vi.fn<(batch: PendingDocumentDrops) => void>();
    const dispose = listenAndDrainDocumentDrops({ subscribe: queue.subscribe, take: queue.take, ready: () => ready.promise, consume, onError: vi.fn() });
    await vi.waitFor(() => expect(queue.subscribe).toHaveBeenCalledOnce());
    dispose();
    ready.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(queue.take).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(queue.pending).toBe(1);
  });

  it("reports a refused drain and keeps draining later changes", async () => {
    const queue = rustQueue();
    const onError = vi.fn();
    queue.take.mockRejectedValueOnce(new Error("Only the document window can take file drops."));
    const consume = vi.fn<(batch: PendingDocumentDrops) => void>();
    const dispose = listenAndDrainDocumentDrops({ subscribe: queue.subscribe, take: queue.take, ready: async () => {}, consume, onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    queue.drop(drop("/next.png"));
    await vi.waitFor(() => expect(delivered(consume)).toEqual(["/next.png"]));
    dispose();
  });
});
