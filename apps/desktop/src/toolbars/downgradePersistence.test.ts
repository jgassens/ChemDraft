import { describe, expect, it } from "vitest";
import { parseToolsetLayoutState } from "@chemdraft/toolset-registry";
import { ToolsetLayoutStateSchema as ReleasedLayoutSchema } from "../__fixtures__/toolbarLayoutSchema-v1.1.1";
import fixture from "../__fixtures__/toolbarLayoutDowngrade.json";
import { createDesktopToolsetRegistry, getToolsetItemGroups, migrateMainToolbarDefaultsLayoutState } from "../toolsets";
import { mergeVisibilityIntoLayoutState, withCurrentMainToolbarDefaults } from "./toolbarLayoutState";

// Rust's toolbar_customization_persistence_tests compare the actual files written by the native
// command helpers with this SAME fixture. Validate those bytes against the frozen released schema,
// independently of today's ToolsetLayoutStateSchema (which accepts the problematic new field).
describe("v1.1.1 toolbar layout downgrade contract", () => {
  const current = parseToolsetLayoutState({ ...fixture.legacyState, ...fixture.extensions });

  it("freezes the strict released schema, including nested objects", () => {
    expect(() => ReleasedLayoutSchema.parse(current)).toThrow();
    expect(() => ReleasedLayoutSchema.parse({ ...fixture.legacyState, futureField: true })).toThrow();
    expect(() => ReleasedLayoutSchema.parse({
      ...fixture.legacyState,
      toolsetOverrides: [{ toolsetId: "core.main", futureField: true }]
    })).toThrow();
  });

  it("accepts the native writer's legacy file for a new save and a repaired prerelease save", () => {
    expect(ReleasedLayoutSchema.parse(fixture.legacyState)).toEqual(fixture.legacyState);
    // These are the two inputs exercised by Rust's new-save and inline-migration file tests.
    expect(withCurrentMainToolbarDefaults(parseToolsetLayoutState(fixture.legacyState))).toEqual(current);
    expect(migrateMainToolbarDefaultsLayoutState(current)).toEqual(current);
    expect(mergeVisibilityIntoLayoutState(current, ["core.main"], new Set(["core.main"]))).toEqual({
      ...current,
      toolsetOverrides: [...current.toolsetOverrides.slice(1), current.toolsetOverrides[0]]
    });
  });

  it("migrates a customised v1.1.1 Main toolbar on first upgrade without a side file", () => {
    // Rust returns the unchanged legacy file with no hint when the side file is NotFound.
    const loaded = ReleasedLayoutSchema.parse({
      ...fixture.legacyState,
      toolsetOverrides: [{
        toolsetId: "core.main",
        itemOrder: { "core.main.items": ["tool.benzene", "tool.chain", "tool.bond"] },
        hiddenCommandIds: ["tool.eraser"]
      }, ...fixture.legacyState.toolsetOverrides.slice(1)]
    });
    const migrated = parseToolsetLayoutState(migrateMainToolbarDefaultsLayoutState(loaded));
    expect(migrated.mainToolbarDefaultsRevision).toBe(1);
    const ids = getToolsetItemGroups("core.main", createDesktopToolsetRegistry(migrated)).flat().map(item => item.id);
    expect(ids.slice(0, 3)).toEqual(["tool.benzene", "tool.chain", "tool.bond"]);
    expect(ids).not.toContain("tool.doubleBond");
    expect(ids).not.toContain("tool.tripleBond");
    expect(ids).not.toContain("tool.eraser");
    // The startup visibility save must retain the migrated toolbar on the next launch.
    const saved = mergeVisibilityIntoLayoutState(migrated, ["core.main"], new Set(["core.main"]));
    const reloaded = migrateMainToolbarDefaultsLayoutState(JSON.parse(JSON.stringify(saved)));
    expect(createDesktopToolsetRegistry(reloaded).get("core.main"))
      .toEqual(createDesktopToolsetRegistry(migrated).get("core.main"));
    expect(loaded).not.toHaveProperty("mainToolbarDefaultsRevision");
  });

  it("never persists a destructive fallback when a present side file is unreadable, corrupt or unmatched", () => {
    // This is the exact IPC state returned by Rust's present-but-unusable side-file tests.
    const loaded = { ...fixture.legacyState, mainToolbarDefaultsMetadataUnavailable: true };
    const migrated = parseToolsetLayoutState(migrateMainToolbarDefaultsLayoutState(loaded));
    expect(migrated).toEqual(current);
    expect(migrated.toolsetOverrides).toEqual(fixture.legacyState.toolsetOverrides);
    expect(migrated.userToolsets).toEqual(fixture.legacyState.userToolsets);
    expect(migrated.toolsetOrder).toEqual(fixture.legacyState.toolsetOrder);
    // Reproduce startup's automatic visibility save, serialization and next load. The hint must
    // not escape into the strict schema or files, nor may Chain/hides be added to Main's override.
    const saved = mergeVisibilityIntoLayoutState(migrated, ["core.main"], new Set(["core.main"]));
    expect(saved).not.toHaveProperty("mainToolbarDefaultsMetadataUnavailable");
    expect(saved.toolsetOverrides.find(override => override.toolsetId === "core.main"))
      .toEqual(fixture.legacyState.toolsetOverrides[0]);
    const reloaded = parseToolsetLayoutState(migrateMainToolbarDefaultsLayoutState(JSON.parse(JSON.stringify(saved))));
    const ids = getToolsetItemGroups("core.main", createDesktopToolsetRegistry(reloaded)).flat().map(item => item.id);
    expect(ids).toContain("tool.doubleBond");
    expect(ids).toContain("tool.tripleBond");
    expect(ids).not.toContain("tool.chain");
    expect(createDesktopToolsetRegistry(reloaded).get("core.main"))
      .toEqual(createDesktopToolsetRegistry(current).get("core.main"));
    expect(loaded).toEqual({ ...fixture.legacyState, mainToolbarDefaultsMetadataUnavailable: true });
  });

  it("honours a genuine pre-#340 inline revision without any side file", () => {
    expect(migrateMainToolbarDefaultsLayoutState(current)).toBe(current);
    const ids = getToolsetItemGroups("core.main", createDesktopToolsetRegistry(current)).flat().map(item => item.id);
    expect(ids).toContain("tool.doubleBond");
    expect(ids).toContain("tool.tripleBond");
    expect(ids).not.toContain("tool.chain");
  });
});
