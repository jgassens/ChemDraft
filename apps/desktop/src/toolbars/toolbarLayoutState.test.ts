import { describe, expect, it } from "vitest";
import { parseToolsetLayoutState, type ToolsetLayoutState } from "@chemdraft/toolset-registry";
import { mergeVisibilityIntoLayoutState } from "./toolbarLayoutState";

describe("mergeVisibilityIntoLayoutState", () => {
  it("records visibility for every known toolset and stays schema-valid", () => {
    const state = mergeVisibilityIntoLayoutState(undefined, ["core.main", "core.art"], new Set(["core.main"]));
    expect(state.toolsetOverrides).toEqual([
      { toolsetId: "core.main", visible: true },
      { toolsetId: "core.art", visible: false }
    ]);
    // Round-trips through the loader's schema (what Rust reads back).
    expect(() => parseToolsetLayoutState(state)).not.toThrow();
  });

  it("updates visibility without clobbering other customization on the same override", () => {
    const existing: ToolsetLayoutState = {
      version: 1,
      toolsetOverrides: [{ toolsetId: "core.main", visible: false, title: "Renamed", hiddenCommandIds: ["tool.bond"] }],
      userToolsets: []
    };
    const merged = mergeVisibilityIntoLayoutState(existing, ["core.main"], new Set(["core.main"]));
    expect(merged.toolsetOverrides[0]).toEqual({
      toolsetId: "core.main",
      visible: true,
      title: "Renamed",
      hiddenCommandIds: ["tool.bond"]
    });
  });

  it("hides a customized toolset while preserving its other customization", () => {
    const existing: ToolsetLayoutState = {
      version: 1,
      toolsetOverrides: [{ toolsetId: "core.main", visible: true, title: "Renamed", hiddenCommandIds: ["tool.bond"] }],
      userToolsets: []
    };
    const merged = mergeVisibilityIntoLayoutState(existing, ["core.main"], new Set());
    expect(merged.toolsetOverrides[0]).toEqual({
      toolsetId: "core.main",
      visible: false,
      title: "Renamed",
      hiddenCommandIds: ["tool.bond"]
    });
  });

  it("preserves overrides for toolsets that aren't in the passed id list (unloaded or unresolved plugins)", () => {
    // This is the mechanism the MainWindow visibility save relies on to avoid clobbering a
    // just-appeared plugin toolset's saved visible:true: exclude it from the id list and its
    // override is carried through untouched.
    const existing: ToolsetLayoutState = {
      version: 1,
      toolsetOverrides: [{ toolsetId: "plugin.absent", visible: true }],
      userToolsets: []
    };
    const merged = mergeVisibilityIntoLayoutState(existing, ["core.main"], new Set());
    expect(merged.toolsetOverrides).toContainEqual({ toolsetId: "plugin.absent", visible: true });
    expect(merged.toolsetOverrides).toContainEqual({ toolsetId: "core.main", visible: false });
  });
});
