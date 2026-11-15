import { describe, expect, it, vi } from "vitest";
import { ImportedPageFitGate } from "./importedPageFitGate";

describe("imported page-size choices", () => {
  it("opens each pending file after dismissal", async () => {
    const gate = new ImportedPageFitGate();
    const show = vi.fn();
    let queue = Promise.resolve();
    for (const tabId of ["one", "two", "three"]) {
      queue = queue.then(async () => { show(tabId); await gate.wait(tabId); });
    }
    await Promise.resolve();
    expect(show.mock.calls).toEqual([["one"]]);
    gate.dismiss("other");
    await Promise.resolve();
    expect(show.mock.calls).toEqual([["one"]]);
    gate.dismiss("one");
    await vi.waitFor(() => expect(show.mock.calls).toEqual([["one"], ["two"]]));
    gate.dismiss("two");
    await vi.waitFor(() => expect(show.mock.calls).toEqual([["one"], ["two"], ["three"]]));
    gate.dismiss("three");
    await queue;
  });
});
