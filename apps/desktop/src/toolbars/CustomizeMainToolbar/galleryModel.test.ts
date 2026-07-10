import { describe, expect, it } from "vitest";
import type { CommandSpec } from "../../commands";
import { GALLERY_COMMAND_LIMIT, buildGalleryModel } from "./galleryModel";

const cmd = (id: string, title: string): CommandSpec =>
  ({ id, title, icon: "palette", source: "core" }) as CommandSpec;

const commands: CommandSpec[] = [
  cmd("tool.select", "Select"),
  cmd("tool.text", "Text"),
  cmd("tool.bond", "Bond")
];

describe("buildGalleryModel", () => {
  it("lists the two structural tiles first, then commands", () => {
    const entries = buildGalleryModel(commands, new Set(), "");
    expect(entries.slice(0, 2).map((entry) => entry.kind)).toEqual(["spacer", "separator"]);
    expect(entries.slice(0, 2).map((entry) => entry.title)).toEqual(["Space", "Divider"]);
    expect(entries.slice(2).map((entry) => entry.commandId)).toEqual(["tool.select", "tool.text", "tool.bond"]);
  });

  it("grays commands already present in the toolbar", () => {
    const entries = buildGalleryModel(commands, new Set(["tool.text"]), "");
    const text = entries.find((entry) => entry.commandId === "tool.text");
    const select = entries.find((entry) => entry.commandId === "tool.select");
    expect(text?.present).toBe(true);
    expect(select?.present).toBe(false);
  });

  it("dedupes commands by id (first spec wins)", () => {
    const withDupe = [...commands, cmd("tool.select", "Select (again)")];
    const entries = buildGalleryModel(withDupe, new Set(), "");
    const selects = entries.filter((entry) => entry.commandId === "tool.select");
    expect(selects).toHaveLength(1);
    expect(selects[0]?.title).toBe("Select");
  });

  it("filters commands by title or id, case-insensitively", () => {
    expect(buildGalleryModel(commands, new Set(), "bond").map((entry) => entry.commandId)).toContain("tool.bond");
    expect(buildGalleryModel(commands, new Set(), "TOOL.TEXT").map((entry) => entry.commandId)).toEqual(["tool.text"]);
    expect(buildGalleryModel(commands, new Set(), "nomatch")).toHaveLength(0);
  });

  it("keeps a structural tile only when the search matches it", () => {
    const spaceOnly = buildGalleryModel(commands, new Set(), "space");
    expect(spaceOnly.map((entry) => entry.kind)).toEqual(["spacer"]);
    const dividerOnly = buildGalleryModel(commands, new Set(), "divid");
    expect(dividerOnly.map((entry) => entry.kind)).toEqual(["separator"]);
  });

  it("caps the number of command tiles", () => {
    const many = Array.from({ length: GALLERY_COMMAND_LIMIT + 20 }, (_value, index) => cmd(`tool.n${index}`, `N${index}`));
    const entries = buildGalleryModel(many, new Set(), "");
    const commandEntries = entries.filter((entry) => entry.kind === "command");
    expect(commandEntries).toHaveLength(GALLERY_COMMAND_LIMIT);
  });
});
