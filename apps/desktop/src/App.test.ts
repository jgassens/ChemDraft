import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { allShellCommands, paletteGroups } from "./commands";
import { createPhase4Document } from "./documentWorkflow";
import { MainWindow } from "./MainWindow";
import { PaletteWindow } from "./PaletteWindow";
import { createPaletteCommandPayload } from "./window-manager";

describe("ChemDraft desktop shell", () => {
  it("renders compact web-preview workspace regions with the docked fallback palette", () => {
    const markup = renderToStaticMarkup(
      createElement(MainWindow, { initialPaletteMode: "docked", nativePalette: false })
    );

    expect(markup).toContain("app-shell");
    expect(markup).toContain("menu-bar");
    expect(markup).toContain("command-bar");
    expect(markup).toContain("tool-palette");
    expect(markup).toContain("canvas-region");
    expect(markup).toContain("statusbar");
    expect(markup).toContain("EditorAdapter not connected");
  });

  it("renders the main desktop document window without an in-window palette by default", () => {
    const markup = renderToStaticMarkup(
      createElement(MainWindow, { initialPaletteMode: "floating", nativePalette: true })
    );

    expect(markup).toContain("app-shell");
    expect(markup).toContain("native-shell");
    expect(markup).toContain("command-bar");
    expect(markup).toContain("canvas-region");
    expect(markup).toContain("statusbar");
    expect(markup).not.toContain("menu-bar");
    expect(markup).not.toContain("tool-palette");
  });

  it("renders the native palette route as an independent palette-only surface", () => {
    const markup = renderToStaticMarkup(createElement(PaletteWindow));

    expect(markup).toContain("palette-window-shell");
    expect(markup).toContain("data-palette-drag-surface");
    expect(markup).toContain("data-tauri-drag-region");
    expect(markup).toContain("Tools");
    expect(markup).toContain("tool-palette");
    expect(markup).not.toContain("app-shell");
    expect(markup).not.toContain("canvas-region");
    expect(markup).not.toContain("utility-drawer");
  });

  it("keeps inspector and plugin drawers closed by default", () => {
    const markup = renderToStaticMarkup(
      createElement(MainWindow, { initialPaletteMode: "floating", nativePalette: true })
    );

    expect(markup).not.toContain("utility-drawer");
    expect(markup).not.toContain("drawer-title");
  });

  it("renders visible shell actions from command definitions", () => {
    const document = createPhase4Document();
    const commands = allShellCommands(document);
    const markup = renderToStaticMarkup(
      createElement(MainWindow, { initialPaletteMode: "docked", nativePalette: false })
    );

    expect(new Set(commands.map((command) => command.id)).size).toBe(commands.length);

    for (const command of commands) {
      expect(markup).toContain(command.title);
    }
  });

  it("keeps chemistry tools disabled until an EditorAdapter exists", () => {
    const enabledToolIds = new Set(["tool.select"]);
    const disabledTools = paletteGroups.flat().filter((command) => !enabledToolIds.has(command.id));

    expect(disabledTools.length).toBeGreaterThan(30);
    expect(disabledTools.every((command) => command.enabled === false)).toBe(true);
  });

  it("keeps palette buttons backed by command ids", () => {
    const markup = renderToStaticMarkup(createElement(PaletteWindow));

    for (const command of paletteGroups.flat()) {
      expect(markup).toContain(`data-command-id="${command.id}"`);
      expect(markup).toContain(command.title);
    }
  });

  it("uses custom toolbar assets for the expanded palette", () => {
    const toolCommands = paletteGroups.flat();

    expect(toolCommands.length).toBeGreaterThanOrEqual(48);
    expect(toolCommands.some((command) => command.assetName === "Custom_Bond_Wedge")).toBe(true);
    expect(toolCommands.some((command) => command.assetName === "Custom_Arrow_Equilibrium")).toBe(true);
    expect(toolCommands.some((command) => command.assetName === "Custom_Flip_Horizontal")).toBe(true);
  });

  it("keeps functional metadata on asset-backed palette commands", () => {
    const assetCommands = paletteGroups.flat().filter((command) => command.assetName);

    expect(assetCommands.length).toBeGreaterThanOrEqual(48);
    expect(assetCommands.every((command) => command.category)).toBe(true);
    expect(assetCommands.every((command) => command.description)).toBe(true);
    expect(assetCommands.find((command) => command.assetName === "Custom_Bond_Wedge")).toMatchObject({
      id: "tool.wedgeBond",
      title: "Solid Wedge Bond",
      category: "structure"
    });
  });

  it("routes palette events as command ids only", () => {
    expect(createPaletteCommandPayload("tool.select")).toEqual({ commandId: "tool.select" });
    expect(Object.keys(createPaletteCommandPayload("tool.select"))).toEqual(["commandId"]);
  });

  it("does not show fake chemistry objects on a blank document", () => {
    const markup = renderToStaticMarkup(
      createElement(MainWindow, { initialPaletteMode: "floating", nativePalette: true })
    );

    expect(markup).not.toContain("molecule-object");
    expect(markup).not.toContain("reaction");
    expect(markup).not.toContain("product");
    expect(markup).not.toContain("CCO");
  });
});
