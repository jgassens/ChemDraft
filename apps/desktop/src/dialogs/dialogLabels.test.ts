import { describe, expect, it } from "vitest";
import { formatDialogLabel, parseDialogLabel } from "./dialogLabels";

describe("dialog labels", () => {
  it("round trips both owners and preserves the migrated first-window label", () => {
    expect(formatDialogLabel("main", "pageSize", "1")).toBe("dialog-main-pageSize-1");
    for (const ownerWindowId of ["main", "doc-a", "doc-b-1234-5678"]) {
      for (const kind of ["pageSize", "export", "vibeCodeGuide"] as const) {
        expect(parseDialogLabel(formatDialogLabel(ownerWindowId, kind, "18446744073709551615")))
          .toEqual({ ownerWindowId, kind, slot: "18446744073709551615" });
      }
    }
  });
  it("rejects utility owners, path separators, unknown kinds and malformed slots", () => {
    for (const label of [null, "preferences", "toolset-main", "dialog-toolset-core-main-pageSize-1",
      "dialog--pageSize-1", "dialog-doc--pageSize-1", "dialog-doc-a/b-pageSize-1", "dialog-doc-a\\b-pageSize-1",
      "dialog-doc-a:b-pageSize-1", "dialog-doc-a b-pageSize-1", "dialog-main-preferences-1", "dialog-main-unknown-1",
      "dialog-main-pageSize-1\n", "dialog-doc-a\n-pageSize-1",
      "dialog-main-pageSize-", "dialog-main-pageSize-../main", "dialog-main-pageSize-1-extra",
      `dialog-doc-${"a".repeat(128)}-pageSize-1`, `dialog-main-export-${"1".repeat(21)}`]) {
      expect(parseDialogLabel(label), String(label)).toBeUndefined();
    }
    expect(() => formatDialogLabel("runtime", "pageSize", "1")).toThrow("Invalid dialog label");
  });
});
