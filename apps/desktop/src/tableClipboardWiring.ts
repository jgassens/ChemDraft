import {
  inspectClipboardPayload, isTextLikeType, looksLikeSmiles, readClipboardHtmlTable,
  readClipboardTsvTable, smilesListCandidates, smilesListDecision, smilesListTokens,
  type ClipboardDetectedPayload, type ClipboardReadPayload, type ClipboardTableResult
} from "@chemdraft/clipboard-adapter";
import {
  applyPatches, textStyleToObjectStyle,
  type ChemDraftDocument, type NativeTextStyle, type TableObject
} from "@chemdraft/chem-core";
import { buildTableObject } from "@chemdraft/document-workflow-core";
import { exportTableClipboardPayloads } from "@chemdraft/export-engine";
import type { ClipboardWriteTextItem } from "./clipboard";
import {
  CHEMDRAFT_SELECTION_CLIPBOARD_TYPE, moveDocumentObject, parseSelectionClipboardPayload, serializeSelectionClipboardPayload,
  type ChemDraftSelectionClipboardPayload
} from "./documentWorkflow";

type ParseHtml = (html: string) => Document;

/** Consume a generated RTF header group, respecting escaped braces in font names. */
function rtfGroup(text: string): [string, string] {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === "{") depth++;
    if (text[i] === "}" && --depth === 0) return [text.slice(0, i + 1), text.slice(i + 1)];
  }
  throw new Error("Incomplete generated RTF table header");
}

/** One RTF document, with global font/colour tables and remapped per-table references. */
function joinRtf(documents: string[]): string {
  if (documents.length === 1) return documents[0];
  const fonts: string[] = [], colors: string[] = [];
  const bodies = documents.map((document, index) => {
    let body = document.replace(/^\{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1/, "");
    const [font, afterFont] = rtfGroup(body);
    const [color, afterColor] = rtfGroup(afterFont);
    fonts.push(remapRtfReferences(font.slice("{\\fonttbl".length, -1), index, 0));
    const offset = colors.length;
    const entries = color.slice("{\\colortbl;".length, -1).split(";").filter(Boolean);
    colors.push(...entries);
    body = remapRtfReferences(afterColor.slice(0, -1), index, offset);
    return `{${body}}`;
  });
  return "{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1{\\fonttbl" + fonts.join("")
    + "}{\\colortbl;" + colors.map(color => color + ";").join("") + "}"
    + bodies.join("\\pard\\plain\\par\n") + "}";
}

function remapRtfReferences(text: string, fontIndex: number, colorOffset: number): string {
  // Consume escaped backslashes/braces as tokens too: literal cell text such as "\\cf1" must survive.
  return text.replace(/\\(?:[\\{}]|f(\d+)\b|cf(\d+)\b)/g, (token, font: string | undefined, color: string | undefined) => {
    if (font !== undefined) return `\\f${fontIndex}`;
    if (color !== undefined) return `\\cf${Number(color) === 0 ? 0 : Number(color) + colorOffset}`;
    return token;
  });
}

/** Selection payload objects are in page order; a molecule fragment makes this ineligible too. */
export function tableSelectionClipboardItems(
  payload: ChemDraftSelectionClipboardPayload
): { items: ClipboardWriteTextItem[]; warnings: string[] } | undefined {
  if (!payload.objects.length || !payload.objects.every((object): object is TableObject => object.type === "table")) return undefined;
  const exports = payload.objects.map(table => exportTableClipboardPayloads(table));
  const start = "<!--StartFragment-->", end = "<!--EndFragment-->";
  const firstHtml = exports[0].html;
  const html = firstHtml.slice(0, firstHtml.indexOf(start) + start.length)
    + exports.map(item => item.html.slice(item.html.indexOf(start) + start.length, item.html.indexOf(end))).join("<p></p>")
    + firstHtml.slice(firstHtml.indexOf(end));
  return {
    items: [
      { type: CHEMDRAFT_SELECTION_CLIPBOARD_TYPE, text: serializeSelectionClipboardPayload(payload) },
      { type: "text/html", text: html },
      { type: "text/rtf", text: joinRtf(exports.map(item => item.rtf)) },
      { type: "text/plain", text: exports.map(item => item.tsv).join("\n\n") }
    ],
    warnings: exports.flatMap(item => item.warnings)
  };
}

/** Called only after chemical formats (including parsed plain-text SMILES lists) have declined. */
export function readTableClipboardPaste(payload: ClipboardReadPayload, parseHtml: ParseHtml): ClipboardTableResult | undefined {
  const html = readClipboardHtmlTable(payload, parseHtml);
  if (html !== undefined) return html;
  // Excel also supplies external plain text with one cell per line and displayed overflow.
  // Prefer the standard plain-text flavours, then tabs within either preference group.
  const plainTypes = new Set([
    "public.utf8-plain-text", "public.utf16-plain-text", "text/plain", "public.plain-text", "nsstringpboardtype"
  ]);
  const preference = (item: ClipboardReadPayload["textItems"][number]): number =>
    (plainTypes.has(item.type.trim().toLowerCase()) ? 2 : 0) + (item.text.includes("\t") ? 1 : 0);
  const plainText = payload.textItems.filter(item => isTextLikeType(item.type))
    .sort((a, b) => preference(b) - preference(a))[0];
  return plainText ? readClipboardTsvTable(plainText.text) : undefined;
}

export type TableClipboardPasteDecision =
  | { kind: "selection"; payload: ChemDraftSelectionClipboardPayload }
  | { kind: "table"; result: ClipboardTableResult }
  | { kind: "existing"; payload: ClipboardDetectedPayload };

/** Keep native and chemical precedence; plausible SMILES text uses the existing parser first. */
export function tableClipboardPasteDecision(payload: ClipboardReadPayload, parseHtml: ParseHtml): TableClipboardPasteDecision {
  const selection = payload.textItems.map(item => parseSelectionClipboardPayload(item.text)).find(Boolean);
  if (selection) return { kind: "selection", payload: selection };
  const detected = inspectClipboardPayload(payload);
  // A few reagent names/header words can resemble SMILES in a prose-heavy Office table.
  // Only defer to chemistry if even the best case (every candidate parses) can qualify
  // under the same list policy used by the chemical parser.
  let possibleList = false;
  if (detected.kind === "plain-text") {
    const candidates = smilesListCandidates(detected.text);
    if (candidates.length >= 2) {
      const tokens = smilesListTokens(detected.text);
      const firstColumns = new Map<number, number>();
      for (const token of tokens) {
        if (!firstColumns.has(token.line)) firstColumns.set(token.line, token.column);
      }
      possibleList = smilesListDecision({
        candidates: tokens.length, parsed: candidates.length,
        lineCount: detected.text.split(/\r\n|\r|\n/).filter(line => line.trim() !== "").length,
        parsedFirstTokenLines: candidates.filter(token => token.column === firstColumns.get(token.line)).length
      });
    }
  }
  const textNeedsChemistry = detected.kind === "plain-text" && (
    looksLikeSmiles(detected.text.trim()) || possibleList
  );
  if (!["plain-text", "empty", "vector-only"].includes(detected.kind) || textNeedsChemistry) {
    return { kind: "existing", payload: detected };
  }
  const table = readTableClipboardPaste(payload, parseHtml);
  return table ? { kind: "table", result: table } : { kind: "existing", payload: detected };
}

/** Same builder, text-style conversion and centring as Insert Table; caller records one undo. */
export function pasteTableIntoDocument(
  document: ChemDraftDocument,
  parsed: Extract<ClipboardTableResult, { ok: true }>,
  center: { x: number; y: number },
  textStyle: Partial<NativeTextStyle>,
  newId: (prefix: string) => string
): { document: ChemDraftDocument; warnings: string[] } {
  const { object } = buildTableObject(parsed.spec, {
    id: newId("table"), x: 0, y: 0, newId, style: textStyleToObjectStyle(textStyle)
  });
  const page = document.pages[0];
  const position = object.width > page.width || object.height > page.height
    ? { x: 0, y: 0 }
    : { x: center.x - object.width / 2, y: center.y - object.height / 2 };
  const inserted = applyPatches(document, [
    { op: "addObject", pageId: page.id, object },
    { op: "setSelection", pageId: page.id, objectIds: [object.id] }
  ]);
  return {
    document: moveDocumentObject(inserted, object.id, position),
    warnings: [...parsed.warnings]
  };
}
