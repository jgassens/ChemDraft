import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  App,
  createQuickActions,
  drawerActions,
  paletteGroups,
  styleActions,
  type CommandSpec
} from "./App";
import { createPhase4Document } from "./documentWorkflow";

describe("ChemDraft desktop shell", () => {
  it("renders compact desktop workspace regions", () => {
    const markup = renderToStaticMarkup(createElement(App));

    expect(markup).toContain("app-shell");
    expect(markup).toContain("menu-bar");
    expect(markup).toContain("command-bar");
    expect(markup).toContain("tool-palette");
    expect(markup).toContain("canvas-region");
    expect(markup).toContain("statusbar");
    expect(markup).toContain("EditorAdapter not connected");
  });

  it("keeps inspector and plugin drawers closed by default", () => {
    const markup = renderToStaticMarkup(createElement(App));

    expect(markup).not.toContain("utility-drawer");
    expect(markup).not.toContain("drawer-title");
  });

  it("renders visible shell actions from command definitions", () => {
    const document = createPhase4Document();
    const commands = allShellCommands(document);
    const markup = renderToStaticMarkup(createElement(App));

    expect(new Set(commands.map((command) => command.id)).size).toBe(commands.length);

    for (const command of commands) {
      expect(markup).toContain(command.title);
    }
  });

  it("keeps chemistry tools disabled until an EditorAdapter exists", () => {
    const disabledToolIds = new Set([
      "tool.lasso",
      "tool.bond",
      "tool.atom",
      "tool.ring",
      "tool.chain",
      "tool.mechanismArrow",
      "tool.charge",
      "tool.text",
      "tool.bracket"
    ]);

    const disabledTools = paletteGroups.flat().filter((command) => disabledToolIds.has(command.id));

    expect(disabledTools).toHaveLength(disabledToolIds.size);
    expect(disabledTools.every((command) => command.enabled === false)).toBe(true);
  });

  it("does not show fake chemistry objects on a blank document", () => {
    const markup = renderToStaticMarkup(createElement(App));

    expect(markup).not.toContain("molecule-object");
    expect(markup).not.toContain("reaction");
    expect(markup).not.toContain("product");
    expect(markup).not.toContain("CCO");
  });
});

function allShellCommands(document = createPhase4Document()): CommandSpec[] {
  return [
    ...createQuickActions(document, undefined),
    ...paletteGroups.flat(),
    ...drawerActions,
    ...styleActions
  ];
}
