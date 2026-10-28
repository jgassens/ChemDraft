import {
  DefaultNativeTextStyle,
  nativeTextStyleFromObjectStyle,
  type NativeTextStyle,
  type TableObject,
  type TextSpan
} from "@chemdraft/chem-core";
import { planTableLayout, type TableLayout } from "@chemdraft/layout-engine";

/** Select the document font or let the paste destination choose its own font and size. */
export interface TableClipboardOptions {
  font?: "document" | "inherit";
}

/** Editable table representations and any layout compromises made while copying. */
export interface TableClipboardPayloads {
  html: string;
  rtf: string;
  tsv: string;
  warnings: string[];
}

type Lines = TableLayout["cells"][number]["lines"];
type Side = "top" | "bottom" | "left" | "right";
const sides: Side[] = ["top", "bottom", "left", "right"];
const rtfSides = { top: "t", bottom: "b", left: "l", right: "r" };
const numberPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

function numeric(value: number): string {
  return String(Number(value.toFixed(4)));
}

function htmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fontInfo(style: NativeTextStyle): { family: string; serif: boolean } {
  const family = style.fontFamily.split(",")[0].trim().replace(/^['"]|['"]$/g, "");
  const serif = /\b(times|georgia|garamond|cambria|baskerville|palatino|serif)\b/i.test(family)
    && !/sans/i.test(family);
  return { family, serif };
}

function htmlFont(style: NativeTextStyle, options: TableClipboardOptions, scale = 1): string {
  if (options.font === "inherit") return "";
  const { family, serif } = fontInfo(style);
  const escaped = family.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `;font-family:${htmlEscape(`'${escaped}'`)},${serif ? "serif" : "sans-serif"}`
    + `;font-size:${numeric(style.fontSizePx * 0.75 * scale)}pt`;
}

function spanColor(run: TextSpan): string | undefined {
  let value = typeof run.style.color === "string" ? run.style.color : "";
  if (/^#[\da-f]{3}$/i.test(value)) {
    value = "#" + [...value.slice(1)].map(digit => digit + digit).join("");
  }
  value = value.toLowerCase();
  if (/^#[\da-f]{6}$/.test(value) && value !== DefaultNativeTextStyle.color) return value;
  return undefined;
}

function lineRuns(line: Lines[number], style: NativeTextStyle): TextSpan[] {
  const runs: TextSpan[] = [];
  for (const run of line.pieces.flatMap(piece => piece.runs)) {
    const previous = runs[runs.length - 1];
    const formatting = {
      fontWeight: Number(run.style.fontWeight ?? style.fontWeight) >= 600 ? 700 : 400,
      fontStyle: (run.style.fontStyle ?? style.fontStyle) === "italic" ? "italic" : "normal",
      color: spanColor(run)
    };
    if (previous && previous.script === run.script
      && previous.style.fontWeight === formatting.fontWeight
      && previous.style.fontStyle === formatting.fontStyle && previous.style.color === formatting.color) {
      previous.text += run.text;
    } else runs.push({ text: run.text, script: run.script, style: formatting });
  }
  return runs;
}

function htmlRun(run: TextSpan, style: NativeTextStyle): string {
  let text = htmlEscape(run.text).replace(/\t/g, "&#9;");
  const color = spanColor(run);
  if (color) text = `<span style="color:${color}">${text}</span>`;
  if ((run.style.fontStyle ?? style.fontStyle) === "italic") text = `<i>${text}</i>`;
  if (Number(run.style.fontWeight ?? style.fontWeight) >= 600) text = `<b>${text}</b>`;
  if (run.script === "subscript") text = `<sub>${text}</sub>`;
  if (run.script === "superscript") text = `<sup>${text}</sup>`;
  return text;
}

function htmlLines(lines: Lines, style: NativeTextStyle): string {
  return lines.map(line => lineRuns(line, style).map(run => htmlRun(run, style)).join("")).join("<br>");
}

function equalDecimalPlaces(table: TableObject, column: number): boolean {
  const values = table.rows.slice(table.headerRowCount).map(row => row.cells[column].text)
    .filter(text => text.length > 0);
  return values.length > 0 && values.every(text => numberPattern.test(text))
    && new Set(values.map(text => (text.split(".")[1] ?? "").length)).size === 1;
}

function cellAlignment(table: TableObject, layout: TableLayout, row: number, column: number) {
  const align = table.columns[column].align;
  if (align !== "decimal") return { align: align === "unknown" ? "left" : align };
  if (row < table.headerRowCount) return { align: "center" as const };
  const block = layout.columns[column].decimalBlock!;
  if (equalDecimalPlaces(table, column)) return { align: "right" as const, insetRight: block.insetRight };
  return {
    align: "left" as const,
    insetLeft: block.insetLeft,
    decimalOffset: block.preWidth
  };
}

function cellBorders(layout: TableLayout, row: number, column: number): Record<Side, number> {
  const box = { ...layout.columns[column], ...layout.rows[row] };
  const edges = {
    top: [box.x, box.y, box.x + box.width, box.y],
    bottom: [box.x, box.y + box.height, box.x + box.width, box.y + box.height],
    left: [box.x, box.y, box.x, box.y + box.height],
    right: [box.x + box.width, box.y, box.x + box.width, box.y + box.height]
  };
  const result = { top: 0, bottom: 0, left: 0, right: 0 };
  const near = (a: number, b: number) => Math.abs(a - b) < 0.00001;
  for (const side of sides) {
    const [x1, y1, x2, y2] = edges[side];
    for (const rule of layout.rules) {
      const horizontal = side === "top" || side === "bottom";
      const matches = horizontal
        ? near(rule.y1, y1) && near(rule.y2, y2) && rule.x1 <= x1 && rule.x2 >= x2
        : near(rule.x1, x1) && near(rule.x2, x2) && rule.y1 <= y1 && rule.y2 >= y2;
      if (matches) result[side] = rule.widthPx * 0.75;
    }
  }
  // A header separator belongs to the header's bottom edge, never the body's top edge.
  if (row > 0 && layout.rules.every(rule => rule.x1 !== rule.x2)) result.top = 0;
  return result;
}

function htmlTable(table: TableObject, layout: TableLayout, options: TableClipboardOptions): string {
  const style = nativeTextStyleFromObjectStyle(table.style);
  const padding = table.tableStyle.cellPaddingPx;
  const pad = `${numeric(padding.y * 0.75)}pt ${numeric(padding.x * 0.75)}pt`;
  const note = (lines: Lines, caption: boolean) => {
    const margin = caption ? "margin:0 0 4pt 0" : "margin:4pt 0 0 0";
    return `<p style="${margin};line-height:normal${htmlFont(style, options, 0.9)}">`
      + htmlLines(lines, style) + "</p>";
  };
  let html = layout.captionBox ? note(layout.captionBox.lines, true) : "";
  html += `<table border="0" cellspacing="0" cellpadding="0" width="${Math.round(layout.bodyBox.width)}"`
    + ` style="width:${numeric(layout.bodyBox.width * 0.75)}pt;border-collapse:collapse;border:none;`
    + `mso-border-alt:none;mso-table-layout-alt:fixed;mso-padding-alt:${pad} ${pad}">`;
  for (let row = 0; row < table.rows.length; row++) {
    if (row === 0 && table.headerRowCount > 0) html += "<thead>";
    if (row === table.headerRowCount) html += "<tbody>";
    html += row === 0 && table.headerRowCount > 0 ? '<tr style="mso-yfti-firstrow:yes">' : "<tr>";
    for (let column = 0; column < table.columns.length; column++) {
      const width = layout.columns[column].width;
      const borders = cellBorders(layout, row, column);
      const alignment = cellAlignment(table, layout, row, column);
      const header = row < table.headerRowCount;
      const text = table.rows[row].cells[column].text;
      let cellStyle = `width:${numeric(width * 0.75)}pt;padding:${pad} ${pad}`;
      if (alignment.insetRight !== undefined) {
        cellStyle += `;padding-right:${numeric((padding.x + alignment.insetRight) * 0.75)}pt`;
      }
      if (alignment.insetLeft !== undefined) {
        cellStyle += `;padding-left:${numeric((padding.x + alignment.insetLeft) * 0.75)}pt`;
      }
      for (const side of sides) {
        const border = borders[side];
        cellStyle += `;border-${side}:${border > 0 ? `solid windowtext ${numeric(border)}pt` : "none"}`;
        if (border > 0) cellStyle += `;mso-border-${side}-alt:solid windowtext ${numeric(border)}pt`;
      }
      if (!header && table.columns[column].align === "decimal" &&
        /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(text)) {
        const decimals = (text.split(".")[1] ?? "").length;
        const format = decimals > 0 ? `0\\.${"0".repeat(decimals)}` : "0";
        cellStyle += `;mso-number-format:'${format}'`;
      }
      const tab = alignment.decimalOffset;
      const tabStyle = tab === undefined ? "" : `;tab-stops:decimal ${numeric(tab * 0.75)}pt`;
      const cell = layout.cells[row * table.columns.length + column];
      html += `<td width="${Math.round(width)}"${header ? ' valign="bottom"' : ""} style="${cellStyle}">`
        + `<p style="margin:0;line-height:normal;text-align:${alignment.align}${tabStyle}`
        + `${htmlFont(style, options)}">`
        + htmlLines(cell.lines, style) + "</p></td>";
    }
    html += "</tr>";
    if (row + 1 === table.headerRowCount) html += "</thead>";
  }
  if (table.headerRowCount < table.rows.length) html += "</tbody>";
  html += "</table>";
  return html + layout.footnoteBoxes.map(box => note(box.lines, false)).join("");
}

// Windows-1252's defined non-Latin-1 characters, indexed by their fallback byte (0x80–0x9f).
const cp1252 = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";

function rtfEscape(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    const char = value[index];
    if (char === "\\" || char === "{" || char === "}") result += `\\${char}`;
    else if (char === "\t") result += "\\tab ";
    else if (code < 128) result += char;
    else {
      const extended = cp1252.indexOf(char);
      const byte = code >= 160 && code <= 255 ? code : extended >= 0 ? extended + 128 : undefined;
      const fallback = byte === undefined ? "?" : `\\'${byte.toString(16).padStart(2, "0")}`;
      result += `\\u${code > 32767 ? code - 65536 : code}${fallback}`;
    }
  }
  return result;
}

function rtfTable(table: TableObject, layout: TableLayout, options: TableClipboardOptions): string {
  const style = nativeTextStyleFromObjectStyle(table.style);
  const { family, serif } = fontInfo(style);
  const colors: string[] = [];
  const allLines = [layout.captionBox?.lines ?? [], ...layout.cells.map(cell => cell.lines),
    ...layout.footnoteBoxes.map(box => box.lines)];
  for (const lines of allLines) {
    for (const line of lines) {
      for (const piece of line.pieces) {
        for (const run of piece.runs) {
          const color = spanColor(run);
          if (color && !colors.includes(color)) colors.push(color);
        }
      }
    }
  }
  const font = (scale = 1) => options.font === "inherit" ? ""
    : `\\f0\\fs${Math.round(style.fontSizePx * 0.75 * 2 * scale)}`;
  let result = "{\\rtf1\\ansi\\ansicpg1252";
  if (options.font !== "inherit") result += "\\deff0";
  result += "\\uc1";
  if (options.font !== "inherit") {
    result += `{\\fonttbl{\\f0\\${serif ? "froman" : "fswiss"}\\fcharset0 `
      + `${rtfEscape(family).replace(/;/g, "\\u59?")};}}`;
  }
  result += "{\\colortbl;" + colors.map(color => {
    const rgb = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16));
    return `\\red${rgb[0]}\\green${rgb[1]}\\blue${rgb[2]};`;
  }).join("") + "}";
  const runText = (run: TextSpan) => {
    const text = rtfEscape(run.text);
    const color = spanColor(run);
    let format = "";
    if (Number(run.style.fontWeight ?? style.fontWeight) >= 600) format += "\\b";
    if ((run.style.fontStyle ?? style.fontStyle) === "italic") format += "\\i";
    if (color) format += `\\cf${colors.indexOf(color) + 1}`;
    if (run.script === "subscript") format += "\\sub";
    if (run.script === "superscript") format += "\\super";
    return format ? `{${format} ${text}}` : text;
  };
  const linesText = (lines: Lines, decimalTab = false) => lines.map(line =>
    (decimalTab ? "\\tab " : "") + lineRuns(line, style).map(runText).join("")).join("\\line ");
  if (layout.captionBox) {
    result += `\\pard\\plain\\sa80\\sb0${font(0.9)} ${linesText(layout.captionBox.lines)}\\par\n`;
  }
  const padx = Math.round(table.tableStyle.cellPaddingPx.x * 15);
  const pady = Math.round(table.tableStyle.cellPaddingPx.y * 15);
  for (let row = 0; row < table.rows.length; row++) {
    result += `\\trowd\\trgaph${padx}\\trleft0\\trpaddl${padx}\\trpaddr${padx}`
      + `\\trpaddt${pady}\\trpaddb${pady}\\trpaddfl3\\trpaddfr3\\trpaddft3\\trpaddfb3`;
    if (row < table.headerRowCount) result += "\\trhdr";
    if (row === table.rows.length - 1) result += "\\lastrow";
    for (let column = 0; column < table.columns.length; column++) {
      const borders = cellBorders(layout, row, column);
      for (const side of sides) {
        if (borders[side] > 0) result += `\\clbrdr${rtfSides[side]}\\brdrs`
          + `\\brdrw${Math.round(borders[side] * 20)}\\brdrcf0`;
      }
      if (row < table.headerRowCount) result += "\\clvertalb";
      const alignment = cellAlignment(table, layout, row, column);
      if (alignment.insetRight !== undefined) {
        result += `\\clpadr${Math.round((table.tableStyle.cellPaddingPx.x + alignment.insetRight) * 15)}`
          + "\\clpadfr3";
      }
      // Word swaps per-cell left and top padding, so encode the left inset in the tab stop instead.
      const planned = layout.columns[column];
      result += `\\cellx${Math.round((planned.x + planned.width - layout.bodyBox.x) * 15)}`;
    }
    for (let column = 0; column < table.columns.length; column++) {
      const alignment = cellAlignment(table, layout, row, column);
      const tab = alignment.decimalOffset;
      result += `\\pard\\plain\\intbl\\q${alignment.align[0]}\\sa0\\sb0\\sl240\\slmult1`;
      if (tab !== undefined) result += `\\tqdec\\tx${Math.round((tab + (alignment.insetLeft ?? 0)) * 15)}`;
      const cell = layout.cells[row * table.columns.length + column];
      result += `${font()} ${linesText(cell.lines, tab !== undefined)}\\cell`;
    }
    result += "\\row\n";
  }
  for (const box of layout.footnoteBoxes) {
    result += `\\pard\\plain\\sa0\\sb80${font(0.9)} ${linesText(box.lines)}\\par\n`;
  }
  return result + "}";
}

/** Serialize an editable Office-compatible HTML table inside native clipboard fragment markers. */
export function exportTableToHtml(table: TableObject, options: TableClipboardOptions = {}): string {
  return '<html xmlns:o="urn:schemas-microsoft-com:office:office"'
    + ' xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"></head>'
    + '<body><!--StartFragment-->' + htmlTable(table, planTableLayout(table), options)
    + '<!--EndFragment--></body></html>';
}

/** Serialize an editable RTF table using ASCII-safe Unicode escapes and layout-derived twips. */
export function exportTableToRtf(table: TableObject, options: TableClipboardOptions = {}): string {
  return rtfTable(table, planTableLayout(table), options);
}

/** Serialize plain cell text as spreadsheet-ready TSV, excluding captions and footnotes. */
export function exportTableToTsv(table: TableObject): string {
  return table.rows.map(row => row.cells.map(cell => /[\t\n\r"]/.test(cell.text)
    ? `"${cell.text.replace(/"/g, '""')}"` : cell.text).join("\t")).join("\n");
}

/** Build all clipboard strings without clipboard access, reporting unrotated and narrow-column copies. */
export function exportTableClipboardPayloads(
  table: TableObject,
  options: TableClipboardOptions = {}
): TableClipboardPayloads {
  const warnings: string[] = [];
  if (table.rotation % 360 !== 0) warnings.push("A rotated table is copied unrotated.");
  if (table.columns.some(column => column.width.mode === "fixed")) {
    const natural = planTableLayout({
      ...table,
      columns: table.columns.map(column => ({ ...column, width: { mode: "auto" as const } }))
    });
    table.columns.forEach((column, index) => {
      if (column.width.mode === "fixed" && column.width.px < natural.columns[index].width) {
        warnings.push(`Fixed-width column "${column.id}" is narrower than its content.`);
      }
    });
  }
  return {
    html: exportTableToHtml(table, options),
    rtf: exportTableToRtf(table, options),
    tsv: exportTableToTsv(table),
    warnings
  };
}
