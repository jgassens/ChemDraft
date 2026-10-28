import { readFileSync, writeFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { nativeTextStyleFromObjectStyle, parseDocument, type TableObject } from "@chemdraft/chem-core";
import { planTableLayout } from "@chemdraft/layout-engine";
import {
  exportTableClipboardPayloads,
  exportTableToHtml,
  exportTableToRtf,
  exportTableToTsv
} from "./index";

const fixtureUrl = new URL("../../fixtures/tables/sharpless-reagent-table.json", import.meta.url);
const table = parseDocument(JSON.parse(readFileSync(fixtureUrl, "utf8"))).pages[0].objects[0] as TableObject;
const layout = planTableLayout(table);
const payloads = exportTableClipboardPayloads(table);
const inheritHtml = exportTableToHtml(table, { font: "inherit" });
const sides = ["top", "bottom", "left", "right"] as const;

function htmlDocument(html: string): Document {
  return new JSDOM(html).window.document;
}

function smallTable(texts: string[], align: TableObject["columns"][number]["align"] = "left"): TableObject {
  return {
    ...structuredClone(table), caption: undefined, footnotes: [], headerRowCount: 0,
    columns: [{ ...table.columns[0], align }],
    rows: texts.map((text, index) => ({ id: `row-${index}`, cells: [{ text, spans: [] }] }))
  };
}

function balancedRtf(rtf: string): void {
  let depth = 0;
  for (let index = 0; index < rtf.length; index++) {
    if (rtf[index] === "\\") {
      if (/[\\{}]/.test(rtf[index + 1])) index++;
    } else if (rtf[index] === "{") depth++;
    else if (rtf[index] === "}") depth--;
    expect(depth).toBeGreaterThanOrEqual(0);
  }
  expect(depth).toBe(0);
}

// Explicit golden helper: run UPDATE_TABLE_CLIPBOARD_GOLDENS=1 pnpm exec vitest run
// --configLoader runner packages/export-engine/src/tableClipboard.test.ts, then review the four files.
// Ordinary tests only read goldens; snapshot update flags never rewrite these fixtures.
function compareGolden(suffix: string, value: string): void {
  const url = new URL(`../../fixtures/tables/sharpless.table.${suffix}`, import.meta.url);
  if (process.env.UPDATE_TABLE_CLIPBOARD_GOLDENS === "1") writeFileSync(url, value, "utf8");
  expect(Buffer.from(value, "utf8")).toEqual(readFileSync(url));
}

describe("table clipboard payloads", () => {
  it("matches the exact Sharpless HTML, RTF, TSV and inherited-font HTML bytes", () => {
    compareGolden("html", payloads.html);
    compareGolden("rtf", payloads.rtf);
    compareGolden("tsv", payloads.tsv);
    compareGolden("inherit.html", inheritHtml);
    expect(payloads.warnings).toEqual([]);
  });

  it("contains only caption, table and footnotes within the required fragment markers", () => {
    expect(payloads.html).toMatch(/^<html xmlns:o="urn:schemas-microsoft-com:office:office"/);
    expect(payloads.html).toContain('xmlns:w="urn:schemas-microsoft-com:office:word"');
    expect(payloads.html).toContain('<head><meta charset="utf-8"></head><body><!--StartFragment-->');
    expect(payloads.html).toMatch(/<!--EndFragment--><\/body><\/html>$/);
    const fragment = payloads.html.split("<!--StartFragment-->")[1].split("<!--EndFragment-->")[0];
    const document = htmlDocument(fragment);
    expect([...document.body.childNodes].map(node => node.nodeName)).toEqual(["P", "TABLE", "P"]);
    expect(document.body.firstChild?.textContent).toBe(table.caption!.text);
    expect(document.body.lastChild?.textContent).toBe(table.footnotes[0].text);
    expect(fragment).toContain("</table><p");
    const bare = exportTableToHtml({ ...table, caption: undefined, footnotes: [] });
    expect(bare).toContain("</table><!--EndFragment-->");
    const notes = document.querySelectorAll("body > p");
    expect(notes[0].getAttribute("style")).toContain("margin:0 0 4pt 0");
    expect(notes[1].getAttribute("style")).toContain("margin:4pt 0 0 0");
    expect(notes[0].getAttribute("style")).toContain("font-size:12.15pt");
  });

  it("sets finite layout-derived widths and all four border sides without shading", () => {
    expect(payloads.html).not.toMatch(/width:100%|background|mso-shading/i);
    const document = htmlDocument(payloads.html);
    const element = document.querySelector("table")!;
    expect(element.getAttribute("width")).toBe(String(Math.round(layout.bodyBox.width)));
    expect(element.getAttribute("style")).toContain(`width:${layout.bodyBox.width * 0.75}pt`);
    expect(element.getAttribute("style")).toContain("mso-padding-alt:1.5pt 4.5pt 1.5pt 4.5pt");
    for (const [index, cell] of [...document.querySelectorAll("td")].entries()) {
      const column = layout.columns[index % table.columns.length];
      expect(cell.getAttribute("width")).toBe(String(Math.round(column.width)));
      expect(cell.getAttribute("style")).toContain(`width:${column.width * 0.75}pt`);
      expect(cell.children).toHaveLength(1);
      expect(cell.firstElementChild?.tagName).toBe("P");
      for (const side of sides) expect(cell.getAttribute("style")).toContain(`border-${side}:`);
    }
  });

  it("puts exactly the three rules on the first, last header and last row cells", () => {
    const document = htmlDocument(payloads.html);
    const rows = [...document.querySelectorAll("tr")];
    expect(document.querySelectorAll("thead tr")).toHaveLength(1);
    expect(rows[0].getAttribute("style")).toBe("mso-yfti-firstrow:yes");
    rows.forEach((row, index) => {
      for (const cell of row.querySelectorAll("td")) {
        expect(cell.getAttribute("valign")).toBe(index === 0 ? "bottom" : null);
        for (const side of sides) {
          const width = side === "top" && index === 0 ? 1
            : side === "bottom" && index === 0 ? 0.5
            : side === "bottom" && index === rows.length - 1 ? 1 : 0;
          const rule = width ? `solid windowtext ${width}pt` : "none";
          expect(cell.getAttribute("style")).toContain(`border-${side}:${rule}`);
          expect(cell.getAttribute("style")!.includes(`mso-border-${side}-alt:`)).toBe(width > 0);
        }
      }
    });
    const rowsRtf = payloads.rtf.split("\\trowd").slice(1);
    rowsRtf.forEach((row, index) => {
      expect([...row.matchAll(/\\clbrdrt\b/g)]).toHaveLength(index === 0 ? 7 : 0);
      expect([...row.matchAll(/\\clbrdrb\b/g)]).toHaveLength(index === 0 || index === 5 ? 7 : 0);
      expect(row).not.toMatch(/\\clbrdr[lr]\b/);
    });
  });

  it("uses the block insets and precision to reproduce layout placement in HTML and RTF", () => {
    const rows = [...htmlDocument(payloads.html).querySelectorAll("tr")];
    const rtfRows = payloads.rtf.split("\\trowd").slice(1);
    rows.forEach((row, index) => {
      const cells = [...row.querySelectorAll("td")];
      const rtfDefinitions = rtfRows[index].split("\\pard")[0].split(/\\cellx\d+/);
      const rtfCells = rtfRows[index].split("\\pard\\plain\\intbl").slice(1);
      for (let column = 1; column < cells.length; column++) {
        const paragraph = cells[column].querySelector("p")!;
        const style = paragraph.getAttribute("style")!;
        const cellStyle = cells[column].getAttribute("style")!;
        const block = layout.columns[column].decimalBlock!;
        if (index === 0) {
          expect(style).toContain("text-align:center");
          expect(style).not.toContain("tab-stops");
          expect(cellStyle).not.toMatch(/padding-(left|right)/);
          expect(rtfDefinitions[column]).not.toContain("\\clpad");
          expect(rtfCells[column]).toMatch(/^\\qc/);
        }
        else if (column === 1) {
          const padding = table.tableStyle.cellPaddingPx.x + block.insetRight;
          expect(style).toContain("text-align:right");
          expect(style).not.toContain("tab-stops");
          expect(cellStyle).toContain(`padding-right:${Number((padding * 0.75).toFixed(4))}pt`);
          expect(cellStyle).not.toContain("padding-left");
          expect(rtfDefinitions[column]).toContain(`\\clpadr${Math.round(padding * 15)}\\clpadfr3`);
          expect(rtfCells[column]).toMatch(/^\\qr/);
          expect(rtfCells[column]).not.toContain("\\tqdec");
          expect(rtfCells[column]).not.toContain("\\tab ");
        } else {
          const padding = table.tableStyle.cellPaddingPx.x + block.insetLeft;
          const offsetPt = Number((block.preWidth * 0.75).toFixed(4));
          expect(style).toContain(`text-align:left;tab-stops:decimal ${offsetPt}pt`);
          expect(cellStyle).toContain(`padding-left:${Number((padding * 0.75).toFixed(4))}pt`);
          expect(cellStyle).not.toContain("padding-right");
          expect(rtfDefinitions[column]).toContain(`\\clpadl${Math.round(padding * 15)}\\clpadfl3`);
          expect(rtfCells[column]).toMatch(/^\\ql/);
          expect(rtfCells[column]).toContain(`\\tqdec\\tx${Math.round(block.preWidth * 15)}`);
          expect(rtfCells[column].match(/\\tab /g)).toHaveLength(1);
        }
        expect(paragraph.textContent).toBe(table.rows[index].cells[column].text);
      }
    });
    expect(rows[1].children[1].getAttribute("style")).toContain("mso-number-format:'0\\.00'");
    expect(rows[5].children[6].getAttribute("style")).toContain("mso-number-format:'0'");
    expect(rows[4].children[2].getAttribute("style")).not.toContain("mso-number-format");
    for (const html of [payloads.html, inheritHtml]) {
      expect(html).not.toMatch(/mso-tab-count|&#9;|\t/);
    }
  });

  it("preserves scripts in cells and footnotes", () => {
    const document = htmlDocument(payloads.html);
    expect([...document.querySelectorAll("td sub")].map(span => span.textContent)).toEqual(["4", "2", "2"]);
    expect(document.querySelector("td sup")?.textContent).toBe("a");
    expect(document.querySelector("body > p:last-child sup")?.textContent).toBe("a");
    expect(payloads.rtf).toContain("{\\sub 4}");
    expect(payloads.rtf).toContain("{\\super a}");
    expect(payloads.tsv).toContain("Ti(OiPr)4");
    expect(payloads.tsv).toContain("CH2Cl2");
    expect(payloads.tsv).not.toContain(table.caption!.text);
    expect(payloads.tsv).not.toContain(table.footnotes[0].text);
  });

  it("writes ASCII RTF with balanced groups, one row per table row and cumulative cell edges", () => {
    expect(payloads.rtf).toMatch(/^[\x00-\x7f]*$/);
    balancedRtf(payloads.rtf);
    expect(payloads.rtf).toContain("\\u8212\\'97");
    expect([...payloads.rtf.matchAll(/\\row\b/g)]).toHaveLength(table.rows.length);
    expect([...payloads.rtf.matchAll(/\\lastrow\b/g)]).toHaveLength(1);
    const expected = layout.columns.map(column =>
      Math.round((column.x + column.width - layout.bodyBox.x) * 15));
    for (const row of payloads.rtf.split("\\trowd").slice(1)) {
      const edges = [...row.matchAll(/\\cellx(\d+)/g)].map(match => Number(match[1]));
      expect(edges).toEqual(expected);
      expect(edges.every((edge, index) => edge > (edges[index - 1] ?? 0))).toBe(true);
      expect(row).toContain("\\trgaph90\\trleft0\\trpaddl90\\trpaddr90\\trpaddt30\\trpaddb30");
    }
    expect(payloads.rtf).toContain("\\pard\\plain\\sa80\\sb0\\f0\\fs24");
    expect(payloads.rtf).toContain("\\pard\\plain\\sa0\\sb80\\f0\\fs24");
  });

  it("escapes RTF controls, cp1252 fallbacks and each UTF-16 surrogate without losing HTML text", () => {
    const value = "\\{x} é — € μ 😀 & < > \" '";
    const input = smallTable([value]);
    const rtf = exportTableToRtf(input);
    expect(rtf).toMatch(/^[\x00-\x7f]*$/);
    balancedRtf(rtf);
    expect(rtf).toContain("\\\\\\{x\\}");
    expect(rtf).toContain("\\u233\\'e9");
    expect(rtf).toContain("\\u8364\\'80");
    expect(rtf).toContain("\\u956?");
    expect(rtf).toContain("\\u-10179?\\u-8704?");
    expect(htmlDocument(exportTableToHtml(input)).querySelector("td")?.textContent).toBe(value);
  });

  it("quotes TSV cells containing tabs, newlines or quotes without adding a trailing newline", () => {
    const input = smallTable(["simple", "a\tb", "two\nlines", 'say "hello"', "last"]);
    expect(exportTableToTsv(input)).toBe('simple\n"a\tb"\n"two\nlines"\n"say ""hello"""\nlast');
    expect(exportTableToTsv(smallTable([""]))).toBe("");
    expect(exportTableToTsv(smallTable(["a", "b"]))).toBe("a\nb");
    expect(payloads.tsv.endsWith("\n")).toBe(false);
  });

  it("draws all four grid borders on every cell", () => {
    const input = { ...table, tableStyle: { ...table.tableStyle, preset: "grid" as const } };
    const html = exportTableToHtml(input);
    for (const cell of htmlDocument(html).querySelectorAll("td")) {
      for (const side of sides) {
        expect(cell.getAttribute("style")).toContain(`border-${side}:solid windowtext 0.5pt`);
        expect(cell.getAttribute("style")).toContain(`mso-border-${side}-alt:solid windowtext 0.5pt`);
      }
    }
    const rtf = exportTableToRtf(input);
    for (const side of ["t", "b", "l", "r"]) {
      expect([...rtf.matchAll(new RegExp(`\\\\clbrdr${side}\\b`, "g"))]).toHaveLength(42);
    }
    expect(rtf).toContain("\\brdrw10\\brdrcf0");
    expect(html).not.toMatch(/background|mso-shading/);
  });

  it("uses no borders for zero-width rules and treats unknown presets as three-line", () => {
    const unknown = { ...table, tableStyle: { ...table.tableStyle, preset: "unknown" as const } };
    expect(exportTableToHtml(unknown)).toBe(payloads.html);
    expect(exportTableToRtf(unknown)).toBe(payloads.rtf);
    const input = {
      ...table,
      tableStyle: { ...table.tableStyle, topRulePt: 0, headerRulePt: 0, bottomRulePt: 0 }
    };
    expect(exportTableToRtf(input)).not.toContain("\\clbrdr");
    expect(exportTableToHtml(input)).not.toContain("solid windowtext");
  });

  it("respects header bold on/off and authored bold, italic and colour", () => {
    const off = htmlDocument(payloads.html);
    expect(off.querySelectorAll("thead b")).toHaveLength(0);
    const input = structuredClone(table);
    input.tableStyle.headerBold = true;
    expect(htmlDocument(exportTableToHtml(input)).querySelectorAll("thead td b")).toHaveLength(7);
    expect(exportTableToRtf(input).split("\\row")[0].match(/\{\\b /g)).toHaveLength(8);
    const styled = smallTable(["styled"]);
    styled.rows[0].cells[0].spans = [{
      text: "styled", script: "normal", style: { fontWeight: 600, fontStyle: "italic", color: "#12abef" }
    }];
    const document = htmlDocument(exportTableToHtml(styled));
    expect(document.querySelector("b i span")?.getAttribute("style")).toBe("color:#12abef");
    expect(exportTableToRtf(styled)).toContain("\\red18\\green171\\blue239;");
    expect(exportTableToRtf(styled)).toContain("{\\b\\i\\cf1 styled}");
  });

  it("omits default and unset colours and merges adjacent runs across decimal pieces", () => {
    expect(payloads.html).not.toMatch(/#111111|color:/);
    expect(inheritHtml).not.toMatch(/#111111|color:/);
    expect(payloads.rtf).not.toMatch(/#111111|\\cf\d|\\red17\\green17\\blue17/);
    expect(payloads.rtf).toContain("{\\colortbl;}");
    expect(payloads.html).toContain('>0.854</p>');
    expect(payloads.rtf).toContain("\\tab 0.854\\cell");

    const input = smallTable(["0.854", "red", "default"], "decimal");
    input.style = { ...input.style, color: "#ff0000" };
    input.rows[0].cells[0].spans = [
      { text: "0", script: "normal", style: {} },
      { text: ".8", script: "normal", style: { color: "#111111" } },
      { text: "54", script: "normal", style: { color: "#111" } }
    ];
    input.rows[1].cells[0].spans = [
      { text: "r", script: "normal", style: { color: "#f00" } },
      { text: "ed", script: "normal", style: { color: "#FF0000" } }
    ];
    const html = exportTableToHtml(input);
    const rtf = exportTableToRtf(input);
    const cells = [...htmlDocument(html).querySelectorAll("td p")];
    expect(cells[0].innerHTML).toBe("0.854");
    expect(cells[1].innerHTML).toBe('<span style="color:#ff0000">red</span>');
    expect(cells[2].innerHTML).toBe("default");
    expect(rtf).toContain("{\\colortbl;\\red255\\green0\\blue0;}");
    expect(rtf).toContain("\\tab 0.854\\cell");
    expect(rtf).toContain("\\tab {\\cf1 red}\\cell");
    expect(rtf).toContain("\\tab default\\cell");
    expect(rtf).not.toContain("\\brdrcf1");
    expect(html).not.toContain("#111111");
    expect(rtf).not.toContain("\\red17\\green17\\blue17");
  });

  it.each([["12.34", "5.67"], ["12.3", "5.678", "—", "86"]])(
    "uses fixed-column block insets for %j", (...texts) => {
      const input = smallTable(texts, "decimal");
      input.columns[0].width = { mode: "fixed", px: 200 };
      const block = planTableLayout(input).columns[0].decimalBlock!;
      const rightAligned = texts.length === 2;
      const side = rightAligned ? "right" : "left";
      const inset = rightAligned ? block.insetRight : block.insetLeft;
      const padding = table.tableStyle.cellPaddingPx.x + inset;
      expect(inset).toBeGreaterThan(0);
      const html = htmlDocument(exportTableToHtml(input));
      for (const cell of html.querySelectorAll("td")) {
        expect(cell.getAttribute("style"))
          .toContain(`padding-${side}:${Number((padding * 0.75).toFixed(4))}pt`);
        expect(cell.querySelector("p")?.getAttribute("style")).toContain(`text-align:${side}`);
      }
      const rtf = exportTableToRtf(input);
      for (const row of rtf.split("\\trowd").slice(1)) {
        expect(row).toContain(`\\clpad${side[0]}${Math.round(padding * 15)}\\clpadf${side[0]}3`);
      }
    }
  );

  it("omits all font families and sizes in inherit mode while preserving layout and rich text", () => {
    const inherited = exportTableClipboardPayloads(table, { font: "inherit" });
    expect(inherited.html).not.toMatch(/font-family|font-size/);
    expect(inherited.rtf).not.toMatch(/\\fs\d|\\fonttbl|\\f0|Arial|Helvetica/);
    expect(inherited.rtf).toContain("{\\sub");
    expect(inherited.tsv).toBe(payloads.tsv);
    const document = htmlDocument(payloads.html);
    const font = nativeTextStyleFromObjectStyle(table.style);
    expect(document.querySelector("td p")!.getAttribute("style"))
      .toContain(`font-size:${font.fontSizePx * 0.75}pt`);
    expect(document.querySelector("td p")!.getAttribute("style")).toContain("font-family:'Arial',sans-serif");
    const serif = { ...table, style: { fontFamily: "Times New Roman" } };
    expect(exportTableToHtml(serif)).toContain("serif;font-size");
    expect(exportTableToRtf(serif)).toContain("\\froman\\fcharset0 Times New Roman;");
  });

  it.each([0, 2, 6])("supports %i header rows with the separator only below the last header", count => {
    const input = { ...table, headerRowCount: count };
    const document = htmlDocument(exportTableToHtml(input));
    expect(document.querySelectorAll("thead tr")).toHaveLength(count);
    expect(document.querySelectorAll("tbody tr")).toHaveLength(table.rows.length - count);
    const rows = [...document.querySelectorAll("tr")];
    rows.forEach((row, index) => {
      for (const cell of row.querySelectorAll("td")) {
        const bottom = index === rows.length - 1 ? "1pt"
          : index === count - 1 ? "0.5pt" : undefined;
        expect(cell.getAttribute("style")).toContain(bottom
          ? `border-bottom:solid windowtext ${bottom}` : "border-bottom:none");
        expect(cell.getAttribute("style")).toContain(index === 0
          ? "border-top:solid windowtext 1pt" : "border-top:none");
      }
    });
    expect([...exportTableToRtf(input).matchAll(/\\trhdr\b/g)]).toHaveLength(count);
  });

  it("keeps multiline cells within one paragraph and degrades unknown alignment to left", () => {
    const input = smallTable(["a\nb"], "unknown");
    const cell = htmlDocument(exportTableToHtml(input)).querySelector("td")!;
    expect(cell.querySelectorAll("p")).toHaveLength(1);
    expect(cell.querySelectorAll("br")).toHaveLength(1);
    expect(cell.querySelector("p")!.getAttribute("style")).toContain("text-align:left");
    expect(exportTableToRtf(input)).toContain("a\\line b");
    const decimal = smallTable(["1.2\n3.45"], "decimal");
    const html = htmlDocument(exportTableToHtml(decimal));
    expect(html.querySelectorAll("td span")).toHaveLength(0);
    expect(html.querySelector("td p")?.textContent).toBe("1.23.45");
    expect(exportTableToRtf(decimal)).toContain("\\line \\tab ");
  });

  it("warns for unrotated copying and natural-width overflow without mutating its input", () => {
    const input = smallTable(["a much wider cell"]);
    input.rotation = 30;
    input.columns[0].width = { mode: "fixed", px: 12 };
    const before = JSON.stringify(input);
    const output = exportTableClipboardPayloads(input);
    expect(output.warnings).toEqual([
      "A rotated table is copied unrotated.",
      'Fixed-width column "col-material" is narrower than its content.'
    ]);
    expect(output.html).toBe(exportTableToHtml({ ...input, rotation: 0 }));
    expect(JSON.stringify(input)).toBe(before);
    expect(exportTableClipboardPayloads(structuredClone(input))).toEqual(output);
    input.columns[0].width = { mode: "fixed", px: 2000 };
    expect(exportTableClipboardPayloads(input).warnings).toHaveLength(1);
  });
});
