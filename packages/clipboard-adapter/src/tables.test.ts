// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TABLE_LIMITS } from "@chemdraft/chem-core";
import { TableSpecSchema } from "@chemdraft/document-workflow-core";
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

function bold(text: string) {
  return { text, spans: [{ text, bold: true }] };
}

const withHead = "<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1.5</td></tr></tbody></table>";
const left = { align: "left" } as const;
const right = { align: "right" } as const;

describe("limits", () => {
  it("match the native table limits", () => {
    expect(TABLE_LIMITS).toMatchObject({ maxRows: 500, maxColumns: 64, maxCellCharacters: 2000 });
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

describe("what counts as a table", () => {
  it("leaves a single HTML cell to the text path", () => {
    expect(readHtml(table("<tr><td>allyl alcohol</td></tr>"))).toBeUndefined();
  });

  it("is not a table when text sits beside it", () => {
    const lone = "<table><tr><td>a</td><td>b</td></tr></table>";
    expect(readHtml(`<p>See the table below.</p>${lone}`)).toBeUndefined();
    expect(readHtml(`<table><tr><td>a</td></tr></table><p>Footnote</p>`)).toBeUndefined();
  });

  it("is not a table with no table, or with two", () => {
    expect(readHtml("<p>just text</p>")).toBeUndefined();
    expect(readHtml("<table><tr><td>a</td></tr></table><table><tr><td>b</td></tr></table>")).toBeUndefined();
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
    expect(readHtml(`<!--StartFragment--><p>inside</p>${bare}<!--EndFragment-->`)).toBeUndefined();
  });

  it("refuses prose or another table outside an Excel table with internal markers", () => {
    const html = fixture("excel-markers-inside-table.html");
    for (const extra of ["<p>Prose</p>", bare]) {
      expect(readHtml(html.replace(/(<body[^>]*>)/, `$1${extra}`))).toBeUndefined();
      expect(readHtml(html.replace("</body>", `${extra}</body>`))).toBeUndefined();
    }
  });

  it("does not use a table that does not contain the fragment start", () => {
    expect(readHtml(`${bare}<!--StartFragment--><!--EndFragment-->`)).toBeUndefined();
    expect(readHtml(`<!--StartFragment--><!--EndFragment-->${bare}`)).toBeUndefined();
  });
});

describe("table structure", () => {
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

  it("is not a table for one column, one line, uneven lines, or a broken quote", () => {
    expect(readClipboardTsvTable("one\ntwo\nthree")).toBeUndefined();
    expect(readClipboardTsvTable("a\tb")).toBeUndefined();
    expect(readClipboardTsvTable("a\tb\nc")).toBeUndefined();
    expect(readClipboardTsvTable("a\tb\nc\td\te")).toBeUndefined();
    expect(readClipboardTsvTable('a\tb\n"c\td')).toBeUndefined();
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
