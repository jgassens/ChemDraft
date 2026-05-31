import { describe, expect, it } from "vitest";
import {
  assertUniqueSurfaceIds,
  collectSurfaceCommandIds,
  coreSurfaceDefinitions,
  filterVisibleSurfaces,
  listSurfacesBySlot,
  parseSurfaceDefinitions,
  sortSurfaces,
  type SurfaceDefinition,
  type SurfaceSource
} from ".";

const baseSurface: SurfaceDefinition = {
  id: "surface.test.base",
  kind: "menu-item",
  source: "core",
  slot: "menu.test",
  commandId: "test.command",
  label: "Test",
  order: 10,
  defaultVisibility: "visible"
};

describe("UX surface metadata schema", () => {
  it("parses valid core surface definitions", () => {
    const surfaces = parseSurfaceDefinitions(coreSurfaceDefinitions);

    expect(surfaces).toHaveLength(5);
    expect(surfaces).toEqual(coreSurfaceDefinitions);
  });

  it("rejects empty surface IDs and command IDs", () => {
    expect(() => parseSurfaceDefinitions([{ ...baseSurface, id: "" }])).toThrow(/id must be a non-empty string/);
    expect(() => parseSurfaceDefinitions([{ ...baseSurface, commandId: " " }])).toThrow(
      /commandId must be a non-empty string/
    );
  });

  it("rejects duplicate surface IDs", () => {
    expect(() => assertUniqueSurfaceIds([baseSurface, { ...baseSurface, commandId: "test.other" }])).toThrow(
      /Duplicate surface id/
    );
    expect(() => parseSurfaceDefinitions([baseSurface, { ...baseSurface, commandId: "test.other" }])).toThrow(
      /Duplicate surface id/
    );
  });

  it("sorts surfaces by order with a stable ID fallback", () => {
    const sorted = sortSurfaces([
      { ...baseSurface, id: "surface.test.c", order: 20 },
      { ...baseSurface, id: "surface.test.b", order: 10 },
      { ...baseSurface, id: "surface.test.a", order: 10 }
    ]);

    expect(sorted.map((surface) => surface.id)).toEqual(["surface.test.a", "surface.test.b", "surface.test.c"]);
  });

  it("lists surfaces by slot in sorted order", () => {
    const surfaces = parseSurfaceDefinitions([
      { ...baseSurface, id: "surface.test.other", slot: "menu.other", order: 1 },
      { ...baseSurface, id: "surface.test.second", slot: "menu.test", order: 20 },
      { ...baseSurface, id: "surface.test.first", slot: "menu.test", order: 10 }
    ]);

    expect(listSurfacesBySlot(surfaces, "menu.test").map((surface) => surface.id)).toEqual([
      "surface.test.first",
      "surface.test.second"
    ]);
  });

  it("collects unique command IDs without requiring every surface to have a command", () => {
    const commandIds = collectSurfaceCommandIds(coreSurfaceDefinitions);

    expect(commandIds).toEqual(["document.new", "document.open", "view.toggleRulers", "document.addPageAfter"]);
  });

  it("filters visible surfaces and excludes hidden and disabled surfaces", () => {
    const surfaces = parseSurfaceDefinitions([
      baseSurface,
      { ...baseSurface, id: "surface.test.hidden", defaultVisibility: "hidden" },
      { ...baseSurface, id: "surface.test.disabled", defaultVisibility: "disabled" }
    ]);

    expect(filterVisibleSurfaces(surfaces).map((surface) => surface.id)).toEqual(["surface.test.base"]);
  });

  it("accepts core, plugin, user, and owner sources", () => {
    const sources: SurfaceSource[] = ["core", "plugin", "user", "owner"];
    const surfaces = parseSurfaceDefinitions(
      sources.map((source) => ({
        ...baseSurface,
        id: `surface.test.${source}`,
        source
      }))
    );

    expect(surfaces.map((surface) => surface.source)).toEqual(sources);
  });

  it("keeps the future add-page surface disabled and inactive", () => {
    const surfaces = parseSurfaceDefinitions(coreSurfaceDefinitions);
    const addPageSurface = surfaces.find((surface) => surface.id === "surface.canvas.addPageAfter");

    expect(addPageSurface).toMatchObject({
      kind: "canvas-control",
      slot: "canvas.page.bottomRight",
      commandId: "document.addPageAfter",
      defaultVisibility: "disabled",
      disabledReason: "Add-page command is planned but not implemented yet"
    });
    expect(filterVisibleSurfaces(surfaces).some((surface) => surface.id === "surface.canvas.addPageAfter")).toBe(
      false
    );
  });
});
