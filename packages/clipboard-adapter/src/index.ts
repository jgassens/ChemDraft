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

  if (/\bV3000\b/.test(normalized) || normalized.includes("M  V30 ")) {
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
  return (
    normalized.includes("chemical/x-cdx") ||
    normalized.includes("cdx") ||
    (normalized.includes("chemdraw") && !normalized.includes("cdxml")) ||
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
  const chargeByAtomIndex = new Map<number, number>();
  const warnings: ClipboardTransferWarning[] = [];

  const atoms = atomLines.map((line, index): ParsedClipboardAtom => {
    const fields = line.trim().split(/\s+/);
    const x = Number(fields[0]);
    const y = Number(fields[1]);
    const element = fields[3] ?? "C";
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`V2000 atom ${index + 1} has invalid coordinates.`);
    }

    const atomLineCharge = chargeFromV2000AtomCode(Number(fields[5] ?? "0"));
    if (atomLineCharge !== 0) {
      chargeByAtomIndex.set(index + 1, atomLineCharge);
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
    const fields = line.trim().split(/\s+/);
    const fromIndex = Number(fields[0]);
    const toIndex = Number(fields[1]);
    const orderCode = Number(fields[2]);
    if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) {
      throw new Error(`V2000 bond ${index + 1} has invalid atom references.`);
    }

    return {
      id: bondId(index + 1),
      fromAtomId: atomId(fromIndex),
      toAtomId: atomId(toIndex),
      order: bondOrderFromMolfile(orderCode)
    };
  });

  for (const line of lines.slice(atomStartIndex + atomCount + bondCount)) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== "M" || fields[1] !== "CHG") {
      continue;
    }

    const pairCount = Number(fields[2] ?? "0");
    for (let index = 0; index < pairCount; index += 1) {
      const atomIndex = Number(fields[3 + index * 2]);
      const charge = Number(fields[4 + index * 2]);
      if (Number.isInteger(atomIndex) && Number.isInteger(charge)) {
        chargeByAtomIndex.set(atomIndex, charge);
      }
    }
  }

  atoms.forEach((atom, index) => {
    atom.formalCharge = chargeByAtomIndex.get(index + 1) ?? 0;
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

function parseV3000Molfile(molfile: string): ParsedMolfileGraph {
  const lines = molfile.split("\n").map((line) => line.replace(/^M  V30\s+/, "").trim());
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

      bonds.push({
        id: bondId(index),
        fromAtomId: atomId(fromIndex),
        toAtomId: atomId(toIndex),
        order: bondOrderFromMolfile(orderCode)
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
  return lines.findIndex((line) =>
    /^\s*\d+\s+\d+/.test(line) && (/\bV2000\b/.test(line) || line.trim().split(/\s+/).length >= 2)
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
