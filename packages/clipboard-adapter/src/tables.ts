// Detects a table on the clipboard (Office/Google HTML or Excel-style TSV) and converts it to a table spec.
// The output has the input shape of TableSpecSchema in document-workflow-core, which this package must not
// import; tables.test.ts parses every result with that schema.

import type { ClipboardReadPayload } from "./index";

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

/** A table in the shape the native table builder accepts (no caption or footnotes). */
export interface ClipboardTableSpec {
  columns: Array<{ align: ClipboardTableAlign }>;
  rows: ClipboardTableCell[][];
  headerRows?: ClipboardTableCell[][];
}

/** A detected table, or the reason a table-shaped clipboard cannot be imported. */
export type ClipboardTableResult =
  | { ok: true; spec: ClipboardTableSpec; warnings: string[]; source: "html" | "tsv" }
  | { ok: false; reason: string };

// Mirrors TABLE_LIMITS in chem-core; tables.test.ts asserts the two stay equal.
const LIMITS = { maxColumns: 64, maxRows: 500, maxCellCharacters: 2000 } as const;

const WARN_MERGED = "Merged cells were split into separate cells.";
const WARN_RAGGED = "Short rows were padded with empty cells.";
const WARN_NESTED = "Nested tables were flattened to text.";
const WARN_IMAGES = "Images in the table were not imported.";
const WARN_CAPTION = "The table caption was not imported.";

const NUMBER_PATTERNS = [/^[+\-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/, /^[+\-−]?\.\d+$/];
const DASH_PATTERN = /^[-–—]$/;

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
  const style = element.getAttribute("style");
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

function hasTextOutside(node: Node, table: Element): boolean {
  for (const child of Array.from(node.childNodes)) {
    if (child === table) {
      continue;
    }
    if (child.nodeType === 3) {
      if (/[^\s ]/.test(child.nodeValue ?? "")) {
        return true;
      }
    } else if (child.nodeType === 1 && !SKIP_TAGS.has(tagOf(child as Element))) {
      if (hasTextOutside(child, table)) {
        return true;
      }
    }
  }
  return false;
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

function convertTable(table: Element): ClipboardTableResult | undefined {
  const { rows, headCount } = collectRows(table);
  if (rows.length === 0) {
    return undefined;
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
  if (nominal * rows.length < 2) {
    return undefined;
  }

  const warnings = new Set<string>();
  const grid: Array<Array<CellEntry | undefined>> = rows.map(() => []);
  const headerFlags: boolean[] = [];
  let nested = false;
  let images = false;
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
        warnings.add(WARN_MERGED);
      }
      const collector = new CellCollector();
      for (const child of Array.from(cell.childNodes)) {
        collector.walk(child, PLAIN);
      }
      nested ||= collector.nested;
      images ||= collector.images;
      const input = collector.finish();
      if (cellText(input).length > LIMITS.maxCellCharacters) {
        return tooLongCell(r + 1, c + 1, cellText(input).length);
      }
      const align = cellAlign(cell, rows[r].element);
      for (let dr = 0; dr < rowspan; dr += 1) {
        for (let dc = 0; dc < colspan; dc += 1) {
          grid[r + dr][c + dc] =
            dr === 0 && dc === 0 ? { input, filler: false, align } : { input: "", filler: true };
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
  if (grid.some((row) => row.length < width)) {
    warnings.add(WARN_RAGGED);
  }
  const dense = grid.map((row) =>
    Array.from({ length: width }, (_, column) => row[column] ?? { input: "", filler: true })
  );
  if (nested) {
    warnings.add(WARN_NESTED);
  }
  if (images) {
    warnings.add(WARN_IMAGES);
  }
  if (Array.from(table.children).some((child) => tagOf(child) === "caption" && child.textContent?.trim())) {
    warnings.add(WARN_CAPTION);
  }

  let headerCount = headCount;
  if (headerCount === 0) {
    while (headerCount < headerFlags.length && headerFlags[headerCount]) {
      headerCount += 1;
    }
  }
  if (headerCount >= dense.length) {
    headerCount = 0;
  }
  const order = [WARN_MERGED, WARN_RAGGED, WARN_NESTED, WARN_IMAGES, WARN_CAPTION];
  return {
    ok: true,
    spec: specFromGrid(dense, headerCount, width),
    warnings: order.filter((warning) => warnings.has(warning)),
    source: "html"
  };
}

/**
 * Reads a table from the clipboard's HTML item (Excel, Word, Google Docs and Sheets). Returns undefined
 * unless the HTML holds exactly one outermost table and no other visible text, so a table inside a
 * paragraph of prose stays text. `parseHtml` parses a string in the host's DOM (a DOMParser).
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
  let document = parseHtml(fragment);
  let root: Element = document.body ?? document.documentElement;
  let tables = Array.from(root.querySelectorAll("table")).filter((table) => !hasTableAncestor(table));
  if (tables.length === 0 && fragment !== html) {
    // Excel marks the rows inside the table, so the fragment alone has no table wrapper.
    document = parseHtml(html);
    root = document.body ?? document.documentElement;
    tables = Array.from(root.querySelectorAll("table")).filter((table) => !hasTableAncestor(table));
    const comments = document.createTreeWalker(root, 128 /* SHOW_COMMENT */);
    let start = comments.nextNode();
    while (start && start.nodeValue !== "StartFragment") {
      start = comments.nextNode();
    }
    if (tables.length !== 1 || !start || !tables[0].contains(start)) {
      return undefined;
    }
  }
  if (tables.length !== 1 || hasTextOutside(root, tables[0])) {
    return undefined;
  }
  return convertTable(tables[0]);
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
 * number of tab-separated fields (two or more). There are no header rows; the user decides those.
 */
export function readClipboardTsvTable(text: string): ClipboardTableResult | undefined {
  const records = parseTsvRecords(text);
  if (!records) {
    return undefined;
  }
  const last = records[records.length - 1];
  if (last && last.length === 1 && last[0] === "") {
    records.pop();
  }
  const width = records[0]?.length ?? 0;
  if (records.length < 2 || width < 2 || records.some((record) => record.length !== width)) {
    return undefined;
  }
  if (records.length > LIMITS.maxRows) {
    return tooManyRows(records.length);
  }
  if (width > LIMITS.maxColumns) {
    return tooManyColumns(width);
  }
  for (let r = 0; r < records.length; r += 1) {
    for (let c = 0; c < width; c += 1) {
      if (records[r][c].length > LIMITS.maxCellCharacters) {
        return tooLongCell(r + 1, c + 1, records[r][c].length);
      }
    }
  }
  const columns = Array.from({ length: width }, (_, column): { align: ClipboardTableAlign } => ({
    align: isDecimalColumn(records.map((record) => record[column])) ? "decimal" : "left"
  }));
  return { ok: true, spec: { columns, rows: records }, warnings: [], source: "tsv" };
}
