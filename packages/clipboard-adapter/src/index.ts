export type ClipboardPayloadKind = "svg" | "png" | "text/plain" | "smiles" | "mol" | "rxn" | "cdxml" | "cdx";

export interface ClipboardTransferWarning {
  code: string;
  message: string;
}

export interface ClipboardTextItem {
  type: string;
  text: string;
}

export interface ClipboardReadPayload {
  types: string[];
  textItems: ClipboardTextItem[];
}

export type ClipboardMolfileFormat = "molfile-v2000" | "molfile-v3000";

export type ClipboardDetectedPayload =
  | {
      kind: "plain-text";
      text: string;
      sourceType?: string;
      warnings: ClipboardTransferWarning[];
    }
  | {
      kind: "molfile";
      format: ClipboardMolfileFormat;
      text: string;
      sourceType?: string;
      warnings: ClipboardTransferWarning[];
    }
  | {
      kind: "smiles";
      text: string;
      sourceType?: string;
      warnings: ClipboardTransferWarning[];
    }
  | {
      kind: "inchi";
      text: string;
      sourceType?: string;
      warnings: ClipboardTransferWarning[];
    }
  | {
      kind: "rxnfile";
      text: string;
      sourceType?: string;
      warnings: ClipboardTransferWarning[];
    }
  | {
      kind: "cdxml";
      text: string;
      sourceType?: string;
      warnings: ClipboardTransferWarning[];
    }
  | {
      kind: "cdx";
      sourceType?: string;
      warnings: ClipboardTransferWarning[];
    }
  | {
      kind: "vector-only";
      sourceType?: string;
      warnings: ClipboardTransferWarning[];
    }
  | {
      kind: "empty";
      warnings: ClipboardTransferWarning[];
    };

export interface ParsedClipboardAtom {
  id: string;
  element: string;
  x: number;
  y: number;
  formalCharge: number;
}

export interface ParsedClipboardBond {
  id: string;
  fromAtomId: string;
  toAtomId: string;
  order: "single" | "double" | "triple" | "aromatic" | "unknown";
  /** Wedge/hash stereo from the source molfile (V2000 stereo 1=up→wedge, 6=down→hashed;
   *  V3000 CFG=1→wedge, CFG=3→hashed). The narrow end of the wedge is `fromAtomId`. */
  bondStyle?: "wedge" | "hashed";
}

export interface ParsedMolfileGraph {
  format: ClipboardMolfileFormat;
  atoms: ParsedClipboardAtom[];
  bonds: ParsedClipboardBond[];
  warnings: ClipboardTransferWarning[];
}

export interface ExtractedRxnMolfileBlock {
  format: ClipboardMolfileFormat;
  text: string;
}

const textLikeTypePatterns = [
  "public.utf8-plain-text",
  "public.utf16-plain-text",
  "public.plain-text",
  "public.text",
  "text/plain",
  "NSStringPboardType",
  "com.apple.traditional-mac-plain-text"
] as const;

export function inspectClipboardPayload(payload: ClipboardReadPayload): ClipboardDetectedPayload {
  const textItems = payload.textItems
    .map((item) => ({ ...item, text: normalizeClipboardText(item.text) }))
    .filter((item) => item.text.trim().length > 0);

  for (const item of textItems) {
    if (looksLikeRxnfile(item.text)) {
      return {
        kind: "rxnfile",
        text: item.text,
        sourceType: item.type,
        warnings: [
          {
            code: "clipboard.rxn_not_implemented",
            message: "The clipboard contains RXN text, but RXN paste is not implemented yet."
          }
        ]
      };
    }
  }

  for (const item of textItems) {
    const format = detectMolfileFormat(item.text);
    if (format) {
      return {
        kind: "molfile",
        format,
        text: item.text,
        sourceType: item.type,
        warnings: []
      };
    }
  }

  for (const item of textItems) {
    if (looksLikeCdxml(item.text) || isCdxmlType(item.type)) {
      return {
        kind: "cdxml",
        text: item.text,
        sourceType: item.type,
        warnings: [
          {
            code: "clipboard.cdxml_not_implemented",
            message: "The clipboard contains CDXML, but CDXML paste parsing is not implemented yet."
          }
        ]
      };
    }
  }

  for (const item of textItems) {
    if (looksLikeInchi(item.text)) {
      return {
        kind: "inchi",
        text: item.text.trim(),
        sourceType: item.type,
        warnings: [
          {
            code: "clipboard.inchi_not_implemented",
            message: "The clipboard contains an InChI string; ChemDraft can preserve it, but reconstructing a structure from InChI is not implemented yet."
          }
        ]
      };
    }
  }

  const smilesTextItem = textItems.find((item) => isSmilesType(item.type));
  if (smilesTextItem) {
    return {
      kind: "smiles",
      text: smilesTextItem.text.trim(),
      sourceType: smilesTextItem.type,
      warnings: [
        {
          code: "clipboard.smiles_geometry_not_generated",
          message: "The clipboard contains SMILES text; ChemDraft can preserve it, but native 2D layout generation is not implemented yet."
        }
      ]
    };
  }

  const cdxType = payload.types.find(isCdxType);
  if (cdxType) {
    return {
      kind: "cdx",
      sourceType: cdxType,
      warnings: [
        {
          code: "clipboard.cdx_not_implemented",
          message: "The clipboard contains a CDX payload, but best-effort CDX paste parsing is not implemented yet."
        }
      ]
    };
  }

  const firstPlainText = textItems.find((item) => isTextLikeType(item.type)) ?? textItems[0];
  if (firstPlainText) {
    return {
      kind: "plain-text",
      text: firstPlainText.text,
      sourceType: firstPlainText.type,
      warnings: []
    };
  }

  const vectorType = payload.types.find(isVectorArtworkType);
  if (vectorType) {
    return {
      kind: "vector-only",
      sourceType: vectorType,
      warnings: [
        {
          code: "clipboard.vector_only",
          message: "The clipboard contains vector artwork only; no editable chemistry payload was found."
        }
      ]
    };
  }

  return {
    kind: "empty",
    warnings: [
      {
        code: "clipboard.empty_or_unsupported",
        message: "The clipboard does not contain a supported ChemDraft paste payload."
      }
    ]
  };
}

export function parseMolfileGraph(molfile: string): ParsedMolfileGraph {
  const normalized = normalizeClipboardText(molfile);
  const format = detectMolfileFormat(normalized);
  if (!format) {
    throw new Error("Clipboard text is not a supported V2000 or V3000 molfile.");
  }

  return format === "molfile-v3000"
    ? parseV3000Molfile(normalized)
    : parseV2000Molfile(normalized);
}

export function extractRxnMolfileBlocks(rxnfile: string): ExtractedRxnMolfileBlock[] {
  const normalized = normalizeClipboardText(rxnfile);
  if (!looksLikeRxnfile(normalized)) {
    return [];
  }

  const lines = normalized.split("\n");
  const blocks: ExtractedRxnMolfileBlock[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.trim() !== "$MOL") {
      continue;
    }

    const blockLines: string[] = [];
    for (let lineIndex = index + 1; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex] ?? "";
      blockLines.push(line);
      if (line.trim() === "M  END") {
        index = lineIndex;
        break;
      }
    }

    const text = blockLines.join("\n");
    const format = detectMolfileFormat(text);
    if (format) {
      blocks.push({ format, text });
    }
  }

  return blocks;
}

export function detectMolfileFormat(text: string): ClipboardMolfileFormat | undefined {
  const normalized = normalizeClipboardText(text);
  if (looksLikeRxnfile(normalized)) {
    return undefined;
  }

  // "V3000" alone is not evidence: it appears in ordinary prose (a spectrometer model, a filename),
  // and classifying prose as a molfile sent it to a parser that throws. Require the structural
  // marker a real V3000 molfile always carries — its "M  V30 " block lines, or at minimum the
  // "M  END" terminator the V2000 branch below already insists on.
  if (normalized.includes("M  V30 ") || (/\bV3000\b/.test(normalized) && normalized.includes("M  END"))) {
    return "molfile-v3000";
  }
  if (/\bV2000\b/.test(normalized) && normalized.includes("M  END")) {
    return "molfile-v2000";
  }

  const countsLineIndex = findV2000CountsLineIndex(normalized.split("\n"));
  if (countsLineIndex !== -1 && normalized.includes("M  END")) {
    return "molfile-v2000";
  }

  return undefined;
}

export function isTextLikeType(type: string): boolean {
  const normalized = type.trim().toLowerCase();
  return textLikeTypePatterns.some((pattern) => normalized === pattern.toLowerCase()) ||
    normalized.includes("plain-text") ||
    normalized === "text";
}

export function isVectorArtworkType(type: string): boolean {
  const normalized = type.trim().toLowerCase();
  return (
    normalized === "public.svg" ||
    normalized === "image/svg+xml" ||
    normalized === "public.pdf" ||
    normalized === "com.adobe.pdf" ||
    normalized === "public.png" ||
    normalized === "public.tiff" ||
    normalized === "public.jpeg" ||
    normalized.startsWith("image/")
  );
}

export function isCdxType(type: string): boolean {
  const normalized = type.trim().toLowerCase();
  // Match the known binary-CDX MIME/pasteboard identifiers exactly rather than any string
  // containing "cdx" (which would also catch e.g. a hypothetical "text/cdx-markdown" and
  // suppress the plain-text fallback). CDXML is explicitly excluded — it is XML, not CDX.
  return (
    normalized === "chemical/x-cdx" ||
    normalized === "application/x-cdx" ||
    normalized === "application/vnd.cambridgesoft.cdx" ||
    (normalized.includes("chemdraw") && normalized.includes("cdx") && !normalized.includes("cdxml")) ||
    normalized.includes("cambridgesoft") ||
    normalized.includes("perkinelmer") ||
    normalized.includes("revvity")
  );
}

function parseV2000Molfile(molfile: string): ParsedMolfileGraph {
  const lines = molfile.split("\n");
  const countsLineIndex = findV2000CountsLineIndex(lines);
  if (countsLineIndex === -1) {
    throw new Error("V2000 molfile is missing its atom/bond counts line.");
  }

  const countsLine = lines[countsLineIndex] ?? "";
  const counts = countsLine.match(/^\s*(\d+)\s+(\d+)/);
  if (!counts) {
    throw new Error("V2000 molfile is missing its atom/bond counts line.");
  }

  const atomCount = Number(counts[1]);
  const bondCount = Number(counts[2]);
  const atomStartIndex = countsLineIndex + 1;
  const atomLines = lines.slice(atomStartIndex, atomStartIndex + atomCount);
  const bondLines = lines.slice(atomStartIndex + atomCount, atomStartIndex + atomCount + bondCount);
  // Atom-block charges and M CHG charges are kept separate: per the V2000 spec, the
  // presence of ANY M CHG line means every atom-block charge must be treated as zero.
  const atomBlockCharges = new Map<number, number>();
  const chgLineCharges = new Map<number, number>();
  let sawChgLine = false;
  const warnings: ClipboardTransferWarning[] = [];

  const atoms = atomLines.map((line, index): ParsedClipboardAtom => {
    const { x, y, element, chargeCode } = parseV2000AtomLine(line);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`V2000 atom ${index + 1} has invalid coordinates.`);
    }

    const atomLineCharge = chargeFromV2000AtomCode(chargeCode);
    if (atomLineCharge !== 0) {
      atomBlockCharges.set(index + 1, atomLineCharge);
    }

    return {
      id: atomId(index + 1),
      element,
      x,
      y,
      formalCharge: 0
    };
  });

  const bonds = bondLines.map((line, index): ParsedClipboardBond => {
    const { fromIndex, toIndex, orderCode, stereoCode } = parseV2000BondLine(line);
    if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) {
      throw new Error(`V2000 bond ${index + 1} has invalid atom references.`);
    }

    const bondStyle = bondStyleFromV2000Stereo(stereoCode);
    return {
      id: bondId(index + 1),
      fromAtomId: atomId(fromIndex),
      toAtomId: atomId(toIndex),
      order: bondOrderFromMolfile(orderCode),
      ...(bondStyle ? { bondStyle } : {})
    };
  });

  for (const line of lines.slice(atomStartIndex + atomCount + bondCount)) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== "M" || fields[1] !== "CHG") {
      continue;
    }

    sawChgLine = true;
    const pairCount = Number(fields[2] ?? "0");
    for (let index = 0; index < pairCount; index += 1) {
      const atomIndex = Number(fields[3 + index * 2]);
      const charge = Number(fields[4 + index * 2]);
      if (Number.isInteger(atomIndex) && Number.isInteger(charge)) {
        chgLineCharges.set(atomIndex, charge);
      }
    }
  }

  // V2000 spec: any M CHG line supersedes ALL atom-block charges (which otherwise stay
  // as phantom charges on atoms not named in an M CHG entry).
  atoms.forEach((atom, index) => {
    const i = index + 1;
    atom.formalCharge = sawChgLine ? (chgLineCharges.get(i) ?? 0) : (atomBlockCharges.get(i) ?? 0);
  });

  if (atoms.length === 0) {
    warnings.push({
      code: "clipboard.molfile_empty",
      message: "The MOL payload did not contain any atoms."
    });
  }

  return {
    format: "molfile-v2000",
    atoms,
    bonds,
    warnings
  };
}

/**
 * Strip the "M  V30 " prefix and rejoin wrapped lines.
 *
 * V3000 keeps lines within 80 columns by ending a wrapped one with "-" and continuing it on the
 * next "M  V30 " line; the "-" is the marker, not data. Splitting on newlines without rejoining
 * dropped everything past the wrap, so an atom whose CHG= or CFG= fell just past the limit pasted
 * as neutral or unstereo — silently, because the truncated line still parses.
 */
function joinV3000ContinuationLines(rawLines: readonly string[]): string[] {
  const joined: string[] = [];
  let pending: string | undefined;
  for (const raw of rawLines) {
    const isBlockLine = /^M  V30(\s|$)/.test(raw);
    const body = raw.replace(/^M  V30\s+/, "").trim();
    if (pending !== undefined) {
      if (!isBlockLine) {
        // A continuation must be followed by another block line; anything else means the file is
        // malformed. Keep what was read rather than swallowing it.
        joined.push(pending, body);
        pending = undefined;
        continue;
      }
      const merged = pending + body;
      if (merged.endsWith("-")) {
        pending = merged.slice(0, -1);
      } else {
        joined.push(merged);
        pending = undefined;
      }
      continue;
    }
    if (isBlockLine && body.endsWith("-")) {
      pending = body.slice(0, -1);
      continue;
    }
    joined.push(body);
  }
  if (pending !== undefined) {
    joined.push(pending);
  }
  return joined;
}

function parseV3000Molfile(molfile: string): ParsedMolfileGraph {
  const lines = joinV3000ContinuationLines(molfile.split("\n"));
  const warnings: ClipboardTransferWarning[] = [];
  let section: "atom" | "bond" | undefined;
  const atoms: ParsedClipboardAtom[] = [];
  const bonds: ParsedClipboardBond[] = [];

  for (const line of lines) {
    if (line === "BEGIN ATOM") {
      section = "atom";
      continue;
    }
    if (line === "BEGIN BOND") {
      section = "bond";
      continue;
    }
    if (line.startsWith("END ")) {
      section = undefined;
      continue;
    }

    if (section === "atom") {
      const fields = line.split(/\s+/);
      const index = Number(fields[0]);
      const element = fields[1] ?? "C";
      const x = Number(fields[2]);
      const y = Number(fields[3]);
      if (!Number.isInteger(index) || !Number.isFinite(x) || !Number.isFinite(y)) {
        warnings.push({
          code: "clipboard.v3000_atom_skipped",
          message: `Skipped unsupported V3000 atom line: ${line}`
        });
        continue;
      }

      const chargeMatch = line.match(/\bCHG=(-?\d+)\b/);
      atoms.push({
        id: atomId(index),
        element,
        x,
        y,
        formalCharge: chargeMatch ? Number(chargeMatch[1]) : 0
      });
    }

    if (section === "bond") {
      const fields = line.split(/\s+/);
      const index = Number(fields[0]);
      const orderCode = Number(fields[1]);
      const fromIndex = Number(fields[2]);
      const toIndex = Number(fields[3]);
      if (!Number.isInteger(index) || !Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) {
        warnings.push({
          code: "clipboard.v3000_bond_skipped",
          message: `Skipped unsupported V3000 bond line: ${line}`
        });
        continue;
      }

      const cfgMatch = line.match(/\bCFG=(\d+)/);
      const cfg = cfgMatch ? Number(cfgMatch[1]) : 0;
      const bondStyle = cfg === 1 ? "wedge" : cfg === 3 ? "hashed" : undefined; // CFG 2 = either
      bonds.push({
        id: bondId(index),
        fromAtomId: atomId(fromIndex),
        toAtomId: atomId(toIndex),
        order: bondOrderFromMolfile(orderCode),
        ...(bondStyle ? { bondStyle } : {})
      });
    }
  }

  if (atoms.length === 0) {
    warnings.push({
      code: "clipboard.molfile_empty",
      message: "The MOL payload did not contain any atoms."
    });
  }

  return {
    format: "molfile-v3000",
    atoms,
    bonds,
    warnings
  };
}

function normalizeClipboardText(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return decodeMacLengthPrefixedMolfile(normalized) ?? normalized.replace(/\0/g, "");
}

function looksLikeRxnfile(text: string): boolean {
  return text.trimStart().startsWith("$RXN");
}

function looksLikeCdxml(text: string): boolean {
  return /<\s*CDXML\b/i.test(text);
}

/** True for a standard/non-standard InChI string (unambiguous `InChI=` prefix). */
export function looksLikeInchi(text: string): boolean {
  return /^InChI=1S?\//.test(text.trim());
}

/**
 * Cheap pre-filter for "this plain text might be a SMILES" — single whitespace-free
 * token, length ≥ 2, only SMILES grammar characters, and at least one ASCII letter
 * (an element). This NEVER asserts validity (that needs a real parser); the app layer
 * confirms by attempting an OpenChemLib depiction and falls back to plain text on
 * failure. Deliberately not used by `inspectClipboardPayload` — it stays conservative
 * and only classifies plain text as SMILES once the app has actually parsed it.
 */
export function looksLikeSmiles(text: string): boolean {
  const token = text.trim();
  if (token.length < 2 || /\s/.test(token)) return false;
  if (looksLikeInchi(token)) return false;
  if (!/[A-Za-z]/.test(token)) return false;
  return /^[A-Za-z0-9@+\-[\]()=#$%./\\:*]+$/.test(token);
}

function findV2000CountsLineIndex(lines: readonly string[]): number {
  // A V2000 counts line is "aaabbb...  V2000" (atoms, bonds, then 9 more fields + tag).
  // Requiring either the explicit V2000 tag or the full 6+ field shape avoids mis-reading
  // ordinary two-number text (e.g. "42 17 results found") as a counts line.
  return lines.findIndex((line) =>
    /^\s*\d+\s+\d+/.test(line) && (/\bV2000\b/.test(line) || line.trim().split(/\s+/).length >= 6)
  );
}

function decodeMacLengthPrefixedMolfile(text: string): string | undefined {
  if (text.includes("\n") || !/(V2000|V3000|M  END)/.test(text)) {
    return undefined;
  }

  const records: string[] = [];
  let index = 0;
  while (index < text.length) {
    while (index < text.length && text.charCodeAt(index) === 0) {
      index += 1;
    }
    if (index >= text.length) {
      break;
    }

    const recordLength = text.charCodeAt(index);
    const recordStart = index + 1;
    const recordEnd = recordStart + recordLength;
    if (recordLength <= 0 || recordLength > 255 || recordEnd > text.length) {
      return undefined;
    }

    records.push(text.slice(recordStart, recordEnd));
    index = recordEnd;
  }

  const decoded = records.join("\n");
  if (!/(V2000|V3000)/.test(decoded) || !decoded.includes("M  END")) {
    return undefined;
  }

  return decoded;
}

function isCdxmlType(type: string): boolean {
  return type.trim().toLowerCase().includes("cdxml");
}

function isSmilesType(type: string): boolean {
  const normalized = type.trim().toLowerCase();
  return normalized.includes("smiles") || normalized.includes("daylight");
}

function atomId(index: number): string {
  return `atom_${String(index).padStart(3, "0")}`;
}

function bondId(index: number): string {
  return `bond_${String(index).padStart(3, "0")}`;
}

// V2000 is a COLUMNAR fixed-width format, not whitespace-delimited. Two coordinates at
// magnitude ≥100 (e.g. "-123.4567-123.4567") abut with no separator, and atom indices ≥100
// in bond lines ("100200") abut too — both break a naive whitespace split. Parse by column
// offset, falling back to whitespace only for non-conforming writers that under-pad.
function parseV2000AtomLine(line: string): { x: number; y: number; element: string; chargeCode: number } {
  if (line.length >= 34) {
    // x[0,10) y[10,20) z[20,30) symbol[31,34) … charge[36,39)
    return {
      x: Number(line.slice(0, 10)),
      y: Number(line.slice(10, 20)),
      element: line.slice(31, 34).trim() || "C",
      chargeCode: Number(line.slice(36, 39).trim() || "0")
    };
  }
  const fields = line.trim().split(/\s+/);
  return {
    x: Number(fields[0]),
    y: Number(fields[1]),
    element: fields[3] ?? "C",
    chargeCode: Number(fields[5] ?? "0")
  };
}

function parseV2000BondLine(line: string): { fromIndex: number; toIndex: number; orderCode: number; stereoCode: number } {
  // atom1[0,3) atom2[3,6) type[6,9) stereo[9,12), each a 3-char field.
  const columnFrom = Number(line.slice(0, 3));
  const columnTo = Number(line.slice(3, 6));
  if (line.length >= 9 && Number.isInteger(columnFrom) && Number.isInteger(columnTo) && columnFrom > 0 && columnTo > 0) {
    return {
      fromIndex: columnFrom,
      toIndex: columnTo,
      orderCode: Number(line.slice(6, 9).trim() || "0"),
      stereoCode: Number(line.slice(9, 12).trim() || "0")
    };
  }
  const fields = line.trim().split(/\s+/);
  return {
    fromIndex: Number(fields[0]),
    toIndex: Number(fields[1]),
    orderCode: Number(fields[2]),
    stereoCode: Number(fields[3] ?? "0")
  };
}

function bondStyleFromV2000Stereo(code: number): ParsedClipboardBond["bondStyle"] {
  if (code === 1) {
    return "wedge"; // up
  }
  if (code === 6) {
    return "hashed"; // down
  }
  return undefined; // 0 none, 4 either, 3 cis/trans — no native single-bond wedge style
}

function bondOrderFromMolfile(code: number): ParsedClipboardBond["order"] {
  if (code === 1) {
    return "single";
  }
  if (code === 2) {
    return "double";
  }
  if (code === 3) {
    return "triple";
  }
  if (code === 4) {
    return "aromatic";
  }
  return "unknown";
}

function chargeFromV2000AtomCode(code: number): number {
  if (code === 1) {
    return 3;
  }
  if (code === 2) {
    return 2;
  }
  if (code === 3) {
    return 1;
  }
  if (code === 5) {
    return -1;
  }
  if (code === 6) {
    return -2;
  }
  if (code === 7) {
    return -3;
  }
  return 0;
}
