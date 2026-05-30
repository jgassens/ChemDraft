import { describe, expect, it } from "vitest";
import {
  ToolsetDefinitionSchema,
  ToolsetRegistry,
  createToolbarsMenuModel,
  createToolsetToggleCommandDefinitions,
  createToolsetToggleCommandId,
  parseToolsetManifest,
  type ToolsetDefinition,
  parseToolsetToggleCommandId
} from "./index";

const fixtureToolset: ToolsetDefinition = {
  id: "core.fixture",
  title: "Fixture Toolbar",
  source: "core",
  defaultVisible: true,
  defaultMode: "floating",
  preferredWindowSize: { width: 96, height: 320 },
  groups: [
    {
      id: "fixture.tools",
      items: [{ commandId: "tool.select", title: "Selection Tool", icon: "select", shortcutDisplay: "V" }]
    }
  ]
};

describe("toolset registry", () => {
  it("validates typed toolset definitions", () => {
    expect(ToolsetDefinitionSchema.parse(fixtureToolset).id).toBe("core.fixture");
  });

  it("registers toolsets and rejects duplicate ids", () => {
    const registry = new ToolsetRegistry([fixtureToolset]);

    expect(registry.require("core.fixture").title).toBe("Fixture Toolbar");
    expect(registry.listCommandIds()).toEqual(["tool.select"]);
    expect(() => registry.register(fixtureToolset)).toThrow(/already registered/);
  });

  it("parses manifest-style toolset contributions", () => {
    const toolsets = parseToolsetManifest({ toolsets: [fixtureToolset] });

    expect(toolsets).toHaveLength(1);
    expect(toolsets[0].groups[0].items[0].commandId).toBe("tool.select");
  });

  it("creates menu and toggle command models from registered toolsets", () => {
    const menu = createToolbarsMenuModel([fixtureToolset], new Set());
    const toggles = createToolsetToggleCommandDefinitions([fixtureToolset]);

    expect(menu).toEqual([
      expect.objectContaining({
        title: "Fixture Toolbar",
        commandId: "view.toolset.toggle.core.fixture",
        checked: false
      })
    ]);
    expect(toggles).toEqual([
      expect.objectContaining({
        id: "view.toolset.toggle.core.fixture",
        toolsetId: "core.fixture",
        category: "view"
      })
    ]);
  });

  it("round-trips toolset toggle command ids", () => {
    expect(createToolsetToggleCommandId("plugin.fixture")).toBe("view.toolset.toggle.plugin.fixture");
    expect(parseToolsetToggleCommandId("view.toolset.toggle.plugin.fixture")).toBe("plugin.fixture");
    expect(parseToolsetToggleCommandId("view.toggleRulers")).toBeUndefined();
  });
});
