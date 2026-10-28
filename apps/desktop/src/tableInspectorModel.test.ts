import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TABLE_LIMITS, deserializeDocument, type ChemDraftDocument } from "@chemdraft/chem-core";
import { createPhase4Document } from "./documentWorkflow";
import { applyTableCommand, applyTableFontCommand, tableInspectorSnapshot } from "./tableCommands";
import { allShellCommands, textFontFamilyCommandId } from "./commands";
import { createTableInspectorModel, type TableInspectorControl, type TableInspectorModel } from "./tableInspectorModel";

const fixture = (): ChemDraftDocument => {
  const document = deserializeDocument(readFileSync("packages/fixtures/tables/sharpless-reagent-table.json", "utf8"));
  return { ...document, selection: { pageId: document.pages[0].id, objectIds: [document.pages[0].objects[0].id] } };
};
const snapshot = () => tableInspectorSnapshot(fixture())!;
const control = (model: TableInspectorModel, sectionId: string, id: string): TableInspectorControl => {
  const found = model.sections.find(section => section.id === sectionId)?.controls.find(item => item.id === id);
  if (!found) throw new Error(`missing control ${sectionId}/${id}`);
  return found;
};

describe("table inspector model", () => {
  it("is absent when no table is selected", () => {
    expect(tableInspectorSnapshot(createPhase4Document())).toBeUndefined();
    expect(createTableInspectorModel(undefined)).toBeUndefined();
  });

  it("lays out the sections in order for a table snapshot", () => {
    const model = createTableInspectorModel(snapshot())!;
    expect(model.tableId).toBe(snapshot().tableId);
    expect(model.sections.map(section => section.id)).toEqual(["style", "rules", "header", "font", "column", "caption", "footnotes", "cell"]);
  });

  it("marks the current style and sends the registered style commands", () => {
    const base = snapshot();
    for (const [preset, selected] of [["three-line", "three-line"], ["grid", "grid"]] as const) {
      const style = control(createTableInspectorModel({ ...base, preset })!, "style", "preset");
      if (style.kind !== "segmented") throw new Error("expected segmented");
      expect(style.choices.map(item => [item.commandId, item.selected])).toEqual([
        ["table.style.threeLine", selected === "three-line"], ["table.style.grid", selected === "grid"]
      ]);
    }
  });

  it("offers registered rule widths for the current preset and marks the active width", () => {
    const base = snapshot();
    const three = createTableInspectorModel({ ...base, preset: "three-line", topRulePt: 1.5, headerRulePt: 0.75, bottomRulePt: 1.5 })!;
    expect(three.sections[1].controls.map(item => [item.id, item.kind, item.kind === "segmented" ? item.choices.find(choice => choice.selected)?.commandId : ""])).toEqual([
      ["topRule", "segmented", "table.rule.top.1.5"], ["headerRule", "segmented", "table.rule.header.0.75"], ["bottomRule", "segmented", "table.rule.bottom.1.5"]
    ]);
    const grid = createTableInspectorModel({ ...base, preset: "grid", gridRulePt: 0.5 })!;
    expect(grid.sections[1].controls).toHaveLength(1);
    const widths = control(grid, "rules", "gridRule");
    if (widths.kind !== "segmented") throw new Error("expected segmented");
    expect(widths.choices.map(item => item.commandId)).toEqual([0, 0.25, 0.5, 0.75, 1, 1.5, 2].map(width => `table.rule.grid.${width}`));
    expect(widths.choices.find(item => item.selected)?.commandId).toBe("table.rule.grid.0.5");
  });

  it("toggles header bold and caption through their commands", () => {
    const base = snapshot();
    expect(control(createTableInspectorModel({ ...base, headerBold: true })!, "header", "headerBold"))
      .toMatchObject({ kind: "toggle", commandId: "table.header.bold.toggle", pressed: true });
    expect(control(createTableInspectorModel({ ...base, hasCaption: false })!, "caption", "caption"))
      .toMatchObject({ kind: "toggle", commandId: "table.caption.toggle", pressed: false });
    expect(control(createTableInspectorModel({ ...base, hasCaption: true })!, "caption", "caption"))
      .toMatchObject({ pressed: true });
  });

  it("offers existing font commands, including a custom current family", () => {
    const base = snapshot();
    const model = createTableInspectorModel({ ...base, fontFamily: "Georgia, serif", fontSizePx: 16 })!;
    const family = control(model, "font", "fontFamily"), size = control(model, "font", "fontSize");
    if (family.kind !== "segmented" || size.kind !== "segmented") throw new Error("expected segmented");
    expect(family.choices.find(item => item.selected)?.commandId).toBe("text.font.georgia");
    expect(size.choices.find(item => item.selected)?.commandId).toBe("text.size.12");
    const custom = control(createTableInspectorModel({ ...base, fontFamily: "PT Sans Narrow" })!, "font", "fontFamily");
    if (custom.kind !== "segmented") throw new Error("expected segmented");
    expect(custom.choices.find(item => item.selected)?.commandId).toBe(textFontFamilyCommandId("PT Sans Narrow"));
  });

  it("offers the four column alignments and selects the active one", () => {
    const base = snapshot();
    const model = createTableInspectorModel({ ...base, activeColumn: { id: "c1", align: "decimal", formula: "auto" } })!;
    const align = control(model, "column", "align");
    if (align.kind !== "segmented") throw new Error("expected segmented");
    expect(align.choices.map(item => [item.commandId, item.selected])).toEqual([
      ["table.column.align.left", false], ["table.column.align.center", false],
      ["table.column.align.right", false], ["table.column.align.decimal", true]
    ]);
    expect(align.choices.every(item => item.disabledReason === undefined)).toBe(true);
    expect(control(model, "column", "formula")).toMatchObject({ kind: "segmented", choices: [
      { commandId: "table.column.formula.auto", selected: true }, { commandId: "table.column.formula.off", selected: false }
    ] });
    const off = createTableInspectorModel({ ...base, activeColumn: { id: "c1", align: "left", formula: "off" } })!;
    expect(control(off, "column", "formula")).toMatchObject({ choices: [
      { commandId: "table.column.formula.auto", selected: false }, { commandId: "table.column.formula.off", selected: true }
    ] });
  });

  it("disables the column controls with a reason when there is no active column", () => {
    const model = createTableInspectorModel({ ...snapshot(), activeColumn: undefined })!;
    const align = control(model, "column", "align");
    if (align.kind !== "segmented") throw new Error("expected segmented");
    expect(align.disabledReason).toBe("Click a cell to choose a column");
    expect(align.choices.every(item => item.disabledReason === "Click a cell to choose a column" && !item.selected)).toBe(true);
    expect(control(model, "column", "formula").disabledReason).toBe("Click a cell to choose a column");
  });

  it("disables Add footnote at the footnote limit, with the same reason the command carries", () => {
    const base = snapshot();
    expect(control(createTableInspectorModel({ ...base, footnoteCount: 2 })!, "footnotes", "addFootnote"))
      .toMatchObject({ kind: "button", commandId: "table.footnote.add" });
    expect(control(createTableInspectorModel({ ...base, footnoteCount: 2 })!, "footnotes", "addFootnote").disabledReason).toBeUndefined();
    expect(control(createTableInspectorModel({ ...base, footnoteCount: TABLE_LIMITS.maxFootnotes })!, "footnotes", "addFootnote").disabledReason)
      .toBe("Table has the maximum number of footnotes");
    expect(control(createTableInspectorModel({ ...base, footnoteCount: 3 })!, "footnotes", "footnoteCount"))
      .toMatchObject({ kind: "readout", value: "3" });
  });

  it("takes disabled reasons for registered commands from live availability", () => {
    const lookup = (id: string) => id === "table.cell.formatFormula" ? { enabled: false, disabledReason: "This cell has no formula to format" }
      : id === "table.header.bold.toggle" ? { enabled: false } : undefined;
    const model = createTableInspectorModel(snapshot(), lookup)!;
    expect(control(model, "cell", "formatFormula")).toMatchObject({ commandId: "table.cell.formatFormula", disabledReason: "This cell has no formula to format" });
    expect(control(model, "cell", "plainText")).toMatchObject({ commandId: "table.cell.plainText" });
    expect(control(model, "cell", "plainText").disabledReason).toBeUndefined();
    expect(control(model, "header", "headerBold").disabledReason).toBe("Unavailable right now");
  });

  it("preserves live disabled reasons for rule widths, fonts and column formulae", () => {
    const disabledIds = ["table.rule.top.0.5", "text.font.times", "text.size.12", "table.column.formula.off"];
    const model = createTableInspectorModel(snapshot(), id => disabledIds.includes(id)
      ? { enabled: false, disabledReason: "Finish editing first" } : { enabled: true })!;
    const choices = model.sections.flatMap(section => section.controls.flatMap(item => item.kind === "segmented" ? item.choices : []));
    for (const id of disabledIds) expect(choices.find(item => item.commandId === id)?.disabledReason).toBe("Finish editing first");
  });

  it("references registered commands or the custom font family and they apply to the document", () => {
    const document = fixture();
    const registered = new Set(allShellCommands(document).map(command => command.id));
    const model = createTableInspectorModel(tableInspectorSnapshot(document))!;
    const commandIds = model.sections.flatMap(section => section.controls.flatMap(item =>
      item.kind === "segmented" ? item.choices.map(choice => choice.commandId) : item.kind === "readout" ? [] : [item.commandId]));
    expect(commandIds.length).toBeGreaterThan(11);
    for (const id of commandIds) {
      expect(registered.has(id) || id.startsWith("text.font.family:")).toBe(true);
      // The fixture's default cell has no formula, so Format as formula is correctly declined there.
      const declined = id === "table.cell.formatFormula";
      const result = id.startsWith("text.") ? applyTableFontCommand(document, id)
        : applyTableCommand(document, id, undefined, (prefix: string) => `${prefix}-x`);
      expect(result === undefined).toBe(declined);
    }
  });
});
