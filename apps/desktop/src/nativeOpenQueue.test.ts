import { describe, expect, it, vi } from "vitest";
import { createNativeOpenQueue } from "./nativeOpenQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe.each(["macos", "windows"])("native open FIFO (%s)", () => {
  it("opens three simultaneous files in order after hydration, including files on another drive", async () => {
    const files = ["/Users/chemist/one.chemdraft", "D:\\drawings\\two.cdxml", "\\\\server\\drawings\\three.cdx"];
    const pending = [...files];
    const hydrated = deferred<void>();
    const opened: string[] = [];
    const take = vi.fn(async () => pending.shift());
    const queue = createNativeOpenQueue(take);
    queue.subscribe(async path => { await hydrated.promise; opened.push(path); });
    const drain = queue.wake();
    await queue.wake(); // interleaved native wake-ups must not create competing drains
    expect(opened).toEqual([]);
    expect(take).toHaveBeenCalledTimes(1);
    hydrated.resolve();
    await drain;
    expect(opened).toEqual(files);
    expect(take).toHaveBeenCalledTimes(4);
  });

  it("retains a file consumed by an in-flight IPC across effect cleanup and resubscription", async () => {
    const first = deferred<string | undefined>();
    const take = vi.fn<() => Promise<string | undefined>>().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const queue = createNativeOpenQueue(take);
    const old = vi.fn();
    const stop = queue.subscribe(old);
    const drain = queue.wake();
    stop();
    first.resolve("one.chemdraft");
    await drain;
    expect(old).not.toHaveBeenCalled();
    const next = vi.fn(async () => {});
    queue.subscribe(next);
    await queue.wake();
    expect(next).toHaveBeenCalledExactlyOnceWith("one.chemdraft");
  });

  it("does not strand a wake-up that arrives during an empty poll", async () => {
    const empty = deferred<string | undefined>();
    const take = vi.fn<() => Promise<string | undefined>>().mockReturnValueOnce(empty.promise)
      .mockResolvedValueOnce("arrived-during-poll").mockResolvedValue(undefined);
    const queue = createNativeOpenQueue(take);
    const opened: string[] = [];
    queue.subscribe(async path => { opened.push(path); });
    const drain = queue.wake();
    await queue.wake();
    empty.resolve(undefined);
    await drain;
    expect(opened).toEqual(["arrived-during-poll"]);
  });
});
