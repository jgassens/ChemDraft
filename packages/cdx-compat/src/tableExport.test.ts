import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { nativeTextStyleFromObjectStyle, parseDocument, type TableObject } from "@chemdraft/chem-core";
import { measureTextRun, planTableLayout } from "@chemdraft/layout-engine";
import { canonicalVisibleCdxml, exportDocumentToCdxml, openChemDraftPayload } from "./index";

const fixture = () => parseDocument(JSON.parse(readFileSync(new URL("../../fixtures/tables/sharpless-reagent-table.json", import.meta.url), "utf8")));
const xml = (contents: string) => new JSDOM(contents, { contentType: "text/xml" }).window.document;

describe("CDXML table approximation", () => {
  it("exports the fixture as rich text and rules that re-import as text and lines", () => {
    const document = fixture();
    const table = document.pages[0].objects[0] as TableObject;
    const layout = planTableLayout(table);
    const result = exportDocumentToCdxml(document);
    const group = xml(result.contents).querySelector("page > group")!;
    expect(group).toBeTruthy();
    const texts = [...group.querySelectorAll("t")];
    const count = table.rows.flatMap(row => row.cells).filter(cell => cell.text.length > 0).length + 1 + table.footnotes.length;
    expect(texts).toHaveLength(count);
    expect(result.warnings).toContainEqual({ code: "cdxml.table_approximated", sourceObjectId: table.id,
      message: `Table "${table.id}" was written as ${count} text objects and 3 lines; other programs will not edit it as a table.` });
    const titanium = texts.find(text => text.textContent === "Ti(OiPr)4")!;
    const solvent = texts.find(text => text.textContent === "CH2Cl2")!;
    expect([...titanium.querySelectorAll("s")].find(run => run.textContent === "4")?.getAttribute("face")).toBe("32");
    expect([...solvent.querySelectorAll("s")].filter(run => run.textContent === "2").every(run => Number(run.getAttribute("face")) & 32)).toBe(true);
    expect(texts.some(text => [...text.querySelectorAll("s")].some(run => Number(run.getAttribute("face")) & 64))).toBe(true);
    const graphics = [...group.querySelectorAll("graphic")];
    expect(graphics).toHaveLength(3);
    graphics.forEach((graphic, index) => {
      expect(graphic.getAttribute("Start")!.split(" ").map(Number)).toEqual(layout.rules[index] && [layout.rules[index].x1 * 0.75, layout.rules[index].y1 * 0.75].map(n => expect.closeTo(n, 2)));
    });
    const style = nativeTextStyleFromObjectStyle(table.style);
    for (const [columnIndex, column] of layout.columns.entries()) {
      if (column.decimalAnchorX === undefined) continue;
      const anchors = layout.cells.filter(cell => cell.columnIndex === columnIndex && cell.rowIndex >= table.headerRowCount)
        .filter(cell => cell.lines[0].pieces.flatMap(piece => piece.runs).length > 0)
        .map(cell => {
          const line = cell.lines[0];
          const preceding = layout.cells.slice(0, layout.cells.indexOf(cell)).flatMap(item => item.lines)
            .filter(item => item.pieces.some(piece => piece.runs.some(run => run.text.length > 0))).length;
          const text = texts[1 + preceding];
          expect(text.getAttribute("Justification")).toBe("Right");
          const after = line.pieces[1]?.runs ?? [];
          const width = after.reduce((sum, run) => sum + measureTextRun(run.text, { fontSizePx: style.fontSizePx, fontWeight: style.fontWeight, script: run.script }), 0);
          return Number(text.getAttribute("p")!.split(" ")[0]) - width * 0.75;
        });
      anchors.forEach(anchor => expect(Math.abs(anchor - column.decimalAnchorX! * 0.75)).toBeLessThan(0.5));
    }
    const imported = openChemDraftPayload(canonicalVisibleCdxml(result.contents));
    expect(imported.document).toBeDefined();
    expect(imported.warnings.map(warning => warning.code)).toEqual(["cdxml.external_subset_imported"]);
    const objects = imported.document!.pages[0].objects;
    expect(objects.filter(object => object.type === "text")).toHaveLength(count);
    expect(objects.filter(object => object.type === "graphic")).toHaveLength(3);
    expect(objects.some(object => object.type === "table")).toBe(false);
  });

  it("exports grid rules and warns about rotation", () => {
    const document = fixture();
    const table = document.pages[0].objects[0] as TableObject;
    table.tableStyle.preset = "grid";
    table.rotation = 30;
    const result = exportDocumentToCdxml(document);
    expect(xml(result.contents).querySelectorAll("group graphic")).toHaveLength(table.rows.length + table.columns.length + 2);
    expect(result.warnings.some(warning => warning.code === "cdxml.table_rotation_approximated" && warning.sourceObjectId === table.id)).toBe(true);
  });

  it("combines bold, italic and script face bits", () => {
    const document = fixture();
    const table = document.pages[0].objects[0] as TableObject;
    table.rows[1].cells[0] = { text: "x", spans: [{ text: "x", script: "superscript", style: { fontWeight: 700, fontStyle: "italic" } }] };
    const run = [...xml(exportDocumentToCdxml(document).contents).querySelectorAll("group t s")].find(item => item.textContent === "x");
    expect(run?.getAttribute("face")).toBe("67");
  });
});
