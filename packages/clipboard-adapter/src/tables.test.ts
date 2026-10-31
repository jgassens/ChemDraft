// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TABLE_LIMITS } from "@chemdraft/chem-core";
import { CLIPBOARD_TABLE_LIMITS } from "./tables";
import { buildTableObject, TableSpecSchema } from "@chemdraft/document-workflow-core";
import {
  readClipboardHtmlTable,
  readClipboardTsvTable,
  smilesListDecision,
  type ClipboardReadPayload,
  type ClipboardTableResult
} from "./index";

const parseHtml = (html: string): Document => new DOMParser().parseFromString(html, "text/html");

function fixture(name: string): string {
  return readFileSync(resolve(process.cwd(), "packages/fixtures/clipboard-tables", name), "utf8");
}

function htmlPayload(text: string, type = "text/html") {
  return { types: [type], textItems: [{ type, text }] };
}

function cfHtml(html: string): string {
  const header = (offsets: number[]) =>
    "Version:0.9\r\n" +
    ["StartHTML", "EndHTML", "StartFragment", "EndFragment"]
      .map((name, index) => `${name}:${String(offsets[index]).padStart(10, "0")}\r\n`)
      .join("");
  const start = header([0, 0, 0, 0]).length;
  const fragmentStart = html.indexOf("<!--StartFragment-->") + "<!--StartFragment-->".length;
  const fragmentEnd = html.indexOf("<!--EndFragment-->");
  const offset = (index: number) => start + Buffer.byteLength(html.slice(0, index), "utf8");
  return header([start, offset(html.length), offset(fragmentStart), offset(fragmentEnd)]) + html;
}

function readHtml(text: string, type?: string): ClipboardTableResult | undefined {
  return readClipboardHtmlTable(htmlPayload(text, type), parseHtml);
}

function readHtmlAndTsv(html: string, tsv: string): ClipboardTableResult | undefined {
  const payload = htmlPayload(html);
  payload.types.push("text/plain");
  payload.textItems.push({ type: "text/plain", text: tsv });
  return readClipboardHtmlTable(payload, parseHtml);
}

function table(body: string): string {
  return `<html><body><table>${body}</table></body></html>`;
}

function expectOk(result: ClipboardTableResult | undefined) {
  expect(result?.ok).toBe(true);
  if (!result?.ok) {
    throw new Error("expected a table");
  }
  return result;
}

function expectRefusal(result: ClipboardTableResult | undefined, reason: RegExp) {
  expect(result).toEqual({ ok: false, reason: expect.stringMatching(reason) });
}

function bold(text: string) {
  return { text, spans: [{ text, bold: true }] };
}

const withHead = "<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1.5</td></tr></tbody></table>";
const left = { align: "left" } as const;
const right = { align: "right" } as const;

describe("limits", () => {
  it("match the native table limits", () => {
    expect(TABLE_LIMITS).toMatchObject(CLIPBOARD_TABLE_LIMITS);
  });
});

describe("HTML table fixtures", () => {
  it.each(["windows-word.html", "windows-excel.html"])("detects one header in Windows CF_HTML (%s)", name => {
    const result = expectOk(readHtml(cfHtml(fixture(name)), "HTML Format"));
    expect(result.spec.headerRows).toEqual([[
      "Material", "MW (g/mol)", "Density (g/mL)", "Equiv.", "mmol", "Mass (g)", "Volume (mL)"
    ]]);
    expect(result.spec.rows).toHaveLength(2);
    let id = 0;
    expect(buildTableObject(result.spec, { id: "table", x: 0, y: 0, newId: () => `win-${++id}` }).object.headerRowCount).toBe(1);
    expect(result.warnings).toEqual([]);
  });

  it("reads the Excel-like table: plain cells, inferred header and decimal body columns", () => {
    const result = expectOk(readHtml(fixture("excel-like.html")));
    expect(result.source).toBe("html");
    expect(result.warnings).toEqual([]);
    expect(result.spec).toEqual({
      columns: [left, ...Array.from({ length: 6 }, () => ({ align: "decimal" }))],
      // excel-like.html starts with Material and six property labels above numeric columns.
      headerRows: [["Material", "MW (g/mol)", "Density (g/mL)", "Equiv.", "mmol", "Mass (g)", "Volume (mL)"]],
      rows: [
        ["allyl alcohol", "58.08", "0.854", "1.00", "17.22", "1.00", "1.17"],
        ["Ti(OiPr)4", "284.22", "0.96", "0.05", "0.861", "0.245", "0.255"],
        ["(+)-DET", "206.19", "1.204", "0.06", "1.033", "0.213", "0.177"],
        ["TBHP", "90.12", "—", "2.0", "34.44", "—", "6.26"],
        ["CH2Cl2", "84.93", "1.33", "—", "—", "—", "86"]
      ]
    });
  });

  it.each([false, true])("reads Excel markers inside the table (CF_HTML: %s)", (wrapped) => {
    const html = fixture("excel-markers-inside-table.html");
    const result = expectOk(readHtml(wrapped ? cfHtml(html) : html, wrapped ? "HTML Format" : "text/html"));
    // excel-markers-inside-table.html has the same labels above numeric reagent properties.
    expect(result).toEqual(expectOk(readHtml(fixture("excel-like.html"))));
  });

  const wordSpec = {
    columns: [left, { align: "decimal" }, { align: "decimal" }],
    // word-like.html starts with Material, MW and Density labels above numeric property columns.
    headerRows: [[bold("Material"), bold("MW (g/mol)"), bold("Density (g/mL)")]],
    rows: [
      ["allyl alcohol", "58.08", "0.854"],
      [
        { text: "Ti(OiPr)4", spans: [{ text: "Ti(OiPr)" }, { text: "4", script: "subscript" }] },
        "284.22",
        "0.96"
      ],
      [
        { text: "TBHPa", spans: [{ text: "TBHP" }, { text: "a", script: "superscript" }] },
        "90.12",
        "—"
      ]
    ]
  };

  it("reads the Word-like table: paragraphs, subscript, superscript span, paragraph alignment", () => {
    const result = expectOk(readHtml(fixture("word-like.html")));
    expect(result.warnings).toEqual([]);
    expect(result.spec).toEqual(wordSpec);
  });

  it("reads the Word table out of a CF_HTML envelope under the HTML Format type", () => {
    const raw = fixture("word-like.cfhtml.txt");
    expect(raw.startsWith("Version:")).toBe(true);
    const result = expectOk(readHtml(raw, "HTML Format"));
    expect(result.spec).toEqual(wordSpec);
    expect(result.warnings).toEqual([]);
  });

  it("reads the Google Docs-like table: guid wrapper, merged cell, bold, italic, subscript", () => {
    const result = expectOk(readHtml(fixture("google-docs-like.html")));
    expect(result.warnings).toEqual(["Merged cells were split into separate cells."]);
    expect(result.spec).toEqual({
      columns: [left, left, right],
      rows: [
        [bold("Reagent"), "", bold("Mass (g)")],
        [
          { text: "Ti(OiPr)4", spans: [{ text: "Ti(OiPr)" }, { text: "4", script: "subscript" }] },
          { text: "0.05 equiv", spans: [{ text: "0.05 equiv", italic: true }] },
          "0.245"
        ],
        ["(+)-DET", "0.06 equiv", "0.213"]
      ]
    });
  });

  it("reads the Google Sheets-like table: custom wrapper, right-aligned numbers, empty cell", () => {
    const result = expectOk(readHtml(fixture("google-sheets-like.html")));
    expect(result.warnings).toEqual([]);
    expect(result.spec).toEqual({
      columns: [left, { align: "decimal" }, { align: "decimal" }],
      // google-sheets-like.html starts with Material, MW and mmol labels above numeric columns.
      headerRows: [["Material", "MW (g/mol)", "mmol"]],
      rows: [
        ["allyl alcohol", "58.08", "17.22"],
        ["TBHP", "90.12", "34.44"],
        ["CH2Cl2", "84.93", ""]
      ]
    });
  });
});

describe("real Windows Office 16 clipboard captures (2026-10-30)", () => {
  const names = ["windows-real-excel", "windows-real-word-plain", "windows-real-word-repeat"];
  const header = [["Solvent", "bp (°C)", "Density (g/mL)"]];
  const wordRows = [
    ["CH2Cl2", "39.6", "1.33"],
    ["Ethanol", "78.37", "0.7914"],
    ["Mercury", "356.7", "13.546"],
    ["Water", "100", "1"]
  ];
  const excelRows = wordRows.map((row, index) => [row[0], row[1], ["1.33", "0.79", "13.55", "1.00"][index]]);

  it.each(names)("reads the native reader's HTML and Unicode text (%s)", name => {
    const html = fixture(`${name}.html`);
    const text = fixture(`${name}.txt`);
    // Native-reader payloads retain the capture's CRLF, including in CF_UNICODETEXT.
    for (const captured of [html, text]) {
      expect(captured).toContain("\r\n");
      expect(captured.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    }
    // parse_cf_html strips the CF_HTML envelope, retaining the document and markers.
    expect(html).not.toMatch(/Version:|StartHTML:|StartFragment:/);
    expect(html).toContain("<!--StartFragment-->");
    expect(html).toContain("<!--EndFragment-->");
    const result = expectOk(readHtmlAndTsv(html, text));
    expect(result).toEqual({
      ok: true,
      source: "html",
      spec: {
        columns: [left, { align: "decimal" }, { align: "decimal" }],
        caption: "Table 1. Solvent properties",
        headerRows: header,
        rows: name === "windows-real-excel" ? excelRows : wordRows,
        footnotes: ["a Densities at 20 °C."]
      },
      warnings: []
    });
    expect(TableSpecSchema.parse(result.spec)).toEqual(result.spec);
    let id = 0;
    const built = buildTableObject(result.spec, { id: "real-table", x: 0, y: 0, newId: () => `real-${++id}` }).object;
    expect(built.headerRowCount).toBe(1);
    expect(built.rows).toHaveLength(5);
    expect(built.rows.every(row => row.cells.length === 3)).toBe(true);
  });

  it("recovers only the formatted Density values actually exposed by CF_UNICODETEXT", () => {
    const text = fixture("windows-real-excel.txt");
    expect(text.split("\r\n").slice(2, 6).map(row => row.split("\t")[2]))
      .toEqual(["1.33", "0.79", "13.55", "1.00"]);
    const html = fixture("windows-real-excel.html");
    expect(html.match(/>##<\/td>/g)).toHaveLength(4);
    expect(html).not.toContain("x:num");
    const result = expectOk(readHtml(html));
    expect(result.spec.headerRows).toEqual(header);
    expect(result.spec.rows.map(row => row[2])).toEqual(["##", "##", "##", "##"]);
    expect(result.warnings).toEqual([3, 4, 5, 6].map(row =>
      `The cell in row ${row}, column 3 contains Excel overflow text (#); `
      + "its value was unavailable in x:num and the matching TSV, so the overflow text was kept."
    ));
  });

  it("infers the plain Word header without treating its positional first-row marker as a header", () => {
    const html = fixture("windows-real-word-plain.html");
    expect(html).not.toMatch(/<thead\b|<th\b|<w:tblHeader\b/i);
    expect(html).toContain("mso-yfti-firstrow:yes");
    expect(expectOk(readHtml(html)).spec.headerRows).toEqual(header);
  });

  it("extracts the merged caption even though Word puts it inside thead", () => {
    const html = fixture("windows-real-word-repeat.html");
    const head = parseHtml(html).querySelector("thead")!;
    expect(head.rows).toHaveLength(2);
    expect(head.rows[0].cells).toHaveLength(1);
    expect(head.rows[0].cells[0].colSpan).toBe(3);
    const result = expectOk(readHtml(html));
    expect(result.spec.caption).toBe("Table 1. Solvent properties");
    expect(result.spec.headerRows).toEqual(header);
    expect(result.warnings).toEqual([]);
  });

  it.each(["data-first", "all-text"])("keeps a real plain Word table %s variant at zero headers", variant => {
    const document = parseHtml(fixture("windows-real-word-plain.html"));
    const rows = document.querySelectorAll("tr");
    if (variant === "data-first") rows[1].remove();
    else for (const row of Array.from(rows).slice(2, -1)) {
      row.querySelectorAll("td")[1].textContent = "unknown";
      row.querySelectorAll("td")[2].textContent = "unknown";
    }
    const result = expectOk(readHtml(document.documentElement.outerHTML));
    expect(result.spec.headerRows).toBeUndefined();
    expect(result.spec.caption).toBe("Table 1. Solvent properties");
    expect(result.spec.footnotes).toEqual(["a Densities at 20 °C."]);
    expect(result.warnings).toEqual([]);
  });
});

describe("Excel overflow recovery", () => {
  const excelHeaders = ["Material", "MW (g/mol)", "Density (g/mL)", "Equiv.", "mmol", "Mass (g)", "Volume (mL)"];
  const textOf = (cell: string | { text: string }) => typeof cell === "string" ? cell : cell.text;

  it.each([
    "external,html,tsv", "external,tsv,html", "html,external,tsv",
    "html,tsv,external", "tsv,external,html", "tsv,html,external"
  ])("matches the full Excel grid regardless of text flavour order (%s)", order => {
    const tsv = fixture("excel-overflow-notes.tsv");
    const items: Record<string, ClipboardReadPayload["textItems"][number]> = {
      external: { type: "public.utf16-external-plain-text", text: tsv.replace(/0\.854|1\.204/g, "#######").replace(/\t/g, "\n") },
      html: { type: "public.html", text: fixture("excel-overflow-notes.html") },
      tsv: { type: "public.utf8-plain-text", text: tsv }
    };
    expect(items.external.text).not.toContain("\t");
    const textItems = order.split(",").map(name => items[name]);
    const payload: ClipboardReadPayload = { types: textItems.map(item => item.type), textItems };
    const result = expectOk(readClipboardHtmlTable(payload, parseHtml));
    expect(result.source).toBe("html");
    expect(result.spec.caption).toBe("Table S2. Sharpless reagent plan (synthetic).");
    expect(result.spec.headerRows).toEqual([excelHeaders]);
    expect(result.spec.columns).toHaveLength(7);
    expect(result.spec.rows).toHaveLength(5);
    expect(result.spec.rows.every(row => row.length === 7)).toBe(true);
    expect(result.spec.rows[0][2]).toBe("0.854");
    expect(result.spec.rows[2][2]).toBe("1.204");
    expect(result.spec.footnotes?.map(textOf)).toEqual(["a TBHP stock solution; synthetic example."]);
    expect(result.warnings).toEqual([]);
    expect(TableSpecSchema.parse(result.spec)).toEqual(result.spec);
  });

  it.each(["\n", "\r", "\r\n"])("recovers Density from the full tab-padded TSV grid (%j)", newline => {
    const html = fixture("excel-overflow-notes.html");
    const tsv = fixture("excel-overflow-notes.tsv").replace(/\n/g, newline);
    expect(html).not.toContain("x:num");
    expect(tsv).toContain(`\t\t\t\t\t\t${newline}`);
    const result = expectOk(readHtmlAndTsv(html, tsv));
    expect(result.spec.columns).toHaveLength(7);
    expect(result.spec.rows.map(row => row.map(textOf))).toEqual([
      ["allyl alcohol", "58.08", "0.854", "1.00", "17.22", "1.00", "1.17"],
      ["Ti(OiPr)4", "284.22", "0.96", "0.05", "0.861", "0.245", "0.255"],
      ["(+)-DET", "206.19", "1.204", "0.06", "1.033", "0.213", "0.177"],
      ["TBHPa", "90.12", "—", "2.0", "34.44", "—", "6.26"],
      ["CH2Cl2", "84.93", "1.33", "—", "—", "—", "86"]
    ]);
    expect(result.warnings).toEqual([]);
    expect(TableSpecSchema.parse(result.spec)).toEqual(result.spec);
  });

  it("extracts colspan caption and short colspan footnote without a merged-cells warning, even without TSV", () => {
    const result = expectOk(readHtml(fixture("excel-overflow-notes.html")));
    expect(result.spec.caption).toBe("Table S2. Sharpless reagent plan (synthetic).");
    expect(result.spec.footnotes).toEqual([{ text: "a TBHP stock solution; synthetic example.", spans: [
      { text: "a", script: "superscript" }, { text: " TBHP stock solution; synthetic example." }
    ] }]);
    expect(result.warnings).toEqual([
      expect.stringMatching(/row 3, column 3.*overflow/),
      expect.stringMatching(/row 5, column 3.*overflow/)
    ]);
  });

  it("recognizes Excel's class-styled td heading after its caption as one header row", () => {
    const result = expectOk(readHtmlAndTsv(fixture("excel-overflow-notes.html"), fixture("excel-overflow-notes.tsv")));
    expect(result.spec.headerRows).toEqual([excelHeaders]);
    expect(result.spec.rows).toHaveLength(5);
    expect(result.spec.rows.every(row => row.length === 7)).toBe(true);
    expect(result.spec.columns).toEqual([left, ...Array.from({ length: 6 }, () => ({ align: "decimal" }))]);
    expect(result.warnings).toEqual([]);
  });

  it("recognizes text above numeric columns even without Excel header borders", () => {
    const html = fixture("excel-overflow-notes.html");
    for (const modified of [
      html.replace('xmlns:x="urn:schemas-microsoft-com:office:excel"', "").replace("Excel.Sheet", "Other"),
      // This defeats the border rule, but content still establishes a single header.
      html.replace("class=xl22 width=90 style='width:67pt'", "class=xl22 width=90 style='width:67pt;border-bottom:none'")
    ]) {
      expect(expectOk(readHtml(modified)).spec.headerRows).toEqual([excelHeaders]);
    }
  });

  it("does not treat an ordinary Excel grid with borders on every row as a header", () => {
    const html = '<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><style>'
      + '.xl1 { border-top:1pt solid black; border-bottom:1pt solid black; }</style></head><body><table>'
      + '<tr><td class=xl1>a</td><td class=xl1>1.00</td></tr>'
      + '<tr><td class=xl1>b</td><td class=xl1>2.00</td></tr></table></body></html>';
    expect(expectOk(readHtml(html)).spec.headerRows).toBeUndefined();
  });

  it("keeps border-only inference restricted to Excel and respects inline border overrides", () => {
    const html = '<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><style>'
      + '.xl1 { border-bottom:1pt solid black; }</style></head><body><table>'
      + '<tr><td class=xl1>Material</td><td class=xl1>State</td></tr>'
      + '<tr><td>allyl alcohol</td><td>liquid</td></tr></table></body></html>';
    expect(expectOk(readHtml(html)).spec.headerRows).toEqual([["Material", "State"]]);
    expect(expectOk(readHtml(html.replace('xmlns:x="urn:schemas-microsoft-com:office:excel"', "")))
      .spec.headerRows).toBeUndefined();
    expect(expectOk(readHtml(html.replace('class=xl1>State', 'class=xl1 style="border-bottom:none">State')))
      .spec.headerRows).toBeUndefined();
  });

  it("keeps tab-padded Excel notes as rows without HTML confirmation", () => {
    const result = expectOk(readClipboardTsvTable(fixture("excel-overflow-notes.tsv")));
    // A TSV label followed by empty cells is ambiguous: only the matching HTML
    // colspan confirms a note. Standalone TSV must preserve those cells as rows.
    expect(result.spec.caption).toBeUndefined();
    expect(result.spec.footnotes).toBeUndefined();
    expect(result.spec.headerRows).toBeUndefined();
    expect(result.spec.rows).toHaveLength(8);
    expect(result.spec.rows[0]).toEqual(["Table S2. Sharpless reagent plan (synthetic).", "", "", "", "", "", ""]);
    expect(result.spec.rows[1]).toEqual(excelHeaders);
    expect(result.spec.rows[7]).toEqual(["a TBHP stock solution; synthetic example.", "", "", "", "", "", ""]);
    expect(result.warnings).toEqual([]);
    expect(TableSpecSchema.parse(result.spec)).toEqual(result.spec);
  });

  it("keeps sparse and all-empty TSV data rows inside the table, and populated boundary rows", () => {
    const result = expectOk(readClipboardTsvTable(
      "Caption\t\t\na\t\t1.00\ninterior label\t\t\n\t\t\nb\t2.00\t\nFootnote\t\t"
    ));
    // Tab-padded boundary labels have the same data-row contract as interior labels.
    expect(result.spec.caption).toBeUndefined();
    expect(result.spec.footnotes).toBeUndefined();
    expect(result.spec.rows).toEqual([
      ["Caption", "", ""], ["a", "", "1.00"], ["interior label", "", ""],
      ["", "", ""], ["b", "2.00", ""], ["Footnote", "", ""]
    ]);
    expect(result.warnings).toEqual([]);
    expect(expectOk(readClipboardTsvTable("a\t\t1.00\nb\t2.00\t")).spec).toMatchObject({
      rows: [["a", "", "1.00"], ["b", "2.00", ""]]
    });
  });

  it("keeps refusals and cell limits for tab-padded TSV boundaries", () => {
    expectRefusal(readClipboardTsvTable("Caption\t\nA\tB\nC\tD\tE\nFootnote\t"), /different numbers of columns/);
    expectRefusal(readClipboardTsvTable("A\tB\nseparator\nC\tD\nFootnote\t"), /separated tab-separated blocks/);
    // These are data cells now, so the cell cap applies and the footnote cap does not.
    expectRefusal(readClipboardTsvTable(`${"x".repeat(2001)}\t\nA\tB\nC\tD`), /row 1, column 1 has 2001 characters/);
    expect(expectOk(readClipboardTsvTable(`A\tB\nC\tD\n${"Footnote\t\n".repeat(51)}`)).spec.rows).toHaveLength(53);
  });

  it.each(["tsv", "html"])("keeps sparse boundary labels and Total as data in %s", source => {
    const rows = [["Label", "", "", ""], ["a", "1", "2", "3"], ["Total", "", "", ""]];
    const result = expectOk(source === "tsv" ? readClipboardTsvTable(rows.map(row => row.join("\t")).join("\n"))
      : readHtmlAndTsv(table(rows.map(row => `<tr>${row.map(text => `<td>${text}</td>`).join("")}</tr>`).join("")),
        rows.map(row => row.join("\t")).join("\n")));
    expect(result.spec.rows).toEqual(rows);
    expect(result.spec.caption).toBeUndefined();
    expect(result.spec.footnotes).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it.each(["tsv", "html"])("parses a two-column %s table with empty second cells", source => {
    const rows = [["first", ""], ["second", ""]];
    const result = expectOk(source === "tsv" ? readClipboardTsvTable("first\t\nsecond\t")
      : readHtml(table("<tr><td>first</td><td></td></tr><tr><td>second</td><td></td></tr>")));
    expect(result.spec.rows).toEqual(rows);
    expect(result.spec.columns).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });

  it.each([false, true])("does not promote bordered numeric data rows (Excel: %s)", excel => {
    const border = 'style="border-top-style:solid;border-top-width:1pt;border-bottom-style:solid;border-bottom-width:1pt"';
    const html = `<html${excel ? ' xmlns:x="urn:schemas-microsoft-com:office:excel"' : ""}><body><table>`
      + `<tr><td ${border}>a</td><td ${border}>1.00</td></tr>`
      + '<tr><td>b</td><td>2.00</td></tr></table></body></html>';
    const result = expectOk(readHtml(html));
    expect(result.spec.headerRows).toBeUndefined();
    expect(result.spec.rows).toEqual([["a", "1.00"], ["b", "2.00"]]);
  });

  it("infers only contiguous Excel headings whose next row has no bottom borders", () => {
    const border = 'style="border-bottom-style:solid;border-bottom-width:1pt"';
    const heading = `<tr><td ${border}>Material</td><td ${border}>Value</td></tr>`;
    const data = '<tr><td>a</td><td>1.00</td></tr>';
    const excel = (rows: string) => `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><body><table>${rows}</table></body></html>`;
    expect(expectOk(readHtml(excel(heading + heading + data))).spec.headerRows).toHaveLength(2);
    expect(expectOk(readHtml(excel(data + heading + data))).spec.headerRows).toBeUndefined();
    expect(expectOk(readHtml(excel(heading + `<tr><td ${border}>a</td><td>1.00</td></tr>`))).spec.headerRows).toHaveLength(1);
    expect(expectOk(readHtml(table(heading + data))).spec.headerRows).toHaveLength(1);
  });

  it.each(["caption", "footnote", "body", "dimensions"])("does not recover Excel values when the full TSV %s differs", part => {
    let tsv = fixture("excel-overflow-notes.tsv");
    if (part === "caption") tsv = tsv.replace("Table S2.", "Different caption.");
    if (part === "footnote") tsv = tsv.replace("TBHP stock solution", "Unrelated stock solution");
    if (part === "body") tsv = tsv.replace("allyl alcohol", "Unrelated reagent");
    if (part === "dimensions") tsv += "Extra\trow\t\t\t\t\t\r";
    const result = expectOk(readHtmlAndTsv(fixture("excel-overflow-notes.html"), tsv));
    expect(result.spec.rows[0][2]).toBe("#######");
    expect(result.spec.rows[2][2]).toBe("#######");
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.every(warning => warning.includes("overflow"))).toBe(true);
  });

  it.each(["caption", "footnote", "body", "dimensions", "malformed"])("skips a nonmatching first TSV (%s) and uses a later matching grid", part => {
    const tsv = fixture("excel-overflow-notes.tsv");
    let different = tsv;
    if (part === "caption") different = tsv.replace("Table S2.", "Different caption.");
    if (part === "footnote") different = tsv.replace("TBHP stock solution", "Unrelated stock solution");
    if (part === "body") different = tsv.replace("allyl alcohol", "Unrelated reagent");
    if (part === "dimensions") different += "Extra\trow\t\t\t\t\t\r";
    if (part === "malformed") different = '"broken\tfield';
    const textItems = [
      { type: "text/plain", text: different },
      { type: "public.html", text: fixture("excel-overflow-notes.html") },
      { type: "public.utf8-plain-text", text: tsv }
    ];
    const result = expectOk(readClipboardHtmlTable({ types: textItems.map(item => item.type), textItems }, parseHtml));
    expect(result).toEqual(expectOk(readHtmlAndTsv(fixture("excel-overflow-notes.html"), tsv)));
  });

  it("names a truly unrecoverable cell while recovering the other Density value from a later flavour", () => {
    const tsv = fixture("excel-overflow-notes.tsv").replace("1.204", "#######");
    const textItems = [
      { type: "public.utf16-external-plain-text", text: tsv.replace("0.854", "#######").replace(/\t/g, "\n") },
      { type: "public.html", text: fixture("excel-overflow-notes.html") },
      { type: "public.utf16-plain-text", text: tsv }
    ];
    const result = expectOk(readClipboardHtmlTable({ types: textItems.map(item => item.type), textItems }, parseHtml));
    expect(result.spec.rows[0][2]).toBe("0.854");
    expect(result.spec.rows[2][2]).toBe("#######");
    expect(result.warnings).toEqual([expect.stringMatching(/row 5, column 3.*Excel overflow.*value was unavailable/)]);
  });

  const overflow = `<table><tr><td>Material</td><td>Density</td></tr>`
    + `<tr><td>allyl alcohol</td><td x:num>#######</td></tr></table>`;

  it("prefers x:num over TSV only for overflow text, without rounding the numeric attribute", () => {
    const html = table(`<tr><td x:num="0.85399999999999998">#######</td>`
      + `<td x:num="1.204">1.20</td><td x:num>2.00</td><td>#note</td></tr>`);
    const result = expectOk(readHtmlAndTsv(html, "9\t9\t9\t9"));
    expect(result.spec.rows).toEqual([["0.85399999999999998", "1.20", "2.00", "#note"]]);
    expect(result.warnings).toEqual([]);
  });

  it("recovers both synthetic Density cells from x:num without plain text", () => {
    const result = expectOk(readHtml(fixture("excel-like.html")));
    expect(result.spec.rows[0][2]).toBe("0.854");
    expect(result.spec.rows[2][2]).toBe("1.204");
    expect(result.warnings).toEqual([]);
  });

  it("recovers the same grid from the synthetic TSV when numeric attributes are unavailable", () => {
    const html = fixture("excel-like.html").replace(/ x:num="(?:0\.854|1\.204)"/g, " x:num");
    const result = expectOk(readHtmlAndTsv(html, fixture("excel-like.tsv")));
    expect(result.spec).toEqual(expectOk(readHtml(fixture("excel-like.html"))).spec);
    expect(result.warnings).toEqual([]);
  });

  it.each(["", '="not a number"', '="1e999"'])("uses TSV for empty or invalid x:num (%s)", (value) => {
    const result = expectOk(readHtmlAndTsv(overflow.replace("x:num", `x:num${value}`), "Material\tDensity\nallyl alcohol\t0.854"));
    expect(result.spec.rows[0][1]).toBe("0.854");
    expect(result.warnings).toEqual([]);
  });

  it("recovers a single HTML row from matching TSV without changing standalone TSV detection", () => {
    const result = expectOk(readHtmlAndTsv(table("<tr><td>a</td><td>###</td></tr>"), "a\t1.204"));
    expect(result.spec.rows).toEqual([["a", "1.204"]]);
    expect(result.warnings).toEqual([]);
    expect(readClipboardTsvTable("a\t1.204")).toBeUndefined();
  });

  it.each([
    undefined,
    "Material\tDensity\nallyl alcohol\t###",
    "Material\tDensity\nallyl alcohol\t",
    "Material\tDensity\nunrelated reagent\t1.204",
    "Material\tDensity\textra\nallyl alcohol\t0.854\textra",
    "Material\tDensity\nallyl alcohol\t0.854\nextra\t1",
    'Material\tDensity\n"broken\t0.854',
    `Material\tDensity\nallyl alcohol\t${"x".repeat(2001)}`
  ])("keeps unresolved overflow with its row and column when TSV is absent, mismatched, or unsafe (%#)", (tsv) => {
    const result = expectOk(tsv === undefined ? readHtml(overflow) : readHtmlAndTsv(overflow, tsv));
    expect(result.spec.rows[1][1]).toBe("#######");
    expect(result.warnings).toEqual([expect.stringMatching(/row 2, column 2.*Excel overflow.*value was unavailable/)]);
  });

  it("warns for every unresolved cell in the synthetic Excel fixture", () => {
    const result = expectOk(readHtml(fixture("excel-like.html").replace(/ x:num="(?:0\.854|1\.204)"/g, "")));
    expect(result.warnings).toEqual([
      expect.stringMatching(/row 2, column 3.*overflow/),
      expect.stringMatching(/row 4, column 3.*overflow/)
    ]);
  });

  it("does not map TSV values into an expanded merged grid", () => {
    const html = table(`<tr><td colspan=2>###</td></tr><tr><td>a</td><td>b</td></tr>`);
    const result = expectOk(readHtmlAndTsv(html, "1.204\t\na\tb"));
    expect(result.spec.rows[0][0]).toBe("###");
    expect(result.warnings).toContainEqual(expect.stringMatching(/row 1, column 1.*overflow/));
  });

  it("does not map TSV in DOM order to HTML rows reordered by their section", () => {
    const html = "<table><tfoot><tr><td>footer</td><td>###</td></tr></tfoot>"
      + "<tbody><tr><td>body</td><td>###</td></tr></tbody></table>";
    const result = expectOk(readHtmlAndTsv(html, "footer\t1.204\nbody\t0.854"));
    expect(result.spec.rows).toEqual([["body", "###"], ["footer", "###"]]);
    expect(result.warnings).toHaveLength(2);
  });

  it("enforces the cell cap on original overflow text and recovered x:num values", () => {
    expectRefusal(readHtml(table(`<tr><td x:num="0.854">${"#".repeat(2001)}</td><td>a</td></tr>`)), /row 1, column 1 has 2001 characters/);
    const number = `0.${"0".repeat(1999)}`;
    expectRefusal(readHtml(table(`<tr><td x:num="${number}">###</td><td>a</td></tr>`)), /row 1, column 1 has 2001 characters/);
  });

  it("enforces the total character cap after recovering x:num values", () => {
    const number = `0.${"0".repeat(998)}`;
    const row = `<tr><td x:num="${number}">###</td><td x:num="${number}">###</td></tr>`;
    expectOk(readHtml(table(row.repeat(100))));
    expectRefusal(readHtml(table(row.repeat(100).replace(`x:num="${number}"`, `x:num="${number}0"`))), /200,001 characters/);
  });

  it("warns about pure overflow text in standalone TSV too", () => {
    const result = expectOk(readClipboardTsvTable("Density\tNote\n#######\t#note"));
    expect(result.spec.rows[1]).toEqual(["#######", "#note"]);
    expect(result.warnings).toEqual([expect.stringMatching(/row 2, column 1.*overflow/)]);
  });
});

describe("Word-like captions and footnotes", () => {
  it("reads the Office-shaped Word table with one header row and formatted surrounding notes", () => {
    const result = expectOk(readHtmlAndTsv(fixture("word-office-notes.html"), fixture("word-office-notes.tsv")));
    expect(result.spec.columns).toHaveLength(7);
    expect(result.spec.headerRows).toHaveLength(1);
    expect(result.spec.rows).toHaveLength(5);
    expect(result.spec.caption).toEqual({ text: "Table S1. Sharpless reagent quantities (synthetic).", spans: [
      { text: "Table S1.", bold: true }, { text: " Sharpless reagent quantities (synthetic)." }
    ] });
    expect(result.spec.footnotes).toHaveLength(1);
    expect(result.spec.rows[0][2]).toBe("0.854");
    expect(result.spec.rows[2][2]).toBe("1.204");
    expect(result.warnings).toEqual([]);
    expect(TableSpecSchema.parse(result.spec)).toEqual(result.spec);
  });

  it.each([false, true])("reads one HTML table among paragraphs (CF_HTML: %s)", (wrapped) => {
    const html = fixture("word-like-notes.html");
    const result = expectOk(readHtml(wrapped ? cfHtml(html) : html, wrapped ? "HTML Format" : "text/html"));
    expect(result.warnings).toEqual([]);
    expect(result.spec.caption).toEqual({ text: "Table 1. Reagent properties", spans: [
      { text: "Table 1.", bold: true }, { text: " Reagent properties" }
    ] });
    expect(result.spec.footnotes).toEqual([
      { text: "a Synthetic reagent data.", spans: [{ text: "a", script: "superscript" }, { text: " Synthetic reagent data." }] },
      "Densities are in g/mL."
    ]);
    // word-like-notes.html starts with Material and Density labels above numeric densities.
    expect(result.spec.headerRows).toEqual([["Material", "Density (g/mL)"]]);
    expect(result.spec.rows).toEqual([
      ["allyl alcohol", "0.854"],
      [{ text: "Ti(OiPr)4", spans: [{ text: "Ti(OiPr)" }, { text: "4", script: "subscript" }] }, "0.96"]
    ]);
    let id = 0;
    const { object } = buildTableObject(result.spec, { id: "table", x: 0, y: 0, newId: () => `note-${++id}` });
    expect(object.caption?.text).toBe("Table 1. Reagent properties");
    expect(object.footnotes.map((note) => note.text)).toEqual(["a Synthetic reagent data.", "Densities are in g/mL."]);
  });

  it.each(["\n", "\r\n"])("reads the rectangular TSV block surrounded by caption/footnote lines (%j)", (newline) => {
    const result = expectOk(readClipboardTsvTable(fixture("word-like-notes.tsv").replace(/\n/g, newline)));
    expect(result.warnings).toEqual([]);
    expect(result.spec.caption).toBe("Table 1. Reagent properties");
    expect(result.spec.footnotes).toEqual(["a Synthetic reagent data.", "Densities are in g/mL."]);
    expect(result.spec.rows).toEqual([["Material", "Density (g/mL)"], ["allyl alcohol", "0.854"], ["Ti(OiPr)4", "0.96"]]);
    expect(() => TableSpecSchema.parse(result.spec)).not.toThrow();
  });

  it("keeps quoted tabs and newlines in table cells with surrounding notes", () => {
    const result = expectOk(readClipboardTsvTable('Caption\na\t"has\ta tab"\nb\t"two\nlines"\nFootnote'));
    expect(result.spec).toMatchObject({ caption: "Caption", rows: [["a", "has\ta tab"], ["b", "two\nlines"]], footnotes: ["Footnote"] });
  });

  it.each(["html", "tsv"])("uses the immediately preceding paragraph as caption and names earlier omitted prose (%s)", (source) => {
    const result = expectOk(source === "html"
      ? readHtml(`<p>Introduction</p><p>Caption</p>${withHead}<p>Footnote</p>`)
      : readClipboardTsvTable("Introduction\nCaption\na\tb\nc\td\nFootnote"));
    expect(result.spec.caption).toBe("Caption");
    expect(result.spec.footnotes).toEqual(["Footnote"]);
    expect(result.warnings).toEqual(['The paragraph before the caption was not imported: "Introduction".']);
  });

  it("preserves an HTML caption element", () => {
    const result = expectOk(readHtml(table("<caption>Caption</caption><tr><td>a</td><td>b</td></tr>")));
    expect(result.spec.caption).toBe("Caption");
    expect(result.warnings).toEqual([]);
  });

  it("refuses unrepresentable surrounding content or unreadable table structures", () => {
    expectRefusal(readHtml(`bare text${withHead}`), /content around the HTML table cannot be read safely/);
    expectRefusal(readHtml(`<p>Caption<img src="x"></p>${withHead}`), /content around the HTML table cannot be read safely/);
    expectRefusal(readHtml("<table></table>"), /no readable rows/);
    expectRefusal(readHtml("<table><tr></tr><tr></tr></table>"), /no readable cells/);
    expectRefusal(readHtml(table('<tr><td>a</td><td rowspan=2>b</td></tr><tr><td colspan=2>c</td></tr>')), /overlapping merged cells at row 2, column 2/);
    expectRefusal(readClipboardHtmlTable(htmlPayload(withHead), () => { throw new Error("parse failed"); }), /could not be parsed safely/);
  });

  const withNotes = (source: string, caption: string, footnotes: string[], content?: string) => source === "html"
    ? readHtml(`<p>${caption}</p>${content ?? withHead}${footnotes.map((note) => `<p>${note}</p>`).join("")}`)
    : readClipboardTsvTable(`${caption}\n${content ?? "A\tB\n1\t2"}\n${footnotes.join("\n")}`);

  it.each(["html", "tsv"])("enforces caption/footnote text and count caps (%s)", (source) => {
    const boundary = expectOk(withNotes(source, "x".repeat(2000), Array.from({ length: 50 }, () => "Footnote")));
    expect(() => TableSpecSchema.parse(boundary.spec)).not.toThrow();
    expectRefusal(withNotes(source, "x".repeat(2001), []), /caption paragraph 1 has 2001 characters/);
    expectRefusal(withNotes(source, "Caption", ["x".repeat(2001)]), /footnote 1 has 2001 characters/);
    expectRefusal(withNotes(source, "Caption", Array.from({ length: 51 }, () => "Footnote")), /51 footnotes.*at most 50/);
  });

  it.each(["html", "tsv"])("counts surrounding notes toward the table character cap (%s)", (source) => {
    const body = source === "html"
      ? table(`<tr><td>${"x".repeat(1000)}</td><td>${"y".repeat(1000)}</td></tr>`.repeat(99))
      : Array.from({ length: 99 }, () => `${"x".repeat(1000)}\t${"y".repeat(1000)}`).join("\n");
    expectOk(withNotes(source, "x".repeat(1000), ["y".repeat(1000)], body));
    expectRefusal(withNotes(source, "x".repeat(1001), ["y".repeat(1000)], body), /200,001 characters/);
  });

  it("enforces formatted span caps on caption and footnote paragraphs", () => {
    const runs = (count: number) => Array.from({ length: count }, (_, i) => i % 2 ? "<i>x</i>" : "<b>x</b>").join("");
    expectOk(withNotes("html", runs(200), [runs(200)]));
    expectRefusal(withNotes("html", runs(201), []), /caption paragraph 1 has 201 spans/);
    expectRefusal(withNotes("html", "Caption", [runs(201)]), /footnote 1 has 201 spans/);
  });

  it.each(["html", "tsv"])("keeps table dimension caps when notes surround the grid (%s)", (source) => {
    const tall = source === "html" ? table("<tr><td>a</td><td>b</td></tr>".repeat(501)) : "a\tb\n".repeat(501).trimEnd();
    expectRefusal(withNotes(source, "Caption", ["Footnote"], tall), /501 rows.*at most 500/);
    const wide = source === "html"
      ? table(`<tr>${"<td>a</td>".repeat(65)}</tr>`)
      : Array.from({ length: 2 }, () => Array.from({ length: 65 }, () => "a").join("\t")).join("\n");
    expectRefusal(withNotes(source, "Caption", ["Footnote"], wide), /65 columns.*at most 64/);
  });
});

describe("what counts as a table", () => {
  it("leaves a single HTML cell to the text path", () => {
    expect(readHtml(table("<tr><td>allyl alcohol</td></tr>"))).toBeUndefined();
  });

  it("reads a caption paragraph beside a table, but keeps the two-cell minimum", () => {
    const lone = "<table><tr><td>a</td><td>b</td></tr></table>";
    expect(expectOk(readHtml(`<p>See the table below.</p>${lone}`)).spec.caption).toBe("See the table below.");
    expect(readHtml(`<table><tr><td>a</td></tr></table><p>Footnote</p>`)).toBeUndefined();
  });

  it("is not a table with no table, and refuses multiple tables", () => {
    expect(readHtml("<p>just text</p>")).toBeUndefined();
    expectRefusal(readHtml("<table><tr><td>a</td></tr></table><table><tr><td>b</td></tr></table>"), /multiple HTML tables/);
    const plain = { types: ["text/plain"], textItems: [{ type: "text/plain", text: "a" }] };
    expect(readClipboardHtmlTable(plain, parseHtml)).toBeUndefined();
  });

  it("ignores empty paragraphs, breaks, meta, style, comments and wrappers around the table", () => {
    const html =
      `<meta charset="utf-8"><style>td{color:red}</style><!-- note --><p>&nbsp;</p><br>` +
      `<o:p></o:p><b id="docs-internal-guid-1" style="font-weight:normal"><div>` +
      `<table><tr><td>a</td><td>b</td></tr></table></div></b><p></p>`;
    expect(expectOk(readHtml(html)).spec.rows).toEqual([["a", "b"]]);
  });

  it("matches the HTML type case-insensitively", () => {
    const result = expectOk(readHtml(table("<tr><td>a</td><td>b</td></tr>"), "Public.HTML"));
    expect(result.spec.rows).toEqual([["a", "b"]]);
  });
});

describe("CF_HTML header", () => {
  const document =
    "<html><body><!--StartFragment--><table><tr><td>x</td><td>y</td></tr></table>" +
    "<!--EndFragment--></body></html>";
  const header = (start: string) =>
    `Version:0.9\r\nStartHTML:${start}\r\nEndHTML:0000000999\r\n` +
    "StartFragment:0000000000\r\nEndFragment:0000000000\r\n";
  const bare = "<table><tr><td>x</td><td>y</td></tr></table>";

  it("drops everything before StartHTML", () => {
    const length = header("0000000000").length;
    const start = String(length).padStart(10, "0");
    expect(expectOk(readHtml(header(start) + document)).spec.rows).toEqual([["x", "y"]]);
    // The header's own words would be text beside the table if the offset were ignored.
    expect(expectOk(readHtml(header(start) + bare)).spec.rows).toEqual([["x", "y"]]);
  });

  it("falls back to the first tag when the offset is unusable", () => {
    for (const start of ["garbage", "0000000003", "0000009999"]) {
      expect(expectOk(readHtml(header(start) + bare)).spec.rows).toEqual([["x", "y"]]);
      expect(expectOk(readHtml(header(start) + document)).spec.rows).toEqual([["x", "y"]]);
    }
  });

  it("uses only the marked fragment when markers are present", () => {
    const html =
      `<html><body><p>outside</p><!--StartFragment-->${bare}<!--EndFragment--><p>after</p></body></html>`;
    expect(expectOk(readHtml(html)).spec.rows).toEqual([["x", "y"]]);
    expect(expectOk(readHtml(`<!--StartFragment--><p>inside</p>${bare}<!--EndFragment-->`)).spec.caption).toBe("inside");
  });

  it("reads paragraphs around Excel internal markers and refuses another table", () => {
    const html = fixture("excel-markers-inside-table.html");
    expect(expectOk(readHtml(html.replace(/(<body[^>]*>)/, "$1<p>Caption</p>"))).spec.caption).toBe("Caption");
    expect(expectOk(readHtml(html.replace("</body>", "<p>Footnote</p></body>"))).spec.footnotes).toEqual(["Footnote"]);
    expectRefusal(readHtml(html.replace(/(<body[^>]*>)/, `$1${bare}`)), /multiple HTML tables/);
    expectRefusal(readHtml(html.replace("</body>", `${bare}</body>`)), /multiple HTML tables/);
  });

  it("does not use a table that does not contain the fragment start", () => {
    expect(readHtml(`${bare}<!--StartFragment--><!--EndFragment-->`)).toBeUndefined();
    expect(readHtml(`<!--StartFragment--><!--EndFragment-->${bare}`)).toBeUndefined();
  });
});

describe("table structure", () => {
  it.each([
    "<1 mg", "<=1 mg", ">=1 mg", ">= 5 %", "=<1 mg", "=>1 mg", ">1 g/mL", "≤-1.25 °C", "≥1,234.5 mmol", "~.5%", "≈−1.2e-3 mg", "±1E+2 g",
    "< -1,234.5e-2 µmol/L", "1 mg", "18%"
  ])("keeps a headerless measurement row as data (%s)", measurement => {
    const rows = [["ethanol", measurement], ["water", "18"], ["methanol", "32"]];
    const html = table(rows.map(row => `<tr>${row.map(text =>
      `<td>${text.replace(/</g, "&lt;")}</td>`).join("")}</tr>`).join(""));
    const result = expectOk(readHtml(html));
    expect(result.spec.headerRows).toBeUndefined();
    expect(result.spec.rows).toEqual(rows);
    expect(result.warnings).toEqual([]);
  });

  it.each(["MW (g/mol)", "Density (g/mL)", "mmol"])("infers a header with a measurement label (%s)", label => {
    const rows = [["Material", label], ["water", "18"], ["methanol", "32"]];
    const html = table(rows.map(row => `<tr>${row.map(text => `<td>${text}</td>`).join("")}</tr>`).join(""));
    expect(expectOk(readHtml(html)).spec.headerRows).toEqual([rows[0]]);
  });

  it("does not infer a heading from padded ragged data rows", () => {
    const rows = [["ethanol", "not measured"], ["water", "18", "liquid"], ["methanol", "32", "liquid"]];
    const html = table(rows.map(row => `<tr>${row.map(text => `<td>${text}</td>`).join("")}</tr>`).join(""));
    const result = expectOk(readHtml(html));
    expect(result.spec.headerRows).toBeUndefined();
    expect(result.spec.rows).toEqual([["ethanol", "not measured", ""], ...rows.slice(1)]);
    expect(result.warnings).toEqual(["Short rows were padded with empty cells."]);
  });

  it.each([1, 2])("counts body colspans when checking source widths (span %s)", span => {
    const result = expectOk(readHtml(table('<tr><td>Material</td><td>MW</td><td>State</td></tr>'
      + `<tr><td>water</td><td colspan=${span}>18</td></tr>`
      + '<tr><td>methanol</td><td>32</td><td>liquid</td></tr>')));
    expect(result.spec.headerRows).toEqual(span === 2 ? [["Material", "MW", "State"]] : undefined);
  });

  it.each([
    '<tr><td>allyl alcohol</td><td>58.08</td></tr><tr><td>Ti(OiPr)4</td><td>284.22</td></tr>',
    '<tr><td>Material</td><td>State</td></tr><tr><td>allyl alcohol</td><td>liquid</td></tr>',
    '<tr><td>Material</td><td>MW</td></tr><tr><td>allyl alcohol</td><td>58.08</td></tr>'
      + '<tr><td>Ti(OiPr)4</td><td>unknown</td></tr>',
    '<tr><td>Material</td><td></td></tr><tr><td>allyl alcohol</td><td>58.08</td></tr>',
    '<tr><td>Material</td><td>1e2</td></tr><tr><td>allyl alcohol</td><td>58.08</td></tr>',
    '<tr style="mso-yfti-irow:0;mso-yfti-firstrow:yes"><td>allyl alcohol</td><td>58.08</td></tr>'
      + '<tr><td>Ti(OiPr)4</td><td>284.22</td></tr>'
  ])("does not infer a header without text labels above a numeric majority (%s)", rows => {
    expect(expectOk(readHtml(table(rows))).spec.headerRows).toBeUndefined();
  });

  it("infers only the first row, even with another text row above numbers", () => {
    const result = expectOk(readHtml(table('<tr><td>Material</td><td>MW</td></tr>'
      + '<tr><td>Reagent</td><td>g/mol</td></tr><tr><td>allyl alcohol</td><td>58.08</td></tr>'
      + '<tr><td>Ti(OiPr)4</td><td>284.22</td></tr>')));
    expect(result.spec.headerRows).toEqual([["Material", "MW"]]);
    expect(result.spec.rows).toHaveLength(3);
  });

  it.each(['<w:tblHeader/>', '<!--[if supportMisalignedColumns]><w:tblHeader/><![endif]-->'])(
    "recognizes Word repeat-header markers independently of numeric content (%s)", marker => {
      const result = expectOk(readHtml(table(`<tr><td>${marker}Material</td><td>State</td></tr>`
        + '<tr><td>allyl alcohol</td><td>liquid</td></tr>')));
      expect(result.spec.headerRows).toEqual([["Material", "State"]]);
    }
  );

  it("respects a disabled Word repeat-header marker", () => {
    expect(expectOk(readHtml(table('<tr><td><w:tblHeader w:val="0"/>Material</td><td>State</td></tr>'
      + '<tr><td>allyl alcohol</td><td>liquid</td></tr>'))).spec.headerRows).toBeUndefined();
  });

  const body = "<tr><th>Material</th><th>MW</th><th>Density</th><th>Equiv.</th></tr>"
    + "<tr><td>allyl alcohol</td><td>58.08</td><td>0.854</td><td>1.00</td></tr>";
  const noteRow = (text: string, attributes = "colspan=2") =>
    `<tr><td ${attributes}>${text}</td><td></td><td></td></tr>`;

  it.each(["colspan=2", 'colspan=2 style="mso-ignore:colspan"', 'style="mso-ignore:colspan"'])(
    "extracts single-label boundary rows (%s) before finding headers", attributes => {
      const result = expectOk(readHtml(table(noteRow("Caption", attributes) + body + noteRow("Footnote", attributes))));
      expect(result.spec.caption).toBe("Caption");
      expect(result.spec.footnotes).toEqual(["Footnote"]);
      expect(result.spec.headerRows).toEqual([["Material", "MW", "Density", "Equiv."]]);
      expect(result.spec.rows).toEqual([["allyl alcohol", "58.08", "0.854", "1.00"]]);
      expect(result.warnings).toEqual([]);
    }
  );

  it("keeps interior wide labels, unspanned boundary labels and vertical merges in the grid", () => {
    const result = expectOk(readHtml(table(body + noteRow("Interior") + body)));
    expect(result.spec.headerRows).toHaveLength(1);
    expect(result.spec.rows).toHaveLength(4);
    expect(result.spec.rows[1]).toEqual(["Interior", "", "", ""]);
    expect(result.spec.caption).toBeUndefined();
    expect(result.spec.footnotes).toBeUndefined();
    expect(result.warnings).toEqual(["Merged cells were split into separate cells."]);
    expect(expectOk(readHtml(table(noteRow("Label", "") + body))).spec.caption).toBeUndefined();
    const vertical = expectOk(readHtml(table(noteRow("Vertical", "colspan=2 rowspan=2") + body)));
    expect(vertical.spec.caption).toBeUndefined();
    expect(vertical.warnings).toContain("Merged cells were split into separate cells.");
  });

  it("checks text, span, footnote, dimension and total caps before extracting boundary notes", () => {
    expectRefusal(readHtml(table(noteRow("x".repeat(2001)) + body)), /2001 characters/);
    const runs = Array.from({ length: 201 }, (_, i) => i % 2 ? "<i>x</i>" : "<b>x</b>").join("");
    expectRefusal(readHtml(table(body + noteRow(runs))), /201 spans/);
    expectOk(readHtml(table(body + noteRow("Footnote").repeat(50))));
    expectRefusal(readHtml(table(body + noteRow("Footnote").repeat(51))), /51 footnotes.*at most 50/);
    expectRefusal(readHtml(table(body + noteRow("Footnote").repeat(499))), /501 rows.*at most 500/);
    expectRefusal(readHtml(table(noteRow("Caption", "colspan=65") + body)), /67 columns.*at most 64/);
    const bigRow = `<tr><td>${"x".repeat(1000)}</td><td>${"y".repeat(1000)}</td></tr>`;
    const notes = noteRow("c".repeat(1000), "colspan=2") + bigRow.repeat(99) + noteRow("f".repeat(1000), "colspan=2");
    expectOk(readHtml(table(notes)));
    expectRefusal(readHtml(table(notes.replace("<td colspan=2>c", "<td colspan=2>cc"))), /200,001 characters/);
    expect(readHtml(table("<tr><td>one</td></tr>"))).toBeUndefined();
  });

  it("expands colspan and rowspan into empty cells with a warning", () => {
    const result = expectOk(
      readHtml(
        table(
          `<tr><td colspan=2>wide</td><td rowspan=2>tall</td></tr>` +
            `<tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td><td>e</td></tr>`
        )
      )
    );
    expect(result.spec.rows).toEqual([
      ["wide", "", "tall"],
      ["a", "b", ""],
      ["c", "d", "e"]
    ]);
    expect(result.warnings).toEqual(["Merged cells were split into separate cells."]);
  });

  it("pads ragged rows with a warning", () => {
    const result = expectOk(readHtml(table(`<tr><td>a</td><td>b</td><td>c</td></tr><tr><td>d</td></tr>`)));
    expect(result.spec.rows).toEqual([["a", "b", "c"], ["d", "", ""]]);
    expect(result.warnings).toEqual(["Short rows were padded with empty cells."]);
  });

  it("flattens a nested table to its text and warns", () => {
    const result = expectOk(
      readHtml(
        table(`<tr><td>x<table><tr><td>p</td><td>q</td></tr><tr><td>r</td></tr></table></td><td>y</td></tr>`)
      )
    );
    expect(result.spec.rows).toEqual([["x\np q\nr", "y"]]);
    expect(result.warnings).toEqual(["Nested tables were flattened to text."]);
  });

  it("drops images with a warning", () => {
    const result = expectOk(
      readHtml(table(`<tr><td>a<img src="x.png"></td><td><img src="y.png"></td></tr>`))
    );
    expect(result.spec.rows).toEqual([["a", ""]]);
    expect(result.warnings).toEqual(["Images in the table were not imported."]);
  });

  it("takes header rows from thead", () => {
    const result = expectOk(
      readHtml(
        "<table><tbody><tr><td>1</td><td>2</td></tr></tbody>" +
          "<thead><tr><td>A</td><td>B</td></tr></thead></table>"
      )
    );
    expect(result.spec.headerRows).toEqual([["A", "B"]]);
    expect(result.spec.rows).toEqual([["1", "2"]]);
  });

  it.each([false, true])("never promotes a full-width thead caption (column headings in thead: %s)", headingsInHead => {
    const caption = '<tr><td colspan=2>Caption</td></tr>';
    const heading = '<tr><td>Material</td><td>State</td></tr>';
    const result = expectOk(readHtml(`<table><thead>${caption}${headingsInHead ? heading : ""}</thead>`
      + `<tbody>${headingsInHead ? "" : heading}<tr><td>ethanol</td><td>liquid</td></tr></tbody></table>`));
    expect(result.spec.caption).toBe("Caption");
    expect(result.spec.headerRows).toEqual(headingsInHead ? [["Material", "State"]] : undefined);
    expect(result.spec.rows).toEqual(headingsInHead
      ? [["ethanol", "liquid"]] : [["Material", "State"], ["ethanol", "liquid"]]);
    expect(result.warnings).toEqual([]);
  });

  it("takes leading all-th rows as headers, and no others", () => {
    const result = expectOk(
      readHtml(
        table("<tr><th>A</th><th>B</th></tr><tr><th>row</th><td>1</td></tr><tr><th>C</th><th>D</th></tr>")
      )
    );
    expect(result.spec.headerRows).toEqual([["A", "B"]]);
    expect(result.spec.rows).toEqual([["row", "1"], ["C", "D"]]);
  });

  it("does not turn a table of only th cells into headers with no body", () => {
    const result = expectOk(readHtml(table(`<tr><th>A</th><th>B</th></tr>`)));
    expect(result.spec.headerRows).toBeUndefined();
    expect(result.spec.rows).toEqual([["A", "B"]]);
  });

  it("collapses whitespace, turns NBSP to a space, and breaks lines at br and blocks", () => {
    const result = expectOk(
      readHtml(
        table(
          "<tr><td>  a \n  b&nbsp;&nbsp;c<br>d<p>e</p><div>f</div>" +
            "<ul><li>g</li><li>h</li></ul> </td><td></td></tr>"
        )
      )
    );
    expect(result.spec.rows).toEqual([["a b c\nd\ne\nf\ng\nh", ""]]);
  });

  it("reads formatting from tags and inline styles and ignores script, style and comments", () => {
    const html = table(
      `<tr><td><strong>B</strong><em>I</em><span style="font-weight:700">W</span>` +
        `<span style="font-style:italic">S</span><span style="vertical-align:sub">x</span>` +
        `<sup>2</sup><a href="#">link</a><script>alert(1)</script><style>p{}</style><!--c-->` +
        `</td><td></td></tr>`
    );
    expect(expectOk(readHtml(html)).spec.rows).toEqual([
      [
        {
          text: "BIWSx2link",
          spans: [
            { text: "B", bold: true },
            { text: "I", italic: true },
            { text: "W", bold: true },
            { text: "S", italic: true },
            { text: "x", script: "subscript" },
            { text: "2", script: "superscript" },
            { text: "link" }
          ]
        },
        ""
      ]
    ]);
  });

  it("lets font-weight:normal on a bold tag cancel it, and ignores mso-bidi properties", () => {
    const html = table(
      `<tr><td><b style="font-weight:normal">n</b>` +
        `<span style="mso-bidi-font-weight:bold;mso-bidi-font-style:italic">m</span></td><td></td></tr>`
    );
    expect(expectOk(readHtml(html)).spec.rows).toEqual([["nm", ""]]);
  });
});

describe("alignment", () => {
  const column = (cells: string[], attribute = "") => {
    const rows = cells.map((cell) => `<tr><td ${attribute}>${cell}</td><td>k</td></tr>`).join("");
    return expectOk(readHtml(table(rows))).spec.columns[0].align;
  };

  it("uses the majority explicit alignment and defaults to left", () => {
    expect(column(["a", "b"])).toBe("left");
    expect(column(["a", "b"], "align=right")).toBe("right");
    expect(column(["a", "b"], 'style="text-align:center"')).toBe("center");
    const mixed = expectOk(
      readHtml(table(`<tr><td align=right>a</td></tr><tr><td align=right>b</td></tr><tr><td>c</td></tr>`))
    );
    expect(mixed.spec.columns[0].align).toBe("right");
  });

  it("makes a column of plain numbers and dashes decimal", () => {
    expect(column(["58.08", "1,234.5", "-0.5", "+3", "—", "–", "-", ""])).toBe("decimal");
    expect(column(["1", "2"], "align=right")).toBe("decimal");
  });

  it("does not make a column decimal for text, units, only dashes, or a bare number-less column", () => {
    expect(column(["58.08", "n/a"])).toBe("left");
    expect(column(["58.08 g", "1"])).toBe("left");
    expect(column(["—", "—"])).toBe("left");
    expect(column(["1.2.3", "4"])).toBe("left");
    expect(column(["1,23", "4"])).toBe("left");
  });

  it("measures decimal columns on body rows, not headers", () => {
    const result = expectOk(readHtml(withHead));
    expect(result.spec.columns).toEqual([{ align: "decimal" }]);
  });
});

describe("HTML limits", () => {
  it("counts characters across header and body cells before building a table", () => {
    const row = `<tr><td>${"x".repeat(1000)}</td><td>${"y".repeat(1000)}</td></tr>`;
    const html = `<table><thead>${row}</thead><tbody>${row.repeat(99)}</tbody></table>`;
    const boundary = expectOk(readHtml(html));
    expect(() => TableSpecSchema.parse(boundary.spec)).not.toThrow();
    expect(readHtml(html.replace("<td>x", "<td>xx"))).toEqual({
      ok: false,
      reason: "This table has 200,001 characters; ChemDraft tables hold at most 200,000."
    });
  });

  it("refuses too many formatted spans in a cell and accepts the boundary", () => {
    const runs = (count: number) => Array.from({ length: count }, (_, i) =>
      i % 2 ? "<i>x</i>" : "<b>x</b>").join("");
    expectOk(readHtml(table(`<tr><td>${runs(200)}</td><td></td></tr>`)));
    expect(readHtml(table(`<tr><td>${runs(201)}</td><td></td></tr>`))).toEqual({
      ok: false,
      reason: "The cell in row 1, column 1 has 201 spans; ChemDraft table cells hold at most 200."
    });
  });

  it("refuses too many rows, naming the limit and the size", () => {
    const rows = Array.from({ length: 501 }, () => "<tr><td>a</td></tr>").join("");
    expect(readHtml(table(rows))).toEqual({
      ok: false,
      reason: "The table has 501 rows; ChemDraft tables hold at most 500."
    });
    expect(expectOk(readHtml(table(rows.replace("<tr><td>a</td></tr>", ""))))).toBeTruthy();
  });

  it("refuses too many columns", () => {
    const cells = Array.from({ length: 65 }, () => "<td>a</td>").join("");
    expect(readHtml(table(`<tr>${cells}</tr>`))).toEqual({
      ok: false,
      reason: "The table has 65 columns; ChemDraft tables hold at most 64."
    });
    expect(readHtml(table(`<tr><td colspan=1000>a</td></tr>`))).toEqual({
      ok: false,
      reason: "The table has 1000 columns; ChemDraft tables hold at most 64."
    });
  });

  it("refuses an over-long cell and accepts one at the limit", () => {
    expect(readHtml(table(`<tr><td>a</td><td>${"x".repeat(2001)}</td></tr>`))).toEqual({
      ok: false,
      reason: "The cell in row 1, column 2 has 2001 characters; ChemDraft table cells hold at most 2000."
    });
    expectOk(readHtml(table(`<tr><td>${"x".repeat(2000)}</td><td></td></tr>`)));
  });
});

describe("TSV tables", () => {
  it("refuses an Excel-sized range over the total character cap", () => {
    const row = Array.from({ length: 64 }, () => "1234567").join("\t");
    expect(readClipboardTsvTable(Array.from({ length: 500 }, () => row).join("\n"))).toEqual({
      ok: false,
      reason: "This table has 224,000 characters; ChemDraft tables hold at most 200,000."
    });
    const boundary = Array.from({ length: 100 }, () => `${"x".repeat(1000)}\t${"y".repeat(1000)}`)
      .join("\n");
    expectOk(readClipboardTsvTable(boundary));
  });

  it("reads Excel text with quoted tabs, newlines and doubled quotes", () => {
    const result = expectOk(readClipboardTsvTable(fixture("excel-quoted.tsv")));
    expect(result.source).toBe("tsv");
    expect(result.warnings).toEqual([]);
    expect(result.spec).toEqual({
      columns: [left, left, left],
      rows: [
        ["Material", "MW (g/mol)", "Note"],
        ["allyl alcohol", "58.08", "first line\nsecond line"],
        ["Ti(OiPr)4", "284.22", "has a\ttab"],
        ["(+)-DET", "206.19", 'says "neat"'],
        ["TBHP", "90.12", ""]
      ]
    });
  });

  it("accepts CRLF lines and one trailing empty line, and detects decimal columns", () => {
    const result = expectOk(readClipboardTsvTable("a\t1.5\r\nb\t2\r\nc\t—\r\n\r\n"));
    expect(result.spec.columns).toEqual([left, { align: "decimal" }]);
    expect(result.spec.rows).toEqual([["a", "1.5"], ["b", "2"], ["c", "—"]]);
    expect(result.spec.headerRows).toBeUndefined();
  });

  it("is not a table for one column or one line, and refuses unsafe table shapes", () => {
    expect(readClipboardTsvTable("one\ntwo\nthree")).toBeUndefined();
    expect(readClipboardTsvTable("a\tb")).toBeUndefined();
    expectRefusal(readClipboardTsvTable("a\tb\nc"), /at least two rows/);
    expectRefusal(readClipboardTsvTable("a\tb\nc\td\te"), /different numbers of columns/);
    expectRefusal(readClipboardTsvTable('a\tb\n"c\td'), /malformed quoted field/);
    expectRefusal(readClipboardTsvTable('a\tb\n"c"junk\td'), /malformed quoted field/);
    expectRefusal(readClipboardTsvTable("a\tb\nc\td\nfootnote\ne\tf\ng\th"), /separated tab-separated blocks/);
    expectRefusal(readClipboardTsvTable("a\tb\n\nc\td"), /separated tab-separated blocks/);
    expect(readClipboardTsvTable("")).toBeUndefined();
  });

  it("is not a table for a SMILES list", () => {
    const text = "CCO\nc1ccccc1\nCC(=O)O";
    expect(smilesListDecision).toBeTypeOf("function");
    expect(readClipboardTsvTable(text)).toBeUndefined();
  });

  it("refuses over-limit sizes", () => {
    const wide = Array.from({ length: 65 }, () => "a").join("\t");
    expect(readClipboardTsvTable(`${wide}\n${wide}`)).toEqual({
      ok: false,
      reason: "The table has 65 columns; ChemDraft tables hold at most 64."
    });
    const tall = Array.from({ length: 501 }, () => "a\tb").join("\n");
    expect(readClipboardTsvTable(tall)).toEqual({
      ok: false,
      reason: "The table has 501 rows; ChemDraft tables hold at most 500."
    });
    expect(readClipboardTsvTable(`a\t${"x".repeat(2001)}\nb\tc`)).toEqual({
      ok: false,
      reason: "The cell in row 1, column 2 has 2001 characters; ChemDraft table cells hold at most 2000."
    });
  });
});

describe("every imported spec is a valid table spec", () => {
  const results: Array<[string, ClipboardTableResult | undefined]> = [
    ["excel", readHtml(fixture("excel-like.html"))],
    ["excel internal markers", readHtml(fixture("excel-markers-inside-table.html"))],
    ["word", readHtml(fixture("word-like.html"))],
    ["word cf_html", readHtml(fixture("word-like.cfhtml.txt"), "HTML Format")],
    ["word notes html", readHtml(fixture("word-like-notes.html"))],
    ["word notes tsv", readClipboardTsvTable(fixture("word-like-notes.tsv"))],
    ["excel tsv", readClipboardTsvTable(fixture("excel-like.tsv"))],
    ["google docs", readHtml(fixture("google-docs-like.html"))],
    ["google sheets", readHtml(fixture("google-sheets-like.html"))],
    ["thead", readHtml(withHead)],
    ["tsv", readClipboardTsvTable(fixture("excel-quoted.tsv"))]
  ];

  it.each(results)("%s", (_name, result) => {
    const ok = expectOk(result);
    expect(() => TableSpecSchema.parse(ok.spec)).not.toThrow();
    expect(TableSpecSchema.parse(ok.spec)).toEqual(ok.spec);
  });
});
