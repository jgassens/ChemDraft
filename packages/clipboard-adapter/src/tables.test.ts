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
  it("reads the Excel-like table: plain cells, explicit alignment, no header rows", () => {
    const result = expectOk(readHtml(fixture("excel-like.html")));
    expect(result.source).toBe("html");
    expect(result.warnings).toEqual([]);
    expect(result.spec).toEqual({
      columns: [left, right, right, right, right, left, right],
      rows: [
        ["Material", "MW (g/mol)", "Density (g/mL)", "Equiv.", "mmol", "Mass (g)", "Volume (mL)"],
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
    expect(result).toEqual(expectOk(readHtml(fixture("excel-like.html"))));
  });

  const wordSpec = {
    columns: [left, right, right],
    rows: [
      [bold("Material"), bold("MW (g/mol)"), bold("Density (g/mL)")],
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
      columns: [left, right, left],
      rows: [
        ["Material", "MW (g/mol)", "mmol"],
        ["allyl alcohol", "58.08", "17.22"],
        ["TBHP", "90.12", "34.44"],
        ["CH2Cl2", "84.93", ""]
      ]
    });
  });
});

describe("Excel overflow recovery", () => {
  it("extracts overflowing Excel boundary notes and recovers Density from the full CR-only TSV grid", () => {
    const html = fixture("excel-overflow-notes.html");
    const tsv = fixture("excel-overflow-notes.tsv");
    expect(html).not.toContain("x:num");
    expect(tsv).toContain("\t\t\t\t\t\t\r");
    expect(tsv).not.toContain("\n");
    const result = expectOk(readHtmlAndTsv(html, tsv));
    expect(result.spec.columns).toHaveLength(7);
    expect(result.spec.rows).toHaveLength(6);
    expect(result.spec.rows[1][2]).toBe("0.854");
    expect(result.spec.rows[3][2]).toBe("1.204");
    expect(result.spec.caption).toBe("Table S1. Sharpless reagent quantities (synthetic).");
    expect(result.spec.footnotes).toEqual([{ text: "a TBHP stock solution; synthetic example.", spans: [
      { text: "a", script: "superscript" }, { text: " TBHP stock solution; synthetic example." }
    ] }]);
    expect(result.warnings).toEqual([]);
    expect(TableSpecSchema.parse(result.spec)).toEqual(result.spec);
  });

  it.each(["caption", "footnote", "body", "dimensions"])("does not recover Excel values when the full TSV %s differs", part => {
    let tsv = fixture("excel-overflow-notes.tsv");
    if (part === "caption") tsv = tsv.replace("Table S1.", "Different caption.");
    if (part === "footnote") tsv = tsv.replace("TBHP stock solution", "Unrelated stock solution");
    if (part === "body") tsv = tsv.replace("allyl alcohol", "Unrelated reagent");
    if (part === "dimensions") tsv += "Extra\trow\t\t\t\t\t\r";
    const result = expectOk(readHtmlAndTsv(fixture("excel-overflow-notes.html"), tsv));
    expect(result.spec.rows[1][2]).toBe("#######");
    expect(result.spec.rows[3][2]).toBe("#######");
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.every(warning => warning.includes("overflow"))).toBe(true);
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
    expect(result.spec.rows[1][2]).toBe("0.854");
    expect(result.spec.rows[3][2]).toBe("1.204");
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
    expect(result.spec.rows[1][1]).toBe("0.854");
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
    expect(result.spec.rows).toEqual([
      ["Material", "Density (g/mL)"], ["allyl alcohol", "0.854"],
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
