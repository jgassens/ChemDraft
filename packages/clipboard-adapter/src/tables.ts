// Detects a table on the clipboard (Office/Google HTML or Excel-style TSV) and converts it to a table spec.
// The output has the input shape of TableSpecSchema in document-workflow-core, which this package must not
// import; tables.test.ts parses every result with that schema.

import { isTextLikeType, type ClipboardReadPayload } from "./index";

export type ClipboardTableAlign = "left" | "center" | "right" | "decimal";

/** One formatted run of a cell; absent flags mean normal script, not bold, not italic. */
export interface ClipboardTableSpan {
  text: string;
  script?: "normal" | "subscript" | "superscript";
  bold?: boolean;
  italic?: boolean;
}

/** A cell is plain text, or text with formatted runs whose texts join to the cell text. */
export type ClipboardTableCell = string | { text: string; spans: ClipboardTableSpan[] };

/** A table in the shape the native table builder accepts. */
export interface ClipboardTableSpec {
  columns: Array<{ align: ClipboardTableAlign }>;
  rows: ClipboardTableCell[][];
  headerRows?: ClipboardTableCell[][];
  caption?: ClipboardTableCell;
  footnotes?: ClipboardTableCell[];
}

/** A detected table, or the reason a table-shaped clipboard cannot be imported. */
export type ClipboardTableResult =
  | { ok: true; spec: ClipboardTableSpec; warnings: string[]; source: "html" | "tsv" }
  | { ok: false; reason: string };

// Mirrors TABLE_LIMITS in chem-core; tables.test.ts asserts the two stay equal.
export const CLIPBOARD_TABLE_LIMITS = {
  maxColumns: 64, maxRows: 500, maxCellCharacters: 2000,
  maxTableCharacters: 200000, maxSpansPerCell: 200, maxFootnotes: 50
} as const;
const LIMITS = CLIPBOARD_TABLE_LIMITS;

const WARN_MERGED = "Merged cells were split into separate cells.";
const WARN_RAGGED = "Short rows were padded with empty cells.";
const WARN_NESTED = "Nested tables were flattened to text.";
const WARN_IMAGES = "Images in the table were not imported.";

const NUMBER_PATTERNS = [/^[+\-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/, /^[+\-−]?\.\d+$/];
const DASH_PATTERN = /^[-–—]$/;
const OVERFLOW_PATTERN = /^#+$/;
const EXCEL_NUMBER_PATTERN = /^[+\-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+\-]?\d+)?$/;

function overflowWarning(row: number, column: number): string {
  return `The cell in row ${row}, column ${column} contains Excel overflow text (#); `
    + "its value was unavailable in x:num and the matching TSV, so the overflow text was kept.";
}

function fail(reason: string): ClipboardTableResult {
  return { ok: false, reason };
}

function tooManyRows(count: number): ClipboardTableResult {
  return fail(`The table has ${count} rows; ChemDraft tables hold at most ${LIMITS.maxRows}.`);
}

function tooManyColumns(count: number): ClipboardTableResult {
  return fail(`The table has ${count} columns; ChemDraft tables hold at most ${LIMITS.maxColumns}.`);
}

function tooLongCell(row: number, column: number, length: number): ClipboardTableResult {
  return fail(
    `The cell in row ${row}, column ${column} has ${length} characters; ` +
      `ChemDraft table cells hold at most ${LIMITS.maxCellCharacters}.`
  );
}

function cellText(cell: ClipboardTableCell): string {
  return typeof cell === "string" ? cell : cell.text;
}

function tableCharacterRefusal(count: number): ClipboardTableResult | undefined {
  if (count <= LIMITS.maxTableCharacters) return undefined;
  return fail(`This table has ${count.toLocaleString("en-US")} characters; `
    + `ChemDraft tables hold at most ${LIMITS.maxTableCharacters.toLocaleString("en-US")}.`);
}

/** Captions and footnotes have the same text/run caps as cells and count toward the table total. */
function addTableNotes(
  result: Extract<ClipboardTableResult, { ok: true }>,
  leading: ClipboardTableCell[],
  trailing: ClipboardTableCell[]
): ClipboardTableResult {
  if (trailing.length > LIMITS.maxFootnotes) {
    return fail(`The table has ${trailing.length} footnotes; ChemDraft tables hold at most ${LIMITS.maxFootnotes}.`);
  }
  for (const [kind, notes] of [["caption paragraph", leading], ["footnote", trailing]] as const) {
    for (const [index, note] of notes.entries()) {
      if (cellText(note).length > LIMITS.maxCellCharacters) {
        return fail(`The ${kind} ${index + 1} has ${cellText(note).length} characters; `
          + `ChemDraft table cells hold at most ${LIMITS.maxCellCharacters}.`);
      }
      if (typeof note !== "string" && note.spans.length > LIMITS.maxSpansPerCell) {
        return fail(`The ${kind} ${index + 1} has ${note.spans.length} spans; `
          + `ChemDraft table cells hold at most ${LIMITS.maxSpansPerCell}.`);
      }
    }
  }
  const allCells = [...(result.spec.headerRows ?? []).flat(), ...result.spec.rows.flat(), ...leading, ...trailing];
  const refusal = tableCharacterRefusal(allCells.reduce((sum, cell) => sum + cellText(cell).length, 0));
  if (refusal) return refusal;
  return {
    ...result,
    spec: {
      ...result.spec,
      ...(leading.length ? { caption: leading[leading.length - 1] } : {}),
      ...(trailing.length ? { footnotes: trailing } : {})
    },
    warnings: [
      ...result.warnings,
      ...leading.slice(0, -1).map((note) => `The paragraph before the caption was not imported: ${JSON.stringify(cellText(note))}.`)
    ]
  };
}

function isNumberText(text: string): boolean {
  return NUMBER_PATTERNS.some((pattern) => pattern.test(text));
}

/** True when every non-empty cell is a plain number or a dash and at least one is a number. */
function isDecimalColumn(texts: string[]): boolean {
  let numbers = 0;
  for (const raw of texts) {
    const text = raw.trim();
    if (text === "") {
      continue;
    }
    if (isNumberText(text)) {
      numbers += 1;
    } else if (!DASH_PATTERN.test(text)) {
      return false;
    }
  }
  return numbers > 0;
}

// ---------------------------------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------------------------------

type Script = "normal" | "subscript" | "superscript";
interface Format {
  script: Script;
  bold: boolean;
  italic: boolean;
}
interface Piece {
  text: string;
  format: Format;
}
interface CellEntry {
  input: ClipboardTableCell;
  filler: boolean;
  overflow?: boolean;
  align?: ClipboardTableAlign;
}
interface RowSource {
  element: Element;
  groupEnd: number;
}

const PLAIN: Format = { script: "normal", bold: false, italic: false };
const SKIP_TAGS = new Set(["script", "style", "template", "head", "title", "meta", "link", "noscript"]);
const BLOCK_TAGS = new Set([
  "p", "div", "li", "ul", "ol", "dl", "dt", "dd", "tr", "table", "thead", "tbody", "tfoot", "caption",
  "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "section", "article", "center", "address"
]);
const MAX_COLSPAN = 1000;

function tagOf(element: Element): string {
  return element.localName.toLowerCase();
}

function styleProperty(element: Element, name: string): string | undefined {
  return declarationProperty(element.getAttribute("style"), name);
}

function declarationProperty(style: string | null, name: string): string | undefined {
  if (!style) {
    return undefined;
  }
  const match = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "i").exec(style);
  return match ? match[1].trim().toLowerCase() : undefined;
}

function isBoldWeight(value: string): boolean {
  if (value === "bold" || value === "bolder") {
    return true;
  }
  const weight = Number(value);
  return Number.isFinite(weight) && weight >= 600;
}

/** The format an element gives its content; inline styles override the element's own meaning. */
function childFormat(element: Element, inherited: Format): Format {
  const tag = tagOf(element);
  let { script, bold, italic } = inherited;
  if (tag === "b" || tag === "strong") {
    bold = true;
  }
  if (tag === "i" || tag === "em") {
    italic = true;
  }
  if (tag === "sub") {
    script = "subscript";
  } else if (tag === "sup") {
    script = "superscript";
  }
  const weight = styleProperty(element, "font-weight");
  if (weight !== undefined) {
    bold = isBoldWeight(weight);
  }
  const fontStyle = styleProperty(element, "font-style");
  if (fontStyle !== undefined) {
    italic = fontStyle === "italic" || fontStyle === "oblique";
  }
  const vertical = styleProperty(element, "vertical-align");
  if (vertical === "sub") {
    script = "subscript";
  } else if (vertical === "super") {
    script = "superscript";
  } else if (vertical === "baseline") {
    script = "normal";
  }
  return { script, bold, italic };
}

function sameFormat(a: Format, b: Format): boolean {
  return a.script === b.script && a.bold === b.bold && a.italic === b.italic;
}

function isPlainFormat(format: Format): boolean {
  return sameFormat(format, PLAIN);
}

/** Collects the runs of one cell with HTML whitespace collapsing and line breaks. */
class CellCollector {
  private pieces: Piece[] = [];
  nested = false;
  images = false;

  private lastChar(): string {
    for (let index = this.pieces.length - 1; index >= 0; index -= 1) {
      const text = this.pieces[index].text;
      if (text !== "") {
        return text[text.length - 1];
      }
    }
    return "";
  }

  private trimTrailingSpaces(): void {
    while (this.pieces.length > 0) {
      const last = this.pieces[this.pieces.length - 1];
      last.text = last.text.replace(/ +$/, "");
      if (last.text !== "") {
        return;
      }
      this.pieces.pop();
    }
  }

  text(raw: string, format: Format): void {
    let text = raw.replace(/[ \t\n\r\f ]+/g, " ");
    const last = this.lastChar();
    if (text.startsWith(" ") && (last === "" || last === " " || last === "\n")) {
      text = text.slice(1);
    }
    if (text !== "") {
      this.pieces.push({ text, format });
    }
  }

  newline(force: boolean): void {
    const last = this.lastChar();
    if (!force && (last === "" || last === "\n")) {
      return;
    }
    this.trimTrailingSpaces();
    this.pieces.push({ text: "\n", format: PLAIN });
  }

  walk(node: Node, inherited: Format): void {
    if (node.nodeType === 3) {
      this.text(node.nodeValue ?? "", inherited);
      return;
    }
    if (node.nodeType !== 1) {
      return;
    }
    const element = node as Element;
    const tag = tagOf(element);
    if (SKIP_TAGS.has(tag) || styleProperty(element, "display") === "none") {
      return;
    }
    if (tag === "img" || tag === "svg") {
      this.images = true;
      return;
    }
    if (tag === "br") {
      this.newline(true);
      return;
    }
    if (tag === "table") {
      this.nested = true;
    }
    const format = childFormat(element, inherited);
    const block = BLOCK_TAGS.has(tag);
    if (block) {
      this.newline(false);
    }
    for (const child of Array.from(element.childNodes)) {
      this.walk(child, format);
    }
    if (block) {
      this.newline(false);
    } else if (tag === "td" || tag === "th") {
      this.text(" ", inherited);
    }
  }

  /** Trimmed text, plain when no run is formatted, else the runs with merged neighbours. */
  finish(): ClipboardTableCell {
    const pieces = this.pieces.map((piece) => ({ ...piece }));
    while (pieces.length > 0) {
      pieces[0].text = pieces[0].text.replace(/^[ \n]+/, "");
      if (pieces[0].text !== "") {
        break;
      }
      pieces.shift();
    }
    while (pieces.length > 0) {
      const last = pieces[pieces.length - 1];
      last.text = last.text.replace(/[ \n]+$/, "");
      if (last.text !== "") {
        break;
      }
      pieces.pop();
    }
    const merged: Piece[] = [];
    for (const piece of pieces) {
      const previous = merged[merged.length - 1];
      if (previous && sameFormat(previous.format, piece.format)) {
        previous.text += piece.text;
      } else {
        merged.push(piece);
      }
    }
    const text = merged.map((piece) => piece.text).join("");
    if (merged.every((piece) => isPlainFormat(piece.format))) {
      return text;
    }
    return {
      text,
      spans: merged.map((piece) => ({
        text: piece.text,
        ...(piece.format.script !== "normal" ? { script: piece.format.script } : {}),
        ...(piece.format.bold ? { bold: true } : {}),
        ...(piece.format.italic ? { italic: true } : {})
      }))
    };
  }
}

function findHtmlText(payload: ClipboardReadPayload): string | undefined {
  const item = payload.textItems.find(
    (candidate) => candidate.type.toLowerCase().includes("html") && candidate.text.trim() !== ""
  );
  return item?.text;
}

/** Drops a CF_HTML header and keeps both the document and its marked fragment. */
function htmlFragment(text: string): { html: string; fragment: string } {
  let html = text;
  if (/^\s*Version:/i.test(html)) {
    const offset = Number(/^\s*StartHTML:\s*(\d+)/im.exec(html)?.[1]);
    if (Number.isInteger(offset) && offset > 0 && offset < html.length && html[offset] === "<") {
      html = html.slice(offset);
    } else {
      const first = html.indexOf("<");
      html = first >= 0 ? html.slice(first) : "";
    }
  }
  const startMarker = "<!--StartFragment-->";
  const endMarker = "<!--EndFragment-->";
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start >= 0 ? start : 0);
  if (start >= 0) {
    return { html, fragment: html.slice(start + startMarker.length, end >= 0 ? end : undefined) };
  }
  return { html, fragment: end >= 0 ? html.slice(0, end) : html };
}

function hasTableAncestor(element: Element): boolean {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (tagOf(parent) === "table") {
      return true;
    }
  }
  return false;
}

/** Only paragraphs around the table can be represented as a caption and footnotes. */
function tableNotes(root: Element, table: Element): {
  leading: ClipboardTableCell[]; trailing: ClipboardTableCell[]; unsafe: boolean;
} {
  const leading: ClipboardTableCell[] = [];
  const trailing: ClipboardTableCell[] = [];
  let after = false;
  let unsafe = false;
  const walk = (node: Node, format: Format): void => {
    if (node === table) {
      after = true;
      return;
    }
    if (node.nodeType === 3) {
      unsafe ||= /[^\s ]/.test(node.nodeValue ?? "");
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const tag = tagOf(element);
    if (SKIP_TAGS.has(tag) || styleProperty(element, "display") === "none") return;
    const inherited = childFormat(element, format);
    if (tag === "p" || (tag === "div" && !element.querySelector("p, div, table"))) {
      const collector = new CellCollector();
      for (const child of Array.from(element.childNodes)) collector.walk(child, inherited);
      const note = collector.finish();
      unsafe ||= collector.images || collector.nested;
      if (cellText(note) !== "") (after ? trailing : leading).push(note);
      return;
    }
    if (tag === "img" || tag === "svg") unsafe = true;
    for (const child of Array.from(element.childNodes)) walk(child, inherited);
  };
  walk(root, PLAIN);
  const caption = Array.from(table.children).find((child) => tagOf(child) === "caption");
  if (caption) {
    const collector = new CellCollector();
    for (const child of Array.from(caption.childNodes)) collector.walk(child, childFormat(caption, PLAIN));
    const note = collector.finish();
    unsafe ||= collector.images || collector.nested;
    if (cellText(note) !== "") leading.push(note);
  }
  return { leading, trailing, unsafe };
}

/** Row sources in thead, tbody, tfoot order, each knowing where its row group ends. */
function collectRows(table: Element): { rows: RowSource[]; headCount: number } {
  const head: Element[][] = [];
  const body: Element[][] = [];
  const foot: Element[][] = [];
  let loose: Element[] = [];
  const flushLoose = (): void => {
    if (loose.length > 0) {
      body.push(loose);
      loose = [];
    }
  };
  const rowsOf = (section: Element): Element[] =>
    Array.from(section.children).filter((child) => tagOf(child) === "tr");
  for (const child of Array.from(table.children)) {
    const tag = tagOf(child);
    if (tag === "tr") {
      loose.push(child);
      continue;
    }
    if (tag === "thead" || tag === "tbody" || tag === "tfoot") {
      flushLoose();
      (tag === "thead" ? head : tag === "tfoot" ? foot : body).push(rowsOf(child));
    }
  }
  flushLoose();
  const rows: RowSource[] = [];
  for (const group of [...head, ...body, ...foot]) {
    const groupEnd = rows.length + group.length;
    for (const element of group) {
      rows.push({ element, groupEnd });
    }
  }
  return { rows, headCount: head.reduce((sum, group) => sum + group.length, 0) };
}

function cellsOf(row: Element): Element[] {
  return Array.from(row.children).filter((child) => tagOf(child) === "td" || tagOf(child) === "th");
}

/** Excel uses td cells with class-based top and bottom rules for a heading, not th/thead.
 * Read only its simple class rules; never load stylesheets or infer headers from cell contents.
 */
function excelHeaderTest(table: Element): (row: Element) => boolean {
  const document = table.ownerDocument;
  const excel = document.documentElement.getAttribute("xmlns:x") === "urn:schemas-microsoft-com:office:excel"
    || Array.from(document.querySelectorAll("meta")).some(meta =>
      meta.getAttribute("name")?.toLowerCase() === "progid" && meta.getAttribute("content") === "Excel.Sheet");
  const rules: Array<{ className: string; declarations: string }> = [];
  if (excel) {
    for (const style of Array.from(document.querySelectorAll("style"))) {
      for (const match of (style.textContent ?? "").matchAll(/(?:^|[}\s])\.([\w-]+)\s*\{([^{}]*)\}/g)) {
        rules.push({ className: match[1], declarations: match[2] });
      }
    }
  }
  const border = (cell: Element, name: string): boolean => {
    let value: string | undefined;
    for (const rule of rules) {
      if (cell.classList.contains(rule.className)) value = declarationProperty(rule.declarations, name) ?? value;
    }
    value = styleProperty(cell, name) ?? value;
    return value !== undefined && /\b(solid|double|dashed|dotted)\b/.test(value)
      && !/^0(?:[a-z]+)?(?:\s|$)/.test(value);
  };
  return row => {
    const cells = cellsOf(row);
    return excel && cells.length > 1 && cells.every(cell =>
      border(cell, "border-top") && border(cell, "border-bottom"));
  };
}

function spanAttribute(element: Element, name: string, fallback: number, max: number): number {
  const value = Number.parseInt(element.getAttribute(name) ?? "", 10);
  return Number.isFinite(value) && value >= 1 ? Math.min(value, max) : fallback;
}

function alignOf(element: Element): ClipboardTableAlign | undefined {
  const value = (styleProperty(element, "text-align") ?? element.getAttribute("align") ?? "")
    .trim()
    .toLowerCase();
  if (value === "left" || value === "start") {
    return "left";
  }
  if (value === "right" || value === "end") {
    return "right";
  }
  if (value === "center" || value === "middle") {
    return "center";
  }
  return undefined;
}

/** The cell's alignment, else its first paragraph's (Word and Docs align paragraphs), else its row's. */
function cellAlign(cell: Element, row: Element): ClipboardTableAlign | undefined {
  const paragraph = Array.from(cell.children).find((child) => ["p", "div"].includes(tagOf(child)));
  return alignOf(cell) ?? (paragraph ? alignOf(paragraph) : undefined) ?? alignOf(row);
}

/** The most common explicit alignment of a column's body cells; ties and silence mean left. */
function majorityAlign(entries: CellEntry[]): ClipboardTableAlign {
  const votes = { left: 0, center: 0, right: 0 };
  for (const entry of entries) {
    if (!entry.filler) {
      votes[entry.align === "center" || entry.align === "right" ? entry.align : "left"] += 1;
    }
  }
  if (votes.center > votes.left && votes.center >= votes.right) {
    return "center";
  }
  return votes.right > votes.left && votes.right > votes.center ? "right" : "left";
}

function specFromGrid(
  grid: CellEntry[][],
  headerCount: number,
  width: number
): ClipboardTableSpec {
  const columns = Array.from({ length: width }, (_, column): { align: ClipboardTableAlign } => {
    const body = grid.slice(headerCount).map((row) => row[column]);
    const texts = body.map((entry) => cellText(entry.input));
    return { align: isDecimalColumn(texts) ? "decimal" : majorityAlign(body) };
  });
  const cells = grid.map((row) => row.map((entry) => entry.input));
  return {
    columns,
    rows: cells.slice(headerCount),
    ...(headerCount > 0 ? { headerRows: cells.slice(0, headerCount) } : {})
  };
}

function convertTable(
  table: Element, payload: ClipboardReadPayload, notes: ReturnType<typeof tableNotes>
): ClipboardTableResult | undefined {
  const { rows, headCount } = collectRows(table);
  if (rows.length === 0) {
    return fail("The HTML table has no readable rows.");
  }
  if (rows.length > LIMITS.maxRows) {
    return tooManyRows(rows.length);
  }
  const nominal = Math.max(
    ...rows.map((row) =>
      cellsOf(row.element).reduce((sum, cell) => sum + spanAttribute(cell, "colspan", 1, MAX_COLSPAN), 0)
    )
  );
  if (nominal > LIMITS.maxColumns) {
    return tooManyColumns(nominal);
  }
  if (nominal === 0) return fail("The HTML table has no readable cells.");
  if (nominal * rows.length < 2) {
    return undefined;
  }

  const warnings = new Set<string>();
  const mergedRows = new Set<number>();
  const rowspanRows = new Set<number>();
  const grid: Array<Array<CellEntry | undefined>> = rows.map(() => []);
  const headerFlags: boolean[] = [];
  let nested = false;
  let images = false;
  let originalCharacters = 0;
  for (let r = 0; r < rows.length; r += 1) {
    const cells = cellsOf(rows[r].element);
    headerFlags.push(cells.length > 0 && cells.every((cell) => tagOf(cell) === "th"));
    let c = 0;
    for (const cell of cells) {
      while (grid[r][c] !== undefined) {
        c += 1;
      }
      const colspan = spanAttribute(cell, "colspan", 1, MAX_COLSPAN);
      const rowspan = Math.min(spanAttribute(cell, "rowspan", 1, rows.length), rows[r].groupEnd - r);
      if (c + colspan > LIMITS.maxColumns) {
        return tooManyColumns(c + colspan);
      }
      if (colspan > 1 || rowspan > 1) {
        mergedRows.add(r);
      }
      if (rowspan > 1) {
        for (let dr = 0; dr < rowspan; dr += 1) rowspanRows.add(r + dr);
      }
      const collector = new CellCollector();
      for (const child of Array.from(cell.childNodes)) {
        collector.walk(child, PLAIN);
      }
      nested ||= collector.nested;
      images ||= collector.images;
      let input = collector.finish();
      if (cellText(input).length > LIMITS.maxCellCharacters) {
        return tooLongCell(r + 1, c + 1, cellText(input).length);
      }
      originalCharacters += cellText(input).length;
      if (typeof input !== "string" && input.spans.length > LIMITS.maxSpansPerCell) {
        return fail(`The cell in row ${r + 1}, column ${c + 1} has ${input.spans.length} spans; `
          + `ChemDraft table cells hold at most ${LIMITS.maxSpansPerCell}.`);
      }
      const overflow = OVERFLOW_PATTERN.test(cellText(input));
      if (overflow) {
        const number = cell.getAttribute("x:num")?.trim();
        if (number && EXCEL_NUMBER_PATTERN.test(number) && Number.isFinite(Number(number))) input = number;
      }
      const align = cellAlign(cell, rows[r].element);
      for (let dr = 0; dr < rowspan; dr += 1) {
        for (let dc = 0; dc < colspan; dc += 1) {
          if (grid[r + dr][c + dc] !== undefined) {
            return fail(`The HTML table has overlapping merged cells at row ${r + dr + 1}, column ${c + dc + 1}.`);
          }
          grid[r + dr][c + dc] =
            dr === 0 && dc === 0 ? { input, filler: false, overflow, align } : { input: "", filler: true };
        }
      }
      c += colspan;
    }
  }
  const width = Math.max(...grid.map((row) => row.length));
  if (width === 0) {
    return undefined;
  }
  if (width > LIMITS.maxColumns) {
    return tooManyColumns(width);
  }
  const dense = grid.map((row) =>
    Array.from({ length: width }, (_, column) => row[column] ?? { input: "", filler: true })
  );
  // Excel encodes text overflowing across empty cells as colspan + mso-ignore:colspan.
  // A wide single-label boundary row can also represent a caption/footnote in other HTML.
  // Never reinterpret a body row, a vertical merge, or an unresolved numeric overflow.
  const isNoteRow = (r: number): boolean => {
    const first = cellsOf(rows[r].element)[0];
    if (!first || rowspanRows.has(r) || dense[r][0].filler) return false;
    const span = spanAttribute(first, "colspan", 1, MAX_COLSPAN);
    const ignore = styleProperty(first, "mso-ignore")?.split(/\s+/).includes("colspan");
    return width > 1 && (ignore === true || (span > 1 && span >= width / 2))
      && cellText(dense[r][0].input).trim() !== "" && !dense[r][0].overflow
      && dense[r].slice(1).every(entry => cellText(entry.input).trim() === "");
  };
  let start = 0, end = dense.length;
  while (start < end && isNoteRow(start)) start += 1;
  while (end > start && isNoteRow(end - 1)) end -= 1;
  // A range containing only wide labels has no distinct table to attach notes to.
  if (start === end) { start = 0; end = dense.length; }
  if ((end - start) * width < 2) return undefined;
  if (Array.from(mergedRows).some(r => r >= start && r < end)) warnings.add(WARN_MERGED);
  if (grid.slice(start, end).some(row => row.length < width)) warnings.add(WARN_RAGGED);
  const originalRefusal = tableCharacterRefusal(originalCharacters);
  if (originalRefusal) return originalRefusal;
  // Expanded/padded/nested body grids do not have a reliable one-to-one TSV cell mapping.
  // Boundary notes may have fillers: their positions and empty cells are still checked
  // against the entire untrimmed TSV grid before any overflow value is recovered.
  const hasOverflow = dense.some((row) => row.some((entry) => OVERFLOW_PATTERN.test(cellText(entry.input))));
  const plain = hasOverflow && !nested && dense.every((row, r) => r < start || r >= end || row.every((entry) => !entry.filler))
    ? payload.textItems.find((item) => isTextLikeType(item.type)) : undefined;
  const tsv = plain ? readTsvTable(plain.text, 1, true) : undefined;
  const normalizedText = (cell: ClipboardTableCell): string => cellText(cell).replace(/\s+/g, " ").trim();
  // Confirm both dimensions and the visible cells, so unrelated/reordered TSV cannot supply values.
  const matchingRows = tsv?.ok && tsv.spec.columns.length === width && tsv.spec.rows.length === dense.length
    && dense.every((row, r) => row.every((entry, c) => entry.overflow || normalizedText(entry.input) === normalizedText(tsv.spec.rows[r][c])))
    ? tsv.spec.rows : undefined;
  for (const [r, row] of dense.entries()) {
    for (const [c, entry] of row.entries()) {
      if (OVERFLOW_PATTERN.test(cellText(entry.input))) {
        const replacement = matchingRows?.[r][c];
        if (replacement !== undefined && cellText(replacement).trim() !== "" &&
          !OVERFLOW_PATTERN.test(cellText(replacement).trim())) {
          entry.input = replacement;
        } else {
          warnings.add(overflowWarning(r + 1, c + 1));
        }
      }
      if (cellText(entry.input).length > LIMITS.maxCellCharacters) {
        return tooLongCell(r + 1, c + 1, cellText(entry.input).length);
      }
    }
  }
  const characterRefusal = tableCharacterRefusal(dense.reduce((sum, row) =>
    sum + row.reduce((count, entry) => count + cellText(entry.input).length, 0), 0));
  if (characterRefusal) return characterRefusal;
  if (nested) {
    warnings.add(WARN_NESTED);
  }
  if (images) {
    warnings.add(WARN_IMAGES);
  }

  const body = dense.slice(start, end);
  let headerCount = Math.max(0, Math.min(headCount, end) - start);
  if (headerCount === 0) {
    while (start + headerCount < end && headerFlags[start + headerCount]) {
      headerCount += 1;
    }
    if (headerCount === 0 && body.length > 1 && !mergedRows.has(start) && !rowspanRows.has(start)) {
      const isExcelHeader = excelHeaderTest(table);
      if (isExcelHeader(rows[start].element) && !isExcelHeader(rows[start + 1].element)) headerCount = 1;
    }
  }
  if (headerCount >= body.length) {
    headerCount = 0;
  }
  const order = [WARN_MERGED, WARN_RAGGED, WARN_NESTED, WARN_IMAGES];
  return addTableNotes({
    ok: true,
    spec: specFromGrid(body, headerCount, width),
    warnings: [
      ...order.filter((warning) => warnings.has(warning)),
      ...Array.from(warnings).filter((warning) => !order.includes(warning))
    ],
    source: "html"
  }, [...notes.leading, ...dense.slice(0, start).map(row => row[0].input)],
  [...dense.slice(end).map(row => row[0].input), ...notes.trailing]);
}

/**
 * Reads a table from the clipboard's HTML item (Excel, Word, Google Docs and Sheets). Returns undefined
 * unless the HTML holds a table. One outermost table may have caption/footnote paragraphs around it;
 * ambiguous or unsafe table-shaped HTML is refused. `parseHtml` uses the host's DOM (a DOMParser).
 */
export function readClipboardHtmlTable(
  payload: ClipboardReadPayload,
  parseHtml: (html: string) => Document
): ClipboardTableResult | undefined {
  const text = findHtmlText(payload);
  if (text === undefined) {
    return undefined;
  }
  const { html, fragment } = htmlFragment(text);
  let document: Document;
  try {
    document = parseHtml(fragment);
  } catch {
    return fail("The clipboard HTML could not be parsed safely as a table.");
  }
  let root: Element = document.body ?? document.documentElement;
  let tables = Array.from(root.querySelectorAll("table")).filter((table) => !hasTableAncestor(table));
  if (tables.length === 0 && fragment !== html) {
    // Excel marks the rows inside the table, so the fragment alone has no table wrapper.
    try {
      document = parseHtml(html);
    } catch {
      return fail("The clipboard HTML could not be parsed safely as a table.");
    }
    root = document.body ?? document.documentElement;
    tables = Array.from(root.querySelectorAll("table")).filter((table) => !hasTableAncestor(table));
    const comments = document.createTreeWalker(root, 128 /* SHOW_COMMENT */);
    let start = comments.nextNode();
    while (start && start.nodeValue !== "StartFragment") {
      start = comments.nextNode();
    }
    if (tables.length > 1) {
      return fail("The clipboard contains multiple HTML tables; copy one table at a time.");
    }
    if (tables.length !== 1 || !start || !tables[0].contains(start)) {
      return undefined;
    }
  }
  if (tables.length === 0) {
    return /<table\b/i.test(fragment) ? fail("The HTML table has no readable table structure.") : undefined;
  }
  if (tables.length > 1) {
    return fail("The clipboard contains multiple HTML tables; copy one table at a time.");
  }
  const notes = tableNotes(root, tables[0]);
  const result = convertTable(tables[0], payload, notes);
  if (!result?.ok) return result;
  if (notes.unsafe) {
    return fail("The content around the HTML table cannot be read safely as caption and footnote paragraphs; copy just the table and its paragraphs.");
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------
// TSV
// ---------------------------------------------------------------------------------------------------

/** Splits Excel-style tab-separated text: a field opening with a quote may hold tabs, newlines, "". */
function parseTsvRecords(text: string): string[][] | undefined {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let index = 0;
  let pending = false;
  const endField = (): void => {
    record.push(field);
    field = "";
  };
  const endRecord = (): void => {
    endField();
    records.push(record);
    record = [];
    pending = false;
  };
  while (index < text.length) {
    const char = text[index];
    pending = true;
    if (char === '"' && field === "") {
      index += 1;
      let closed = false;
      while (index < text.length) {
        if (text[index] === '"') {
          if (text[index + 1] === '"') {
            field += '"';
            index += 2;
            continue;
          }
          closed = true;
          index += 1;
          break;
        }
        field += text[index];
        index += 1;
      }
      if (!closed) {
        return undefined;
      }
      field = field.replace(/\r\n?/g, "\n");
      if (index < text.length && !["\t", "\n", "\r"].includes(text[index])) return undefined;
      continue;
    }
    if (char === "\t") {
      endField();
    } else if (char === "\n" || char === "\r") {
      endRecord();
      if (char === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
    } else {
      field += char;
    }
    index += 1;
  }
  if (pending) {
    endRecord();
  }
  return records;
}

/**
 * Reads a table from plain text copied out of a spreadsheet: at least two lines, each with the same
 * number of tab-separated fields (two or more), optionally surrounded by caption/footnote lines
 * with no populated fields after the first. There are no header rows; the user decides those.
 * Ambiguous blocks are refused.
 */
export function readClipboardTsvTable(text: string): ClipboardTableResult | undefined {
  return readTsvTable(text, 2);
}

/** HTML recovery already established a table, so its matching TSV may have just one row. */
function readTsvTable(text: string, minRows: number, preserveBoundaryRows = false): ClipboardTableResult | undefined {
  const records = parseTsvRecords(text);
  if (!records) {
    return text.includes("\t") ? fail("The tab-separated table has a malformed quoted field.") : undefined;
  }
  const last = records[records.length - 1];
  if (last && last.length === 1 && last[0] === "") {
    records.pop();
  }
  // Excel pads caption/footnote lines with tabs. Only strip these at the boundaries;
  // a sparse row inside the rectangle is still data. HTML recovery needs the full grid.
  const isNote = (record: string[]): boolean => record.length === 1
    || (!preserveBoundaryRows && record[0].trim() !== "" && record.slice(1).every(field => field === ""));
  const start = records.findIndex((record) => !isNote(record));
  if (start < 0) return undefined;
  let end = start;
  while (end < records.length && records[end].length > 1) end += 1;
  if (records.slice(end).some((record) => !isNote(record))) {
    return fail("The clipboard contains separated tab-separated blocks; copy one rectangular table at a time.");
  }
  while (end > start && isNote(records[end - 1])) end -= 1;
  const grid = records.slice(start, end);
  const width = grid[0].length;
  if (grid.length < minRows) {
    if (records.length === 1) return undefined;
    return fail("The tab-separated table needs at least two rows with two or more columns.");
  }
  if (grid.some((record) => record.length !== width)) {
    return fail("The tab-separated table has rows with different numbers of columns; copy a rectangular table.");
  }
  if (grid.length > LIMITS.maxRows) {
    return tooManyRows(grid.length);
  }
  if (width > LIMITS.maxColumns) {
    return tooManyColumns(width);
  }
  const warnings: string[] = [];
  for (let r = 0; r < grid.length; r += 1) {
    for (let c = 0; c < width; c += 1) {
      if (grid[r][c].length > LIMITS.maxCellCharacters) {
        return tooLongCell(r + 1, c + 1, grid[r][c].length);
      }
      if (OVERFLOW_PATTERN.test(grid[r][c].trim())) warnings.push(overflowWarning(r + 1, c + 1));
    }
  }
  const characterRefusal = tableCharacterRefusal(grid.reduce((sum, row) =>
    sum + row.reduce((count, text) => count + text.length, 0), 0));
  if (characterRefusal) return characterRefusal;
  const columns = Array.from({ length: width }, (_, column): { align: ClipboardTableAlign } => ({
    align: isDecimalColumn(grid.map((record) => record[column])) ? "decimal" : "left"
  }));
  return addTableNotes(
    { ok: true, spec: { columns, rows: grid }, warnings, source: "tsv" },
    records.slice(0, start).map((record) => record[0]).filter((note) => note.trim() !== ""),
    records.slice(end).map((record) => record[0]).filter((note) => note.trim() !== "")
  );
}
