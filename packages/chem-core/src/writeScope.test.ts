import { applyPatches } from "./patches";
import { createEmptyDocument } from "./document";
import type { DocumentObject } from "./schemas";
import { unselectedObjectOrderChange } from "./writeScope";
import { describe, expect, it } from "vitest";

const text = (id: string): DocumentObject => ({
  id, type: "text", x: 0, y: 0, width: 10, height: 10, rotation: 0, style: {}, text: id, spans: []
});

function page() {
  const document = createEmptyDocument({ now: "2026-10-25T00:00:00.000Z" });
  return applyPatches(document, ["first", "moving-one", "second", "moving-two"].map(id => ({
    op: "addObject" as const, pageId: document.pages[0]!.id, object: text(id)
  })), { now: "2026-10-25T00:00:00.000Z" }).pages[0]!;
}

describe("unselectedObjectOrderChange", () => {
  const scope = new Set(["moving-one", "moving-two"]);

  it("returns undefined when the bystander subsequence is unchanged", () => {
    expect(unselectedObjectOrderChange(page(), ["first", "moving-one", "second", "moving-two"], scope)).toBeUndefined();
  });

  it("returns an id when bystanders are swapped", () => {
    expect(unselectedObjectOrderChange(page(), ["moving-one", "second", "first", "moving-two"], scope)).toBe("first");
  });

  it("returns an id when a bystander is omitted", () => {
    expect(unselectedObjectOrderChange(page(), ["moving-one", "second", "moving-two"], scope)).toBe("first");
  });

  it("returns an id when a bystander is duplicated", () => {
    expect(unselectedObjectOrderChange(page(), ["first", "moving-one", "second", "first", "moving-two"], scope)).toBe("first");
  });

  it("permits scoped ids to move past bystanders", () => {
    expect(unselectedObjectOrderChange(page(), ["moving-two", "first", "second", "moving-one"], scope)).toBeUndefined();
  });
});
