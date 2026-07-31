/**
 * The rename's migration. Its whole job is that a user who customized their toolbar before
 * 2026-07-31 does not open ChemDraft to a default one.
 */
import { describe, expect, it } from "vitest";

import { migrateLegacyId, migrateLegacyToolsetIds } from "./legacyToolsetIds";

describe("migrateLegacyId", () => {
  it("maps every renamed id", () => {
    expect(migrateLegacyId("core.moleculeInspector")).toBe("core.drawnStructureSettings");
    expect(migrateLegacyId("view.toggleMoleculeInspector")).toBe("view.toggleDrawnStructureSettings");
    expect(migrateLegacyId("widget.core.moleculeInspector")).toBe("widget.core.drawnStructureSettings");
    expect(migrateLegacyId("moleculeInspector.template.import")).toBe("drawnStructureSettings.template.import");
    expect(migrateLegacyId("moleculeInspector.template.export")).toBe("drawnStructureSettings.template.export");
  });

  it("leaves every other id alone", () => {
    for (const id of ["core.main", "core.ringInspector", "view.toggleInspector", "plugin.massFragment.analyze"]) {
      expect(migrateLegacyId(id)).toBe(id);
    }
  });

  it("does not touch an id that merely contains a legacy one", () => {
    // Substring-safe: the map is keyed on whole ids, so a longer id is not partially rewritten.
    expect(migrateLegacyId("core.moleculeInspectorExtra")).toBe("core.moleculeInspectorExtra");
  });
});

describe("migrateLegacyToolsetIds", () => {
  it("rewrites ids used as object KEYS, which is how the state actually persists", () => {
    // toolbar-state.json keys by toolset id rather than storing it in a field, so a migration that
    // only walked values would miss the case that matters most.
    const saved = {
      toolsets: {
        "core.moleculeInspector": { visible: true, x: 40, y: 120 },
        "core.main": { visible: true, x: 0, y: 0 }
      }
    };
    expect(migrateLegacyToolsetIds(saved)).toEqual({
      toolsets: {
        "core.drawnStructureSettings": { visible: true, x: 40, y: 120 },
        "core.main": { visible: true, x: 0, y: 0 }
      }
    });
  });

  it("rewrites ids nested in arrays of items, preserving order and every other field", () => {
    const saved = {
      toolsetOverrides: [
        { id: "core.moleculeInspector", visible: false, itemIds: ["widget.core.moleculeInspector"] },
        { id: "core.main", visible: true, itemIds: ["tool.select"] }
      ]
    };
    expect(migrateLegacyToolsetIds(saved)).toEqual({
      toolsetOverrides: [
        { id: "core.drawnStructureSettings", visible: false, itemIds: ["widget.core.drawnStructureSettings"] },
        { id: "core.main", visible: true, itemIds: ["tool.select"] }
      ]
    });
  });

  it("leaves a user's own toolbar name alone even when it reads like an id", () => {
    // The reason this walks the structure instead of replacing over the JSON text: a blind string
    // pass would rewrite a label the user typed.
    const saved = { userToolsets: [{ id: "user.mine", name: "my core.moleculeInspector clone" }] };
    expect(migrateLegacyToolsetIds(saved)).toEqual({
      userToolsets: [{ id: "user.mine", name: "my core.moleculeInspector clone" }]
    });
  });

  it("passes through primitives, null, and an empty state untouched", () => {
    expect(migrateLegacyToolsetIds(null)).toBeNull();
    expect(migrateLegacyToolsetIds(42)).toBe(42);
    expect(migrateLegacyToolsetIds(true)).toBe(true);
    expect(migrateLegacyToolsetIds({})).toEqual({});
  });
});
