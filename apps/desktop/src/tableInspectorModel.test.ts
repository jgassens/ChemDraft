import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TABLE_LIMITS, deserializeDocument, type ChemDraftDocument } from "@chemdraft/chem-core";
import { createPhase4Document } from "./documentWorkflow";
import { applyTableCommand, createTableCommands, tableInspectorSnapshot } from "./tableCommands";
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

  it("shows three rule widths for three-line and one for grid, read-only", () => {
    const base = snapshot();
    const three = createTableInspectorModel({ ...base, preset: "three-line", topRulePt: 1.5, headerRulePt: 0.75, bottomRulePt: 1.5 })!;
    expect(three.sections[1].controls.map(item => [item.id, item.kind, item.kind === "readout" ? item.value : ""])).toEqual([
      ["topRule", "readout", "1.5 pt"], ["headerRule", "readout", "0.75 pt"], ["bottomRule", "readout", "1.5 pt"]
    ]);
    const grid = createTableInspectorModel({ ...base, preset: "grid", gridRulePt: 0.5 })!;
    expect(grid.sections[1].controls).toEqual([{ kind: "readout", id: "gridRule", label: "Grid line width", value: "0.5 pt" }]);
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

  it("shows font as read-only values", () => {
    const base = snapshot();
    const model = createTableInspectorModel({ ...base, fontFamily: "Georgia, serif", fontSizePx: 12 })!;
    expect(model.sections[3].controls.every(item => item.kind === "readout")).toBe(true);
    expect(control(model, "font", "fontFamily")).toMatchObject({ value: "Georgia, serif" });
    expect(control(model, "font", "fontSize")).toMatchObject({ value: "12 px" });
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
    expect(control(model, "column", "formula")).toMatchObject({ kind: "readout", value: "Auto" });
    const off = createTableInspectorModel({ ...base, activeColumn: { id: "c1", align: "left", formula: "off" } })!;
    expect(control(off, "column", "formula")).toMatchObject({ value: "Off" });
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

  it("only references commands that tableCommands registers, and they apply to the document", () => {
    const document = fixture();
    const registered = new Set(createTableCommands(document).map(command => command.id));
    const model = createTableInspectorModel(tableInspectorSnapshot(document))!;
    const commandIds = model.sections.flatMap(section => section.controls.flatMap(item =>
      item.kind === "segmented" ? item.choices.map(choice => choice.commandId) : item.kind === "readout" ? [] : [item.commandId]));
    expect(commandIds).toHaveLength(11);
    for (const id of commandIds) {
      expect(registered.has(id)).toBe(true);
      // The fixture's default cell has no formula, so Format as formula is correctly declined there.
      const declined = id === "table.cell.formatFormula";
      expect(applyTableCommand(document, id, undefined, (prefix: string) => `${prefix}-x`) === undefined).toBe(declined);
    }
  });
});
