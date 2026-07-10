import { describe, expect, it } from "vitest";
import type { CommandSpec } from "../../commands";
import { buildGalleryModel, type GalleryWidgetDescriptor } from "./galleryModel";

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
