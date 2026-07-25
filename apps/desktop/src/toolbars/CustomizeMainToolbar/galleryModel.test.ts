import { describe, expect, it } from "vitest";
import type { CommandSpec } from "../../commands";
import { buildGalleryModel, buildGallerySections, type GalleryWidgetDescriptor } from "./galleryModel";

const cmd = (id: string, title: string): CommandSpec =>
  ({ id, title, icon: "palette", source: "core" }) as CommandSpec;

const commands: CommandSpec[] = [
  cmd("tool.select", "Select"),
  cmd("tool.text", "Text"),
  cmd("tool.bond", "Bond")
];

const widgets: GalleryWidgetDescriptor[] = [{ id: "widget.core.mainStyleControls", title: "Style Controls" }];

describe("buildGalleryModel", () => {
  it("lists structural tiles, then widgets, then commands", () => {
    const entries = buildGalleryModel(commands, widgets, new Set(), "");
    expect(entries.slice(0, 2).map((entry) => entry.kind)).toEqual(["spacer", "separator"]);
    expect(entries.slice(0, 2).map((entry) => entry.title)).toEqual(["Space", "Divider"]);
    expect(entries[2]).toMatchObject({ kind: "widget", widgetId: "widget.core.mainStyleControls", title: "Style Controls" });
    expect(entries.slice(3).map((entry) => entry.commandId)).toEqual(["tool.select", "tool.text", "tool.bond"]);
  });

  it("grays commands already present in the toolbar", () => {
    const entries = buildGalleryModel(commands, widgets, new Set(["tool.text"]), "");
    const text = entries.find((entry) => entry.commandId === "tool.text");
    const select = entries.find((entry) => entry.commandId === "tool.select");
    expect(text?.present).toBe(true);
    expect(select?.present).toBe(false);
  });

  it("grays a widget tile when the widget is present, and offers it when hidden", () => {
    const present = buildGalleryModel(commands, widgets, new Set(["widget.core.mainStyleControls"]), "");
    expect(present.find((entry) => entry.kind === "widget")?.present).toBe(true);
    const hidden = buildGalleryModel(commands, widgets, new Set(), "");
    expect(hidden.find((entry) => entry.kind === "widget")?.present).toBe(false);
  });

  it("dedupes commands by id (first spec wins)", () => {
    const withDupe = [...commands, cmd("tool.select", "Select (again)")];
    const entries = buildGalleryModel(withDupe, widgets, new Set(), "");
    const selects = entries.filter((entry) => entry.commandId === "tool.select");
    expect(selects).toHaveLength(1);
    expect(selects[0]?.title).toBe("Select");
  });

  it("filters commands and widgets by title or id, case-insensitively", () => {
    expect(buildGalleryModel(commands, widgets, new Set(), "bond").map((entry) => entry.commandId)).toContain("tool.bond");
    expect(buildGalleryModel(commands, widgets, new Set(), "TOOL.TEXT").map((entry) => entry.commandId)).toEqual(["tool.text"]);
    expect(buildGalleryModel(commands, widgets, new Set(), "style").map((entry) => entry.widgetId)).toEqual([
      "widget.core.mainStyleControls"
    ]);
    expect(buildGalleryModel(commands, widgets, new Set(), "nomatch")).toHaveLength(0);
  });

  it("keeps a structural tile only when the search matches it", () => {
    const spaceOnly = buildGalleryModel(commands, [], new Set(), "space");
    expect(spaceOnly.map((entry) => entry.kind)).toEqual(["spacer"]);
    const dividerOnly = buildGalleryModel(commands, [], new Set(), "divid");
    expect(dividerOnly.map((entry) => entry.kind)).toEqual(["separator"]);
  });

  it("lists every command — no cap (the toolbar must host every tool; the tray scrolls)", () => {
    const many = Array.from({ length: 150 }, (_value, index) => cmd(`tool.n${index}`, `N${index}`));
    const entries = buildGalleryModel(many, [], new Set(), "");
    const commandEntries = entries.filter((entry) => entry.kind === "command");
    expect(commandEntries).toHaveLength(150);
  });
});

describe("buildGallerySections", () => {
  const themed: CommandSpec[] = [
    cmd("view.toolset.toggle.core.art", "Toggle Art Toolbar"),
    cmd("tool.select", "Selection Tool"),
    cmd("tool.bond", "Single Bond"),
    cmd("tool.benzene", "Benzene Template"),
    cmd("atom.setHoveredElement.N", "Set Hovered Atom: N"),
    cmd("tool.reactionArrow", "Reaction Arrow"),
    cmd("tool.plus", "Positive Charge Tool"),
    cmd("tool.pOrbital", "p Orbital Tool"),
    cmd("structure.cleanup2d", "Clean up Structure 2D"),
    cmd("text.bold", "Bold Text"),
    cmd("tool.art.pen", "Pen"),
    cmd("object.effect.glow", "Art Effect: Glow"),
    cmd("layout.alignLeft", "Align Left"),
    cmd("edit.undo", "Undo"),
    cmd("document.save", "Save Native Document"),
    cmd("view.zoomIn", "Zoom In"),
    cmd("mystery.command", "Mystery")
  ];

  it("keeps the per-glyph symbol variants with the symbols they belong to", () => {
    // The section rule used to anchor on `tool.symbol$`, dropping tool.symbol.degree and its
    // siblings into the catch-all bucket.
    const sections = buildGallerySections([
      cmd("tool.symbol", "Symbol Tool Group"),
      cmd("tool.symbol.degree", "Degree Symbol Tool"),
      cmd("tool.symbol.plusMinus", "Plus-Minus Symbol Tool"),
      cmd("tool.dagger", "Dagger Symbol Tool")
    ], [], new Set(), "");
    const symbols = sections.find((section) => section.id === "symbols");

    expect(symbols?.entries.map((entry) => entry.commandId)).toEqual([
      "tool.symbol",
      "tool.symbol.degree",
      "tool.symbol.plusMinus",
      "tool.dagger"
    ]);
    expect(sections.some((section) => section.id === "other")).toBe(false);
  });

  it("groups entries into themed sections in the declared order", () => {
    const sections = buildGallerySections(themed, widgets, new Set(), "");
    expect(sections.map((section) => section.id)).toEqual([
      "layout",
      "widgets",
      "toolbars",
      "selection",
      "bonds",
      "rings",
      "atoms",
      "arrows",
      "symbols",
      "orbitals",
      "chemistry",
      "text",
      "art",
      "objectStyle",
      "arrange",
      "editing",
      "document",
      "view",
      "other"
    ]);
    const byId = new Map(sections.map((section) => [section.id, section]));
    expect(byId.get("layout")?.entries.map((entry) => entry.title)).toEqual(["Space", "Divider"]);
    expect(byId.get("widgets")?.entries.map((entry) => entry.widgetId)).toEqual(["widget.core.mainStyleControls"]);
    expect(byId.get("bonds")?.entries.map((entry) => entry.commandId)).toEqual(["tool.bond"]);
    expect(byId.get("other")?.entries.map((entry) => entry.commandId)).toEqual(["mystery.command"]);
  });

  it("offers toolbar toggles as launcher tiles with the 'Toggle ' prefix stripped for display", () => {
    const sections = buildGallerySections(themed, [], new Set(), "");
    const toolbars = sections.find((section) => section.id === "toolbars");
    expect(toolbars?.entries).toHaveLength(1);
    expect(toolbars?.entries[0]).toMatchObject({
      commandId: "view.toolset.toggle.core.art",
      title: "Art Toolbar"
    });
    // The underlying command spec is untouched — only the tile label is shortened.
    expect(toolbars?.entries[0]?.command?.title).toBe("Toggle Art Toolbar");
  });

  it("dedupes legacy and generated launchers by target toolbar even when their titles differ", () => {
    const sections = buildGallerySections(
      [
        cmd("view.toggleRingInspector", "Toggle Rings Toolbar"),
        cmd("view.toolset.toggle.core.ringInspector", "Toggle Rings")
      ],
      [],
      new Set(),
      ""
    );
    const toolbars = sections.find((section) => section.id === "toolbars");

    expect(toolbars?.entries).toHaveLength(1);
    expect(toolbars?.entries[0]).toMatchObject({
      commandId: "view.toolset.toggle.core.ringInspector",
      title: "Rings"
    });
  });

  it("keeps distinct toolbar targets that happen to share a display title", () => {
    const sections = buildGallerySections(
      [
        cmd("view.toolset.toggle.user.alpha", "Toggle Shared Toolbar"),
        cmd("view.toolset.toggle.user.beta", "Toggle Shared Toolbar")
      ],
      [],
      new Set(),
      ""
    );
    const toolbars = sections.find((section) => section.id === "toolbars");

    expect(toolbars?.entries.map((entry) => entry.commandId)).toEqual([
      "view.toolset.toggle.user.alpha",
      "view.toolset.toggle.user.beta"
    ]);
  });

  it("drops empty sections, so a search shows only the themes that hit", () => {
    const sections = buildGallerySections(themed, widgets, new Set(), "benzene");
    expect(sections.map((section) => section.id)).toEqual(["rings"]);
  });
});
