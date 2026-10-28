import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nativeTextStyleFromObjectStyle, parseDocument, type TableObject } from "@chemdraft/chem-core";
import { planPageSvgRender, type PageSvgElementFragment } from "./index";
import { planTableLayout, planTableObjectSvg, tableVisualBoundsForArrangement } from "./table";
import { measureTextRun } from "./textMetrics";
import { elementFragments } from "./testing";

const document = parseDocument(JSON.parse(readFileSync(new URL("../../fixtures/tables/sharpless-reagent-table.json", import.meta.url), "utf8")));
const table = document.pages[0].objects[0] as TableObject;
const style = nativeTextStyleFromObjectStyle(table.style);

function smallTable(align: TableObject["columns"][number]["align"], texts: string[], fixed?: number): TableObject {
  return { ...table, caption: undefined, footnotes: [], headerRowCount: 0,
    columns: [{ ...table.columns[0], align, width: fixed === undefined ? { mode: "auto" } : { mode: "fixed", px: fixed } }],
    rows: texts.map((text, index) => ({ id: `r${index}`, cells: [{ text, spans: [] }] })) };
}

describe("table layout and SVG", () => {
  it("plans stable positive column widths and row heights without changing the document", () => {
    const before = JSON.stringify(table);
    const layout = planTableLayout(table);
    expect(layout.columns.map(column => column.width)).toMatchInlineSnapshot(`
      [
        109,
        109,
        134,
        64.5,
        69.5,
        85,
        119.5,
      ]
    `);
    expect(layout.columns.every(column => column.width > 0)).toBe(true);
    expect(layout.rows.every(row => row.height === style.fontSizePx * style.lineHeight + 4)).toBe(true);
    expect(planTableLayout(structuredClone(table))).toEqual(layout);
    expect(JSON.stringify(table)).toBe(before);
    expect(layout.origin).toEqual({ x: table.x, y: table.y });
    expect(layout.bodyBox.y).toBeCloseTo(table.y + style.fontSizePx * 0.9 * style.lineHeight + 4);
    expect(layout.footnoteBoxes[0].y).toBeCloseTo(layout.bodyBox.y + layout.bodyBox.height + 4);
  });

  it("meets every decimal piece at the column anchor and centers the headers", () => {
    const layout = planTableLayout(table);
    for (const column of layout.columns.slice(1)) {
      const block = column.decimalBlock!;
      const innerLeft = column.x + table.tableStyle.cellPaddingPx.x;
      const innerWidth = column.width - 2 * table.tableStyle.cellPaddingPx.x;
      const blockLeft = column.decimalAnchorX! - block.preWidth;
      const blockRight = column.decimalAnchorX! + block.postWidth;
      expect(Math.abs((blockLeft + blockRight) / 2 - (innerLeft + innerWidth / 2))).toBeLessThan(0.01);
      expect(blockLeft - innerLeft).toBeCloseTo(block.insetLeft);
      expect(innerLeft + innerWidth - blockRight).toBeCloseTo(block.insetRight);
    }
    expect(layout.columns[0].decimalBlock).toBeUndefined();
    for (const cell of layout.cells.filter(cell => cell.columnIndex > 0)) {
      const column = layout.columns[cell.columnIndex];
      const pieces = cell.lines[0].pieces;
      if (cell.rowIndex === 0) {
        expect(pieces).toHaveLength(1);
        expect(pieces[0].anchor).toBe("middle");
        expect(pieces[0].x).toBe(column.x + column.width / 2);
      } else {
        expect(pieces.every(piece => piece.x === column.decimalAnchorX)).toBe(true);
        expect(pieces[0].anchor).toBe("end");
        if (pieces.length > 1) {
          expect(pieces[1].anchor).toBe("start");
          expect(pieces[1].runs[0].text.startsWith(".")).toBe(true);
        }
        if (["86", "—"].includes(table.rows[cell.rowIndex].cells[cell.columnIndex].text)) expect(pieces).toHaveLength(1);
      }
    }
    expect(layout.cells[14].lines[0].pieces[0].runs.some(run => run.script === "subscript")).toBe(true);
  });

  it("centers auto and fixed decimal blocks and starts overflowing blocks at the inner left", () => {
    const input = smallTable("decimal", ["12.3", "4.567", "86", "—", ".5", "5.", "word.point"]);
    const pre = measureTextRun("word.point", { fontSizePx: style.fontSizePx });
    const post = measureTextRun(".567", { fontSizePx: style.fontSizePx });
    const auto = planTableLayout(input);
    expect(auto.columns[0].width).toBe(Math.ceil(((pre + post) * 1.04 + 12) * 2) / 2);
    for (const layout of [auto, planTableLayout({ ...input,
      columns: [{ ...input.columns[0], width: { mode: "fixed", px: 200 } }] })]) {
      const column = layout.columns[0];
      const inset = (column.width - 12 - pre - post) / 2;
      expect(column.decimalBlock).toEqual({ insetLeft: inset, insetRight: inset,
        preWidth: pre, postWidth: post });
      expect(column.decimalAnchorX).toBeCloseTo(table.x + 6 + inset + pre);
      const center = column.decimalAnchorX! + (post - pre) / 2;
      expect(Math.abs(center - (column.x + column.width / 2))).toBeLessThan(0.01);
    }
    const narrow = planTableLayout({ ...input,
      columns: [{ ...input.columns[0], width: { mode: "fixed", px: 40 } }] });
    expect(narrow.columns[0].width).toBe(40);
    expect(narrow.columns[0].decimalAnchorX).toBe(table.x + 6 + pre);
    expect(narrow.columns[0].decimalBlock).toEqual({ insetLeft: 0, insetRight: 0,
      preWidth: pre, postWidth: post });
    expect(auto.cells[6].lines[0].pieces).toHaveLength(1);
    expect(auto.cells[4].lines[0].pieces[0].runs).toEqual([]);
  });

  it("aligns each newline independently, keeps fixed-column overflow, and degrades unknown alignment", () => {
    for (const [align, anchor] of [["left", "start"], ["unknown", "start"], ["center", "middle"], ["right", "end"]] as const) {
      const input = smallTable(align, ["wide text\ni"], 20);
      const layout = planTableLayout(input);
      const lines = layout.cells[0].lines;
      expect(lines).toHaveLength(2);
      expect(lines.map(line => line.pieces[0].anchor)).toEqual([anchor, anchor]);
      expect(lines[1].baselineY - lines[0].baselineY).toBeCloseTo(style.fontSizePx * style.lineHeight);
      expect(layout.rows[0].height).toBe(2 * style.fontSizePx * style.lineHeight + 4);
      expect(layout.columns[0].width).toBe(20);
      expect(tableVisualBoundsForArrangement(input).width).toBeGreaterThan(20);
    }
  });

  it("falls back from stale spans, measures bold headers, and splits rich runs at a decimal", () => {
    const input = smallTable("decimal", ["head", "12.34"]);
    input.headerRowCount = 1;
    input.tableStyle = { ...input.tableStyle, headerBold: true };
    input.rows[0].cells[0].spans = [{ text: "stale", script: "normal", style: {} }];
    input.rows[1].cells[0].spans = [{ text: "12.3", script: "normal", style: { color: "red", fontWeight: 700 } },
      { text: "4", script: "subscript", style: {} }];
    const layout = planTableLayout(input);
    expect(layout.cells[0].lines[0].pieces[0].runs).toEqual([{ text: "head", script: "normal", style: { fontWeight: 700 } }]);
    expect(layout.cells[1].lines[0].pieces[1].runs.map(run => run.text)).toEqual([".3", "4"]);
    const headerWidth = measureTextRun("head", { fontSizePx: style.fontSizePx, fontWeight: 700 });
    expect(layout.columns[0].width).toBeGreaterThanOrEqual(headerWidth * 1.04 + 12);
  });

  it("draws the three horizontal rules in CSS pixels, including unknown presets", () => {
    for (const preset of ["three-line", "unknown"] as const) {
      const layout = planTableLayout({ ...table, tableStyle: { ...table.tableStyle, preset } });
      expect(layout.rules).toHaveLength(3);
      expect(layout.rules.map(rule => rule.widthPx)).toEqual([4 / 3, 2 / 3, 4 / 3]);
      expect(layout.rules.every(rule => rule.x1 === table.x && rule.x2 === table.x + layout.bodyBox.width && rule.y1 === rule.y2)).toBe(true);
    }
    expect(planTableLayout({ ...table, headerRowCount: 0 }).rules).toHaveLength(2);
  });

  it("keeps captions and multiple multiline footnotes outside the body without resizing columns", () => {
    const input = smallTable("left", ["i"]);
    const withoutNotes = planTableLayout(input);
    input.caption = { text: "a long caption\nsecond line", spans: [] };
    input.footnotes = [{ text: "first\nsecond", spans: [] }, { text: "last", spans: [] }];
    const layout = planTableLayout(input);
    expect(layout.columns).toEqual(withoutNotes.columns);
    const advance = style.fontSizePx * 0.9 * style.lineHeight;
    expect(layout.captionBox!.height).toBe(2 * advance);
    expect(layout.bodyBox.y).toBe(table.y + 2 * advance + 4);
    expect(layout.footnoteBoxes[1].y).toBe(layout.footnoteBoxes[0].y + 2 * advance + 4);
    expect(layout.width).toBeGreaterThan(layout.bodyBox.width);
    expect(layout.height).toBe(layout.footnoteBoxes[1].y + advance - table.y);
  });

  it("draws grid edges once, including the outer edges", () => {
    const layout = planTableLayout({ ...table, tableStyle: { ...table.tableStyle, preset: "grid" } });
    expect(layout.rules).toHaveLength(table.rows.length + table.columns.length + 2);
    expect(new Set(layout.rules.map(rule => JSON.stringify(rule))).size).toBe(layout.rules.length);
    expect(layout.rules.every(rule => rule.widthPx === 2 / 3)).toBe(true);
    expect(layout.rules.filter(rule => rule.y1 === rule.y2)).toHaveLength(table.rows.length + 1);
    expect(layout.rules.filter(rule => rule.x1 === rule.x2)).toHaveLength(table.columns.length + 1);
  });

  it("renders through the page plan with rich scripts, unique keys, and no filled rules or out-of-bounds elements", () => {
    const layout = planTableLayout(table);
    const svg = planTableObjectSvg(table, 0);
    const pagePlan = planPageSvgRender(document.pages[0]);
    expect(pagePlan.warnings).toEqual([]);
    expect(pagePlan.fragments.filter(fragment => fragment.tag === "line")).toHaveLength(3);
    const elements = elementFragments(svg);
    expect(new Set(elements.map(element => element.key)).size).toBe(elements.length);
    expect(new Set(elements.map(element => element.attrs.id)).size).toBe(elements.length);
    expect(elements.filter(element => element.tag === "line").every(element => element.attrs.fill === "none")).toBe(true);
    expect(elements.some(element => element.attrs["baseline-shift"] === "sub" && element.attrs["font-size"] === "72%")).toBe(true);
    expect(elements.some(element => element.attrs["baseline-shift"] === "super" && element.attrs["font-size"] === "72%")).toBe(true);
    for (const element of elements) {
      for (const key of ["x", "x1", "x2"]) if (typeof element.attrs[key] === "number") {
        expect(element.attrs[key]).toBeGreaterThanOrEqual(table.x);
        expect(element.attrs[key]).toBeLessThanOrEqual(table.x + layout.width);
      }
      for (const key of ["y", "y1", "y2"]) if (typeof element.attrs[key] === "number") {
        expect(element.attrs[key]).toBeGreaterThanOrEqual(table.y);
        expect(element.attrs[key]).toBeLessThanOrEqual(table.y + layout.height);
      }
    }
    for (const cell of layout.cells) for (const line of cell.lines) for (const piece of line.pieces) {
      const width = piece.runs.reduce((sum, run) => sum + measureTextRun(run.text, {
        fontSizePx: style.fontSizePx, script: run.script
      }), 0);
      const left = piece.x - (piece.anchor === "end" ? width : piece.anchor === "middle" ? width / 2 : 0);
      expect(left).toBeGreaterThanOrEqual(table.x);
      expect(left + width).toBeLessThanOrEqual(table.x + layout.width);
    }
    expect(planTableObjectSvg(structuredClone(table), 0)).toEqual(svg);
  });

  it("preserves table and span styling and keeps element ids unique for ambiguous row/column names", () => {
    const input = smallTable("left", ["head", "12"]);
    input.style = { fontFamily: "Helvetica", fontSizePx: 20, fontWeight: 500, color: "#123456", lineHeight: 1.5 };
    input.columns = [input.columns[0], { ...input.columns[0], id: "b-c" }];
    input.columns[0].id = "c";
    input.rows[0].id = "a-b";
    input.rows[1].id = "a";
    input.rows.forEach(row => row.cells.push(row.cells[0]));
    input.rows[1].cells[0] = { text: "12", spans: [
      { text: "1", script: "normal", style: { fontWeight: 700, fontStyle: "italic", color: "#abcdef", fontSizePx: 15 } },
      { text: "2", script: "subscript", style: {} }
    ] };
    const elements = elementFragments(planTableObjectSvg(input, 0));
    expect(new Set(elements.map(element => element.attrs.id)).size).toBe(elements.length);
    const text = elements.find(element => element.tag === "text")!;
    expect(text.attrs).toMatchObject({ "font-family": "Helvetica", "font-size": 20, "font-weight": 500, fill: "#123456" });
    expect(elements.some(element => element.tag === "tspan" && element.attrs["font-weight"] === 700 &&
      element.attrs["font-style"] === "italic" && element.attrs.fill === "#abcdef" && element.attrs["font-size"] === 15)).toBe(true);
    expect(planTableLayout(input).rows[0].height).toBe(20 * 1.5 + 4);
  });

  it("uses the shared rotation pivot and includes captions and footnotes in visual bounds", () => {
    const input = { ...table, rotation: 90 };
    const unrotated = tableVisualBoundsForArrangement(table);
    const rotated = tableVisualBoundsForArrangement(input);
    expect(rotated.width).toBeCloseTo(unrotated.height);
    expect(rotated.height).toBeCloseTo(unrotated.width);
    expect(planTableObjectSvg(input, 2).attrs.transform).toBe(`rotate(90 ${table.x + table.width / 2} ${table.y + table.height / 2})`);
    expect(unrotated.y).toBeLessThanOrEqual(table.y);
    expect(unrotated.y + unrotated.height).toBeGreaterThanOrEqual(table.y + planTableLayout(table).height);
    expect((planPageSvgRender({ ...document.pages[0], objects: [input] }).fragments[0] as PageSvgElementFragment).attrs["data-object-id"]).toBe(table.id);
  });
});
