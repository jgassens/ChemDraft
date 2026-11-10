import { describe, expect, it } from "vitest";
import { parseToolsetLayoutState } from "@chemdraft/toolset-registry";
import { ToolsetLayoutStateSchema as ReleasedLayoutSchema } from "../__fixtures__/toolbarLayoutSchema-v1.1.1";
import fixture from "../__fixtures__/toolbarLayoutDowngrade.json";
import { migrateMainToolbarDefaultsLayoutState } from "../toolsets";
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

  it("falls back to the pre-revision migration without losing saved layout when metadata is unavailable", () => {
    // Missing/corrupt/stale side files return exactly legacyState in the native reader tests.
    const migrated = parseToolsetLayoutState(migrateMainToolbarDefaultsLayoutState(fixture.legacyState));
    expect(migrated).toEqual(current);
    expect(migrated.toolsetOverrides).toEqual(fixture.legacyState.toolsetOverrides);
    expect(migrated.userToolsets).toEqual(fixture.legacyState.userToolsets);
    expect(migrated.toolsetOrder).toEqual(fixture.legacyState.toolsetOrder);
  });
});
