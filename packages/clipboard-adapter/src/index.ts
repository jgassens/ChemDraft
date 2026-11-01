import { MAX_IMAGE_OBJECT_BYTES, normalizeAtomIsotope, isSvgImageSource, readSvgInfo, validatePngImage, validateSvgImage, imagePixelLimitError } from "@chemdraft/chem-core";

export type ClipboardPayloadKind = "svg" | "png" | "text/plain" | "smiles" | "mol" | "rxn" | "cdxml" | "cdx";

export interface ClipboardTransferWarning {
  code: string;
  message: string;
}

export interface ClipboardTextItem {
  type: string;
  text: string;
}

export interface ClipboardImageItem {
  type: "image/png" | "image/svg+xml";
  bytesBase64: string;
  pixelsPerMeter?: { x: number; y: number };
  pixelWidth?: number;
  pixelHeight?: number;
}

export interface ClipboardSkippedImageItem {
  type: string;
  byteLength: number;
  reason: string;
}

// At least 10x main's 64 MiB copy envelope, including Office representations.
export const MAX_CLIPBOARD_BYTES = 1024 * 1024 * 1024;

export interface ClipboardSkippedItem {
  type: string;
  /** Size of this flavor, never the running total. */
  byteLength: number;
  /** Chemistry recognized in a generic text flavor before its bytes were skipped. */
  chemistry?: boolean;
  limitBytes: number;
  /** Missing on older native payloads, which used the per-flavor message. */
  reason?: "flavor" | "total";
  /** Attempted retained total including this flavor, for a total refusal. */
  totalByteLength?: number;
}

export interface ClipboardReadPayload {
  types: string[];
  textItems: ClipboardTextItem[];
  imageItems?: ClipboardImageItem[];
  skippedImageItems?: ClipboardSkippedImageItem[];
  skippedItems?: ClipboardSkippedItem[];
}

export type ClipboardMolfileFormat = "molfile-v2000" | "molfile-v3000";

/** A text heuristic to try with the host chemistry parser, not an assertion of validity. */
export interface ClipboardChemistryCandidate {
  kind: "smiles" | "smiles-list";
  sourceType: string;
  text: string;
}

export type ClipboardDetectedPayload =
  | {
      kind: "size-refused";
      message: string;
      warnings: ClipboardTransferWarning[];
    }
  | {
      kind: "image";
      image: ClipboardImageItem;
      sourceType?: string;
      warnings: ClipboardTransferWarning[];
    }
  | {
      kind: "image-refused";
      message: string;
      warnings: ClipboardTransferWarning[];
    }
  | {
      kind: "plain-text";
      /** For heuristic SMILES lists: picture to paste if host chemistry parsing fails. */
      fallbackImage?: ClipboardImageItem;
      chemistryCandidates?: ClipboardChemistryCandidate[];
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
      /** For text heuristics only: paste this picture if host chemistry parsing fails.
       * Omitted when an unreadable advertised chemistry flavor blocks pictures.
       * The host must validate it through the ordinary picture paste path. */
      fallbackImage?: ClipboardImageItem;
      chemistryCandidates?: ClipboardChemistryCandidate[];
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
  isotope?: number;
  x: number;
  y: number;
  formalCharge: number;
}

export interface ParsedClipboardBond {
  id: string;
  fromAtomId: string;
  toAtomId: string;
  order: "single" | "double" | "triple" | "aromatic" | "unknown";
  stereo?: "either";
  /** Wedge/hash stereo from the source molfile (V2000 stereo 1=up→wedge, 6=down→hashed;
   *  V3000 CFG=1→wedge, CFG=3→hashed). The narrow end of the wedge is `fromAtomId`.
   *  "dashed" is not stereo: it marks a coordination (dative) bond, type 9. */
  bondStyle?: "wedge" | "hashed" | "dashed";
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

function clipboardFlavorName(type: string): string {
  if ((textLikeTypePatterns as readonly string[]).includes(type)) return "text/plain";
  if (["public.png", "PNG", "CF_DIB", "CF_DIBV5"].includes(type)) return "image/png";
  if (["public.svg", "public.svg-image"].includes(type)) return "image/svg+xml";
  return type;
}

export function clipboardSizeRefusalMessage(item: ClipboardSkippedItem): string {
  if (item.reason === "total") {
    return `Couldn't paste: the clipboard contents are too large (${((item.totalByteLength ?? item.byteLength) / (1024 * 1024)).toFixed(1)} MB in total; the limit is ${item.limitBytes / (1024 * 1024)} MB).`;
  }
  return `Couldn't paste: clipboard flavor "${clipboardFlavorName(item.type)}" is too large (${(item.byteLength / (1024 * 1024)).toFixed(1)} MB; the limit is ${item.limitBytes / (1024 * 1024)} MB).`;
}

/** Bound bytes before normalization/decoding; inspect only a bounded chemistry prefix. */
export function guardClipboardPayload(payload: ClipboardReadPayload): ClipboardReadPayload {
  let total = 0;
  const skippedItems = [...payload.skippedItems ?? []];
  const admit = (type: string, byteLength: number, limitBytes: number): boolean => {
    if (byteLength > limitBytes || byteLength > MAX_CLIPBOARD_BYTES - total) {
      skippedItems.push(byteLength > limitBytes
        ? { type, byteLength, limitBytes, reason: "flavor" }
        : { type, byteLength, limitBytes: MAX_CLIPBOARD_BYTES, reason: "total", totalByteLength: total + byteLength });
      return false;
    }
    total += byteLength;
    return true;
  };
  const admittedText = new Set<string>();
  const admitText = (item: ClipboardTextItem): boolean => {
    // Aliases are compared before measuring or charging; only successfully admitted text
    // can suppress a duplicate. Keep the first flavor, which the resolver already prefers.
    if (isTextLikeType(item.type) && admittedText.has(item.text)) return false;
    const byteLength = clipboardTextByteLength(item.text);
    if (byteLength > MAX_CLIPBOARD_BYTES) {
      const admitted = admit(item.type, byteLength, MAX_CLIPBOARD_BYTES);
      if (typeof item.text === "string" && chemistryTextPrefix(item.text)) skippedItems[skippedItems.length - 1]!.chemistry = true;
      return admitted;
    }
    const picture = ["image/svg+xml", "public.svg", "public.svg-image"].includes(item.type)
      || (typeof item.text === "string" && clipboardHasSvgRoot(item.text));
    const admitted = admit(item.type, byteLength, picture ? MAX_IMAGE_OBJECT_BYTES : MAX_CLIPBOARD_BYTES);
    if (!admitted && !picture && typeof item.text === "string" && chemistryTextPrefix(item.text)) skippedItems[skippedItems.length - 1]!.chemistry = true;
    if (admitted) admittedText.add(item.text);
    return admitted;
  };
  const chemistryItem = (item: ClipboardTextItem) => isChemistryClipboardType(item.type)
    || (typeof item.text === "string" && chemistryTextPrefix(item.text));
  const chemistryItems = new Set(payload.textItems.filter(item => chemistryItem(item) && admitText(item)));
  const imageItems = payload.imageItems?.filter(item => {
    // The encoded length bounds decoding too, including excessive whitespace in invalid base64.
    const encoded = item.bytesBase64;
    let byteLength = Math.floor(encoded.length * 3 / 4);
    if (byteLength <= MAX_IMAGE_OBJECT_BYTES + 2) {
      byteLength -= encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    }
    return admit(item.type, byteLength, MAX_IMAGE_OBJECT_BYTES);
  });
  const textItems = payload.textItems.filter(item => chemistryItem(item) ? chemistryItems.has(item) : admitText(item));
  const rejectedTypes = new Set(skippedItems.map(item => item.type));
  return { ...payload, textItems, imageItems, skippedItems,
    types: payload.types.filter(type => !rejectedTypes.has(type) || isChemistryClipboardType(type)) };
}

// Locate SVG source without the trimming/slicing used by the ordinary format detector.
function clipboardHasSvgRoot(text: string): boolean {
  let offset = 0;
  while (offset < text.length) {
    while (offset < text.length && /[\s\uFEFF]/.test(text[offset])) offset += 1;
    const end = text.startsWith("<?", offset) ? "?>" : text.startsWith("<!--", offset) ? "-->" : undefined;
    if (!end) break;
    const closing = text.indexOf(end, offset + 2);
    if (closing < 0) return false;
    offset = closing + end.length;
  }
  const root = /<(?:[A-Za-z_][\w.-]*:)?svg(?=[\s/>]|$)/y;
  root.lastIndex = offset;
  return root.test(text);
}

/** UTF-8 bytes without an allocation; stop at the first byte over the admission ceiling.
 * For a refused value the result is a lower bound, sufficient for refusal and diagnostics. */
export function clipboardTextByteLength(text: string, limit = MAX_CLIPBOARD_BYTES): number {
  // A length-only admission probe can be refused before dereferencing its contents.
  if (typeof text !== "string" || text.length > limit) return text.length;
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
    if (bytes > limit) return bytes;
  }
  return bytes;
}

/** Explicit chemistry must never become a lower-fidelity paste after a size skip. */
export function clipboardChemistrySizeRefusal(payload: ClipboardReadPayload): string | undefined {
  const skipped = payload.skippedItems?.find(item => item.chemistry || isChemistryClipboardType(item.type));
  return skipped ? clipboardSizeRefusalMessage(skipped) : undefined;
}

function chemistryTextPrefix(text: string): boolean {
  // Bounded inspection: do not normalize or scan an entire refused payload.
  const prefix = text.slice(0, 8192).trim();
  return /<CDXML\b|"kind"\s*:\s*"chemdraft-selection"|V[23]000/.test(prefix)
    || prefix.startsWith("$RXN") || prefix.startsWith("InChI=")
    || (prefix.length > 1 && /^[BCNOFPSIHbcnops0-9@+\[\]().=#$*%\-\/\\]+$/.test(prefix));
}

function isChemistryClipboardType(type: string): boolean {
  return type.includes("chemdraft-selection") || isCdxmlType(type) || isCdxType(type) || isSmilesType(type)
    || /(?:molfile|rxnfile|inchi|chemical\/)/i.test(type);
}

export interface ClipboardInspectionOptions {
  /** Defaults to the browser's DOMParser. Pass null for the headless fallback. */
  svgParser?: Pick<DOMParser, "parseFromString"> | null;
}

export function inspectClipboardPayload(payload: ClipboardReadPayload, options: ClipboardInspectionOptions = {}): ClipboardDetectedPayload {
  const bounded = guardClipboardPayload(payload);
  const chemistryRefusal = clipboardChemistrySizeRefusal(bounded);
  if (chemistryRefusal) return { kind: "size-refused", message: chemistryRefusal,
    warnings: [{ code: "clipboard.too_large", message: chemistryRefusal }] };
  const detected = inspectBoundedClipboardPayload(bounded, options);
  const skipped = bounded.skippedItems?.[0];
  if (skipped && (detected.kind === "empty" || detected.kind === "vector-only" || detected.kind === "cdx"
    || (detected.kind === "image-refused" && !bounded.imageItems?.length
      && !bounded.textItems.some(item => clipboardHasSvgRoot(item.text)))
    || (detected.kind === "cdxml" && !detected.text))) {
    const message = clipboardSizeRefusalMessage(skipped);
    return { kind: "size-refused", message, warnings: [{ code: "clipboard.too_large", message }] };
  }
  return { ...detected, warnings: [...detected.warnings, ...(bounded.skippedItems?.map(item => ({
    code: "clipboard.too_large", message: clipboardSizeRefusalMessage(item)
  })) ?? [])] };
}

function inspectBoundedClipboardPayload(payload: ClipboardReadPayload, options: ClipboardInspectionOptions): ClipboardDetectedPayload {
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

  const firstPlainText =
    textItems.find((item) => isTextLikeType(item.type)) ??
    textItems.find((item) => !isMarkupType(item.type));
  const svgText = payload.textItems.find((item) => looksLikeSvgDocument(item.text) ||
    ["image/svg+xml", "public.svg", "public.svg-image"].includes(item.type.trim().toLowerCase()));
  const image = payload.imageItems?.find((item) => item.type === "image/png") ?? payload.imageItems?.[0];
  const skippedImage = payload.skippedImageItems?.[0];
  // Unreadable advertised chemistry blocks only pictures, including a heuristic fallback.
  const suppressPicture = payload.types.some((type) => isCdxmlType(type) || isCdxType(type)
    || isSmilesType(type) || /(?:molfile|rxnfile|inchi|chemical\/)/i.test(type));
  // Text heuristics still need the host's chemistry parser; retain artwork in case parsing fails.
  const hasPicture = image || skippedImage || svgText;
  const pasteableSvgText = svgText;
  const chemistryCandidates: ClipboardChemistryCandidate[] = [];
  if (hasPicture) {
    for (const item of textItems) {
      if (looksLikeSvgDocument(item.text)) continue;
      if (looksLikeSmilesStrict(item.text)) {
        chemistryCandidates.push({ kind: "smiles", text: item.text, sourceType: item.type });
      }
      const tokens = smilesListTokens(item.text);
      const candidates = smilesListCandidates(item.text);
      const firstTokenColumns = new Map<number, number>();
      for (const token of tokens) {
        if (!firstTokenColumns.has(token.line)) firstTokenColumns.set(token.line, token.column);
      }
      if (smilesListDecision({
        candidates: tokens.length,
        parsed: candidates.length,
        lineCount: item.text.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0).length,
        parsedFirstTokenLines: candidates.filter((candidate) => candidate.column === firstTokenColumns.get(candidate.line)).length
      })) {
        chemistryCandidates.push({ kind: "smiles-list", text: item.text, sourceType: item.type });
      }
    }
  }
  const firstCandidate = chemistryCandidates[0];
  if (firstCandidate) {
    let fallbackImage = !suppressPicture ? image : undefined;
    if (!suppressPicture && !image && pasteableSvgText) {
      const source = addMissingSvgNamespaces(pasteableSvgText.text);
      if (!svgClipboardError(source, clipboardTextByteLength(source), options, pasteableSvgText.text) && !validateSvgImage(source).error) {
        fallbackImage = svgTextImage(source);
      }
    }
    if (image?.type === "image/svg+xml" && fallbackImage) {
      try {
        const binary = atob(fallbackImage.bytesBase64);
        const original = new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
        const source = addMissingSvgNamespaces(original);
        if (svgClipboardError(source, clipboardTextByteLength(source), options, original) || validateSvgImage(source).error) fallbackImage = undefined;
        else if (source !== original) fallbackImage = { ...fallbackImage, bytesBase64: svgTextImage(source).bytesBase64 };
      } catch {
        fallbackImage = undefined;
      }
    }
    return { kind: firstCandidate.kind === "smiles" ? "smiles" : "plain-text",
      text: firstCandidate.text, sourceType: firstCandidate.sourceType, warnings: [], chemistryCandidates,
      ...(fallbackImage ? { fallbackImage } : {}) };
  }
  if (image && !suppressPicture) {
    let pastedImage = image;
    try {
      const binary = atob(image.bytesBase64);
      if (binary.length > MAX_IMAGE_OBJECT_BYTES) {
        return refusedImage(`${image.type === "image/png" ? "PNG" : "SVG"} is ${(binary.length / (1024 * 1024)).toFixed(1)} MB; the limit is 25 MB.`);
      }
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      if (image.type === "image/png") {
        const result = validatePngImage(bytes);
        if (result.error) return refusedImage(result.error);
        const limitError = imagePixelLimitError(image.pixelWidth ?? result.info!.pixelWidth, image.pixelHeight ?? result.info!.pixelHeight);
        if (limitError) return refusedImage(limitError);
      } else {
        const original = new TextDecoder().decode(bytes);
        const source = addMissingSvgNamespaces(original);
        const svgError = svgClipboardError(source, clipboardTextByteLength(source), options, original);
        if (svgError) return refusedSvg(svgError);
        const result = validateSvgImage(source);
        if (result.error) return refusedSvg(result.error);
        const info = result.info;
        const limitError = imagePixelLimitError(image.pixelWidth ?? info?.pixelWidth ?? 0, image.pixelHeight ?? info?.pixelHeight ?? 0);
        if (limitError) return refusedImage(limitError);
        if (source !== original) pastedImage = { ...image, bytesBase64: svgTextImage(source).bytesBase64 };
      }
    } catch {
      return refusedImage(`the ${image.type === "image/png" ? "PNG" : "SVG"} has invalid data.`);
    }
    return { kind: "image", image: pastedImage, sourceType: image.type, warnings: [] };
  }
  if (pasteableSvgText && !suppressPicture) {
    const source = addMissingSvgNamespaces(pasteableSvgText.text);
    const byteLength = clipboardTextByteLength(source);
    if (byteLength > MAX_IMAGE_OBJECT_BYTES) {
      return refusedSvg("it exceeds the 25 MB picture limit.");
    }
    const svgError = svgClipboardError(source, byteLength, options, pasteableSvgText.text);
    if (svgError) return refusedSvg(svgError);
    const result = validateSvgImage(source);
    if (result.error) return refusedSvg(result.error);
    return { kind: "image", sourceType: pasteableSvgText.type, warnings: [], image: svgTextImage(source) };
  }
  if (skippedImage && !suppressPicture) return refusedImage(skippedImage.reason);
  if (firstPlainText && !looksLikeSvgDocument(firstPlainText.text)) {
    return {
      kind: "plain-text",
      text: firstPlainText.text,
      sourceType: firstPlainText.type,
      warnings: []
    };
  }

  const cdxmlType = payload.types.find(isCdxmlType);
  if (cdxmlType) {
    return { kind: "cdxml", text: "", sourceType: cdxmlType, warnings: [{
      code: "clipboard.cdxml_not_implemented",
      message: "The clipboard contains CDXML, but CDXML paste parsing is not implemented yet."
    }] };
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

  const vectorType = svgText?.type ?? payload.types.find(isVectorArtworkType);
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

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";

/** Discover namespaces with the bounded scanner, then edit only the root start tag. */
function addMissingSvgNamespaces(source: string): string {
  let root: { tag: string; nameEnd: number; attributes: ReadonlyMap<string, string> } | undefined;
  let usesXlink = false;
  svgDocumentError(source, (tag, nameEnd, attributes, namespaces) => {
    if (!root) {
      root = { tag, nameEnd, attributes };
    }
    if (!namespaces.has("xlink") && (tag.startsWith("xlink:") || [...attributes.keys()].some(name => name.startsWith("xlink:")))) {
      usesXlink = true;
      namespaces.set("xlink", XLINK_NAMESPACE); // Continue discovery through later scopes.
    }
    return false;
  });
  if (!root) return source;
  const declarations = (root.tag !== "svg" || root.attributes.has("xmlns") ? "" : ` xmlns="${SVG_NAMESPACE}"`)
    + (usesXlink && !root.attributes.has("xmlns:xlink") ? ` xmlns:xlink="${XLINK_NAMESPACE}"` : "");
  return declarations ? source.slice(0, root.nameEnd) + declarations + source.slice(root.nameEnd) : source;
}

function xmlError(problem: string): string {
  return `it isn't well-formed XML: ${problem.replace(/[.\s]+$/, "")}.`;
}

/** Bounded, non-executing fallback; a start-tag visitor may stop discovery early. */
function svgDocumentError(text: string, visitStartTag?: (
  tag: string, nameEnd: number, attributes: ReadonlyMap<string, string>, namespaces: Map<string, string>
) => boolean): string | undefined {
  const invalid = xmlError("invalid or incomplete markup");
  if (text.length > MAX_IMAGE_OBJECT_BYTES) return "it exceeds the 25 MB picture limit.";
  let offset = 0;
  const whitespace = /[\s\uFEFF]*/y;
  const name = /[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?/y;
  const skipWhitespace = () => {
    whitespace.lastIndex = offset;
    whitespace.exec(text);
    offset = whitespace.lastIndex;
  };
  const readName = () => {
    name.lastIndex = offset;
    const match = name.exec(text);
    if (!match) return;
    offset = name.lastIndex;
    return match[0];
  };
  const skipDelimited = (end: string) => {
    const index = text.indexOf(end, offset);
    if (index < 0) return false;
    offset = index + end.length;
    return true;
  };
  const commentError = () => {
    const end = text.indexOf("-->", offset + 4);
    if (end < 0) return xmlError("unterminated comment");
    const content = text.slice(offset + 4, end);
    if (content.includes("--") || content.endsWith("-")) {
      const line = text.slice(0, offset).split("\n").length;
      return xmlError(`a comment contains '--' or ends with '-' (line ${line})`);
    }
    offset = end + 3;
    return undefined;
  };
  skipWhitespace();
  while (true) {
    if (text.startsWith("<?", offset)) {
      if (!skipDelimited("?>")) return invalid;
    } else if (text.startsWith("<!--", offset)) {
      const error = commentError();
      if (error) return error;
    } else if (text.startsWith("<!DOCTYPE", offset) && /\s/.test(text[offset + 9] ?? "")) {
      offset += 9;
      let quote = "";
      let depth = 0;
      let ended = false;
      while (offset < text.length) {
        if (!quote && text.startsWith("<!--", offset)) {
          const error = commentError();
          if (error) return error;
          continue;
        }
        const char = text[offset++];
        if (quote) {
          if (char === quote) quote = "";
        } else if (char === '"' || char === "'") quote = char;
        else if (char === "[") depth += 1;
        else if (char === "]") depth -= 1;
        else if (char === ">" && depth === 0) { ended = true; break; }
      }
      if (!ended) return invalid;
    } else break;
    skipWhitespace();
  }
  const stack: { tag: string; namespaces: Map<string, string> }[] = [];
  let rootSeen = false;
  while (offset < text.length) {
    if (text.startsWith("<!--", offset)) {
      const error = commentError();
      if (error) return error;
      continue;
    }
    if (text.startsWith("<?", offset)) {
      if (!skipDelimited("?>")) return invalid;
      continue;
    }
    if (text.startsWith("<![CDATA[", offset) && stack.length) {
      if (!skipDelimited("]]>")) return invalid;
      continue;
    }
    if (text[offset] !== "<") {
      if (!stack.length) {
        skipWhitespace();
        if (offset === text.length) break;
        if (text[offset] !== "<") return invalid;
      } else {
        const next = text.indexOf("<", offset);
        if (next < 0 || invalidXmlText(text.slice(offset, next))) return invalid;
        offset = next;
      }
      continue;
    }
    offset += 1;
    const closing = text[offset] === "/";
    if (closing) offset += 1;
    const tag = readName();
    if (!tag) return invalid;
    const nameEnd = offset;
    if (closing) {
      skipWhitespace();
      const openTag = stack.pop()?.tag;
      if (text[offset++] !== ">" || openTag !== tag) {
        return xmlError(`mismatched closing tag </${tag}>${openTag ? `; expected </${openTag}>` : ""}`);
      }
      continue;
    }
    const isRoot = !rootSeen;
    if (!stack.length && rootSeen) return invalid;
    if (isRoot && tag !== "svg" && !tag.endsWith(":svg")) return invalid;
    const attributes = new Map<string, string>();
    const namespaces = new Map(stack.at(-1)?.namespaces ?? [["xml", XML_NAMESPACE]]);
    let selfClosed = false;
    while (true) {
      const beforeWhitespace = offset;
      skipWhitespace();
      if (text.startsWith("/>", offset)) { offset += 2; selfClosed = true; break; }
      if (text[offset] === ">") { offset += 1; break; }
      if (offset === beforeWhitespace) return invalid;
      const attribute = readName();
      if (!attribute) return invalid;
      if (attributes.has(attribute)) return xmlError(`duplicate attribute '${attribute}'`);
      skipWhitespace();
      if (text[offset++] !== "=") return invalid;
      skipWhitespace();
      const quote = text[offset++];
      if (quote !== '"' && quote !== "'") return invalid;
      const end = text.indexOf(quote, offset);
      if (end < 0 || text.slice(offset, end).includes("<") || invalidXmlText(text.slice(offset, end))) return invalid;
      const value = text.slice(offset, end).replace(/&#(x[\da-fA-F]+|\d+);|&(amp|lt|gt|quot|apos);/g, (_, code: string | undefined, entity: string) =>
        code ? String.fromCodePoint(Number.parseInt(code.startsWith("x") ? code.slice(1) : code, code.startsWith("x") ? 16 : 10))
          : ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[entity]);
      attributes.set(attribute, value);
      if (attribute === "xmlns" || attribute.startsWith("xmlns:")) {
        const prefix = attribute === "xmlns" ? "" : attribute.slice(6);
        if (prefix === "xmlns" || (prefix === "xml" && value !== XML_NAMESPACE) ||
            (prefix !== "xml" && value === XML_NAMESPACE) || value === "http://www.w3.org/2000/xmlns/" || (prefix && !value)) {
          return xmlError(`invalid namespace declaration '${attribute}'`);
        }
        namespaces.set(prefix, value);
      }
      offset = end + 1;
    }
    if (visitStartTag?.(tag, nameEnd, attributes, namespaces)) return undefined;
    const tagPrefix = tag.includes(":") ? tag.split(":")[0] : "";
    if (tagPrefix && !namespaces.get(tagPrefix)) return xmlError(`undeclared namespace prefix '${tagPrefix}' on <${tag}>`);
    const expandedAttributes = new Set<string>();
    for (const attribute of attributes.keys()) {
      if (attribute === "xmlns" || attribute.startsWith("xmlns:")) continue;
      const [prefix, localName] = attribute.includes(":") ? attribute.split(":") : ["", attribute];
      if (prefix && !namespaces.get(prefix)) return xmlError(`undeclared namespace prefix '${prefix}' on attribute '${attribute}'`);
      const expanded = `${prefix ? namespaces.get(prefix) : ""}|${localName}`;
      if (expandedAttributes.has(expanded)) return xmlError(`duplicate attribute '${attribute}'`);
      expandedAttributes.add(expanded);
    }
    if (isRoot && (tagPrefix ? namespaces.get(tagPrefix) !== SVG_NAMESPACE : namespaces.has("") && namespaces.get("") !== SVG_NAMESPACE)) {
      return "the root must be <svg> in the SVG namespace (http://www.w3.org/2000/svg).";
    }
    rootSeen = true;
    if (!selfClosed) stack.push({ tag, namespaces });
    if (stack.length > 256) return "it exceeds the 256-level nesting limit.";
  }
  return rootSeen && stack.length === 0 ? undefined : invalid;
}

function refusedImage(reason: string): ClipboardDetectedPayload {
  const message = reason.startsWith("Couldn't paste the picture:") ? reason : `Couldn't paste the picture: ${reason}`;
  return { kind: "image-refused", message: /[.!?]$/.test(message) ? message : `${message}.`, warnings: [] };
}

function refusedSvg(reason: string): ClipboardDetectedPayload {
  const detail = reason.replace(/^Couldn't paste the picture:\s*/, "");
  return { kind: "image-refused", message: `Couldn't paste the SVG: ${detail}`, warnings: [] };
}

function invalidXmlText(text: string): boolean {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|\]\]>/.test(text) ||
      /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(text)) return true;
  for (const match of text.matchAll(/&#(x[\da-fA-F]+|\d+);/g)) {
    const code = match[1].startsWith("x") ? Number.parseInt(match[1].slice(1), 16) : Number(match[1]);
    if (!(code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0x10ffff)) ||
        (code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff) return true;
  }
  return false;
}

function svgClipboardError(source: string, byteLength: number, options: ClipboardInspectionOptions, original = source): string | undefined {
  if (byteLength > MAX_IMAGE_OBJECT_BYTES) return "it exceeds the 25 MB picture limit.";
  // Refuse declarations before invoking any XML parser: never allow entity expansion.
  const declarationError = svgDeclarationError(source);
  if (declarationError) return declarationError;
  const parser = options.svgParser === undefined
    ? (typeof globalThis.DOMParser === "function" ? new globalThis.DOMParser() : undefined)
    : options.svgParser;
  if (parser) {
    try {
      const document = parser.parseFromString(source, "image/svg+xml");
      // WebKit nests parsererror inside the SVG; Chromium may make it the root.
      const error = document.getElementsByTagNameNS("*", "parsererror")[0];
      if (error) {
        const detail = (error.textContent ?? "XML parsing failed").slice(0, 1000)
          .replace(/^\s*This page contains the following errors:\s*/i, "")
          .replace(/Below is a rendering[\s\S]*/i, "").trim()
          .replace(/^(\d+):(\d+):\s*/, "line $1, column $2: ");
        const positioned = detail.replace(/line (\d+)( at|,)? column (\d+)/gi, (match, line: string, join: string, column: string) => {
          if (source === original) return match;
          let insertion = 0;
          while (insertion < original.length && source[insertion] === original[insertion]) insertion++;
          const before = original.slice(0, insertion).split("\n");
          if (Number(line) !== before.length || Number(column) <= before.at(-1)!.length) return match;
          const adjusted = Math.max(before.at(-1)!.length + 1, Number(column) - (source.length - original.length));
          return `line ${line}${join ?? ""} column ${adjusted}`;
        }).replace(/\s+/g, " ");
        return xmlError(positioned || "XML parsing failed");
      }
      const root = document.documentElement;
      if (root?.localName !== "svg" || root.namespaceURI !== SVG_NAMESPACE) {
        return "the root must be <svg> in the SVG namespace (http://www.w3.org/2000/svg).";
      }
    } catch (error) {
      return xmlError(error instanceof Error ? error.message : "XML parsing failed");
    }
  }
  return svgDocumentError(source) ?? svgContentError(source);
}

function svgDeclarationError(source: string): string | undefined {
  // Lex the raw input. A comment marker inside <?xml ...?> is not a comment.
  let offset = 0;
  while ((offset = source.indexOf("<", offset)) >= 0) {
    const tail = source.slice(offset, offset + 10);
    if (/^<!DOCTYPE/i.test(tail)) return "it contains a document type declaration that isn't allowed.";
    if (/^<!ENTITY/i.test(tail)) return "it contains an entity declaration that isn't allowed.";
    const ending = source.startsWith("<!--", offset) ? "-->" : source.startsWith("<![CDATA[", offset) ? "]]>"
      : source.startsWith("<?", offset) ? "?>" : undefined;
    if (source.startsWith("<?", offset) && !/^<\?xml\s/i.test(tail)) {
      return "it contains a processing instruction that isn't allowed.";
    }
    if (ending) {
      const end = source.indexOf(ending, offset + 2);
      if (end < 0) return xmlError("invalid or incomplete markup");
      offset = end + ending.length;
    } else offset++;
  }
  return undefined;
}

// Validate without rewriting: accepted picture bytes retain their original source.
// Completeness and size are checked before this bounded, non-executing sanitizer.
function svgContentError(source: string): string | undefined {
  const markup = source.replace(/<!--[\s\S]*?-->/g, "");
  const unsafeStyle = (value: string) => {
    const css = value.replace(/\/\*[\s\S]*?\*\//g, "");
    return /\\|@import\b|expression\s*\(/i.test(css) ||
      /url\s*\(/i.test(css.replace(/url\(\s*(["']?)#[A-Za-z_][\w.-]*\1\s*\)/gi, ""));
  };
  const decodeEntities = (value: string) => value.replace(/&(?:#x([\da-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi,
    (_, hex: string | undefined, decimal: string | undefined, name: string | undefined) => {
      if (name) return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[name] ?? "";
      const code = Number.parseInt(hex ?? decimal!, hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    });
  for (const style of markup.matchAll(/<(?:[\w.-]+:)?style\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?style\s*>/g)) {
    const content = style[1].replace(/<!\[CDATA\[|\]\]>/g, "");
    if (unsafeStyle(decodeEntities(content))) return "it contains external links or active content in styles, which isn't allowed.";
  }
  const tags = /<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<([A-Za-z_][\w.:-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/g;
  for (const match of markup.matchAll(tags)) {
    if (!match[1]) continue;
    const tag = match[1].split(":").at(-1)!;
    if (!safeSvgElements.has(tag)) return `it contains a <${tag}> element that isn't allowed.`;
    for (const attribute of match[2].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const name = attribute[1].split(":").at(-1)!.toLowerCase();
      const value = decodeEntities(attribute[2] ?? attribute[3]);
      if (name.startsWith("on")) return `it contains an event handler (${attribute[1]}) that isn't allowed.`;
      if (name === "base" || ((name === "href" || name === "src") && !/^#[A-Za-z_][\w.:-]*$/.test(value))) {
        return "it contains external links or embedded objects, which aren't allowed.";
      }
      if (unsafeStyle(value)) return "it contains external links or active content in styles, which isn't allowed.";
      if (/^xmlns(?::|$)/.test(attribute[1]) && ![
        "http://www.w3.org/2000/svg", "http://www.w3.org/1999/xlink", "http://www.w3.org/XML/1998/namespace"
      ].includes(value)) return "it contains an XML namespace that isn't allowed.";
    }
  }
  return undefined;
}

const safeSvgElements = new Set([
  "svg", "g", "defs", "symbol", "use", "switch", "title", "desc", "metadata", "style",
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "textPath", "a", "image", "clipPath", "mask", "marker", "pattern",
  "linearGradient", "radialGradient", "stop", "filter", "feBlend", "feColorMatrix",
  "feComponentTransfer", "feComposite", "feConvolveMatrix", "feDiffuseLighting",
  "feDisplacementMap", "feDistantLight", "feDropShadow", "feFlood", "feFuncA", "feFuncB",
  "feFuncG", "feFuncR", "feGaussianBlur", "feImage", "feMerge", "feMergeNode",
  "feMorphology", "feOffset", "fePointLight", "feSpecularLighting", "feSpotLight",
  "feTile", "feTurbulence"
]);

function svgTextImage(text: string): ClipboardImageItem {
  const bytes = new TextEncoder().encode(text);
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  }
  return { type: "image/svg+xml", bytesBase64: btoa(chunks.join("")), ...readSvgInfo(text) };
}

function looksLikeSvgDocument(text: string): boolean {
  return isSvgImageSource(text) || /^<(?:[A-Za-z_][\w.-]*:)?svg$/.test(text.trim()) || svgDocumentError(text) === undefined;
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

/**
 * Rich-text flavors whose payload is MARKUP, not the text a person copied: `public.html`,
 * `public.rtf`, WebKit's web archive. Every app that publishes one also publishes a plain-text
 * flavor, so the markup is never the best reading of a clipboard — and taking it as text pastes
 * the source, which is how a copy inside the app's own WebView once pasted "<!DOCTYPE html>"
 * into the drawing as a text box.
 */
export function isMarkupType(type: string): boolean {
  const normalized = type.trim().toLowerCase();
  return (
    normalized.includes("html") ||
    normalized.includes("rtf") ||
    /web[\s-]?archive/.test(normalized)
  );
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

// CTfile V2000 default isotope masses (the reference for its signed mass-difference field),
// not rounded standard atomic weights: notably Cl=35 and Br=79. Unlisted symbols are declined.
const mdlDefaultMass: Readonly<Record<string, number>> = {
  H: 1, He: 4, Li: 7, Be: 9, B: 11, C: 12, N: 14, O: 16, F: 19, Ne: 20,
  Na: 23, Mg: 24, Al: 27, Si: 28, P: 31, S: 32, Cl: 35, Ar: 40, K: 39, Ca: 40,
  Sc: 45, Ti: 48, V: 51, Cr: 52, Mn: 55, Fe: 56, Co: 59, Ni: 58, Cu: 63, Zn: 64,
  Ga: 69, Ge: 74, As: 75, Se: 80, Br: 79, Kr: 84, Rb: 85, Sr: 88, Y: 89, Zr: 90,
  Nb: 93, Mo: 98, Ru: 102, Rh: 103, Pd: 106, Ag: 107, Cd: 114, In: 115, Sn: 120,
  Sb: 121, Te: 130, I: 127, Xe: 132, Cs: 133, Ba: 138, La: 139, Ce: 140,
  Pr: 141, Nd: 142, Sm: 152, Eu: 153, Gd: 158, Tb: 159, Dy: 164, Ho: 165,
  Er: 166, Tm: 169, Yb: 174, Lu: 175, Hf: 180, Ta: 181, W: 184, Re: 187,
  Os: 192, Ir: 193, Pt: 195, Au: 197, Hg: 202, Tl: 205, Pb: 208, Bi: 209
};

function parseV2000Molfile(molfile: string): ParsedMolfileGraph {
  const lines = molfile.split("\n");
  const countsLineIndex = findV2000CountsLineIndex(lines);
  if (countsLineIndex === -1) {
    throw new Error("V2000 molfile is missing its atom/bond counts line.");
  }

  const countsLine = lines[countsLineIndex] ?? "";
  const counts = parseV2000CountsLine(countsLine);
  if (!counts) {
    throw new Error("V2000 molfile is missing its atom/bond counts line.");
  }

  const { atomCount, bondCount } = counts;
  const atomStartIndex = countsLineIndex + 1;
  const atomLines = lines.slice(atomStartIndex, atomStartIndex + atomCount);
  const bondLines = lines.slice(atomStartIndex + atomCount, atomStartIndex + atomCount + bondCount);
  // Atom-block charges and M CHG charges are kept separate: per the V2000 spec, the
  // presence of ANY M CHG line means every atom-block charge must be treated as zero.
  const atomBlockCharges = new Map<number, number>();
  const chgLineCharges = new Map<number, number>();
  const massDifferences = new Map<number, number>();
  const isotopeMasses = new Map<number, number>();
  let sawChgLine = false;
  const warnings: ClipboardTransferWarning[] = [];

  const atoms = atomLines.map((line, index): ParsedClipboardAtom => {
    const { x, y, element, chargeCode, massDifference } = parseV2000AtomLine(line);
    if (!Number.isInteger(massDifference)) {
      throw new Error(`V2000 atom ${index + 1} has an invalid mass difference.`);
    }
    if (massDifference !== 0) massDifferences.set(index + 1, massDifference);
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

    // Some writers use the V3000 coordination type in V2000 bond blocks. Preserve its dative
    // meaning exactly as the V3000 reader does, because treating it as an ordinary single bond
    // would silently change the interaction into a covalent bond.
    const bondStyle = orderCode === 9 ? "dashed" : bondStyleFromV2000Stereo(stereoCode);
    if (orderCode === 9) {
      warnings.push({
        code: "clipboard.v2000_coordination_bond",
        message: `V2000 bond ${index + 1} uses coordination type 9; read as a dative (dashed) single bond.`
      });
    }
    return {
      id: bondId(index + 1),
      fromAtomId: atomId(fromIndex),
      toAtomId: atomId(toIndex),
      order: bondOrderFromMolfile(orderCode),
      ...(orderCode === 2 && stereoCode === 3 ? { stereo: "either" as const } : {}),
      ...(bondStyle ? { bondStyle } : {})
    };
  });

  for (const line of lines.slice(atomStartIndex + atomCount + bondCount)) {
    if (line.trim() === "M  END") break;
    const fields = line.trim().split(/\s+/);
    if (fields[0] === "M" && fields[1] === "ISO") {
      const pairCount = Number(fields[2]);
      if (!Number.isInteger(pairCount) || pairCount < 1 || pairCount > 8) {
        throw new Error("V2000 M ISO line has an invalid entry count.");
      }
      for (let index = 0; index < pairCount; index += 1) {
        const atomIndex = Number(fields[3 + index * 2]);
        const mass = Number(fields[4 + index * 2]);
        if (!Number.isInteger(atomIndex) || !atoms[atomIndex - 1]) {
          throw new Error("V2000 M ISO line has an invalid atom reference.");
        }
        // Validate even an entry subsequently superseded by another property line.
        normalizeAtomIsotope({ ...atoms[atomIndex - 1]!, isotope: mass });
        isotopeMasses.set(atomIndex, mass);
      }
      continue;
    }
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
    // M ISO overrides the mass-difference field only on atoms named in an entry.
    let mass = isotopeMasses.get(i);
    const difference = massDifferences.get(i);
    if (mass === undefined && difference !== undefined) {
      const reference = mdlDefaultMass[atom.element];
      if (reference === undefined) {
        warnings.push({
          code: "clipboard.isotope_default_mass_unknown",
          message: `Atom ${i} (${atom.element}) has mass difference ${difference}; ` +
            "its MDL default mass is unknown."
        });
      } else {
        mass = reference + difference;
      }
    }
    if (mass !== undefined) {
      const normalized = normalizeAtomIsotope({ ...atom, isotope: mass });
      Object.assign(atom, normalized);
      if (normalized.isotope === undefined) delete atom.isotope;
    }
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
    if (line === "M  END") break;
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
      const massMatch = line.match(/\bMASS=([^\s]+)/);
      atoms.push(normalizeAtomIsotope({
        id: atomId(index),
        element,
        ...(massMatch ? { isotope: Number(massMatch[1]) } : {}),
        x,
        y,
        formalCharge: chargeMatch ? Number(chargeMatch[1]) : 0
      }));
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
      // Type 9 is a coordination (dative) bond: it reads back as a single bond with the dashed
      // display style, and a dative bond carries no wedge/hash stereo (CFG stays with real types).
      const bondStyle = orderCode === 9 ? "dashed" : cfg === 1 ? "wedge" : cfg === 3 ? "hashed" : undefined; // CFG 2 = either
      bonds.push({
        id: bondId(index),
        fromAtomId: atomId(fromIndex),
        toAtomId: atomId(toIndex),
        order: bondOrderFromMolfile(orderCode),
        ...(orderCode === 2 && cfg === 2 ? { stereo: "either" as const } : {}),
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
 * failure. `inspectClipboardPayload` uses the stricter pre-filter only when a picture
 * would otherwise hide a plain-text chemistry candidate; the host must still parse it.
 */
export function looksLikeSmiles(text: string): boolean {
  const token = text.trim();
  if (token.length < 2 || /\s/.test(token)) return false;
  if (looksLikeInchi(token)) return false;
  if (!/[A-Za-z]/.test(token)) return false;
  return /^[A-Za-z0-9@+\-[\]()=#$%./\\:*]+$/.test(token);
}

export function looksLikeSmilesStrict(text: string): boolean {
  // Outside bracket atoms and Cl/Br, lowercase letters can only name aromatic atoms.
  // This makes English words free to reject without loading a chemistry engine.
  return looksLikeSmiles(text)
    && !/[a-z]/.test(text.replace(/\[[^\]]*\]|Cl|Br/g, "").replace(/[bcnops]/g, ""));
}

export interface SmilesListCandidate {
  token: string;
  /** One-based position in the original clipboard text, after any surrounding quote. */
  line: number;
  column: number;
}

/** Keep prose tokens for the list decision's ratio and first-token checks, without parsing them. */
export function smilesListTokens(text: string): SmilesListCandidate[] {
  const candidates: SmilesListCandidate[] = [];
  for (const [lineIndex, line] of text.split(/\r\n|\r|\n/).entries()) {
    // Require a separator after bullets so a leading wildcard atom (*CC) stays intact.
    const marker = line.match(/^\s*(?:\d+[.)]|\(\d+\)|[-*•#])(?=\s|$)\s*/)?.[0] ?? "";
    const tokens = [...line.slice(marker.length).matchAll(/[^\s,;]+/g)];
    for (const [tokenIndex, match] of tokens.entries()) {
      let token = match[0];
      let column = marker.length + match.index + 1;
      // Peel CSV quotes and JSON array brackets, but preserve SMILES atom brackets, e.g.
      // [NH4+] and [13CH3]. Only unmatched brackets or brackets around quoted data are wrappers.
      while (token.length > 0) {
        const balance = [...token].reduce((sum, char) => sum + (char === "[" ? 1 : char === "]" ? -1 : 0), 0);
        if (/^["']/.test(token) || (token.startsWith("[") && (balance > 0 || /^\[\s*["'\[]/.test(token)))) {
          token = token.slice(1);
          column += 1;
        } else if (/["']$/.test(token) || (token.endsWith("]") && balance < 0)) {
          token = token.slice(0, -1);
        } else {
          break;
        }
      }
      // A bare atom is unambiguous enough at the start of a short .smi row, but "I like CCO"
      // is prose. Keep that exception here so single-paste detection keeps its length guard.
      const singleAtomRow = tokenIndex === 0 && tokens.length <= 2 && /^[BCNOPSFI]$/.test(token);
      if (looksLikeSmiles(token) || singleAtomRow) {
        candidates.push({ token, line: lineIndex + 1, column });
      }
    }
  }
  return candidates;
}

/** Only plausible atom spellings reach the app's SMILES parser. */
export function smilesListCandidates(text: string): SmilesListCandidate[] {
  // Single letters only reach this list after the row-position check in smilesListTokens.
  return smilesListTokens(text).filter(({ token }) => looksLikeSmilesStrict(token) || /^[BCNOPSFI]$/.test(token));
}

export function smilesListDecision(input: {
  candidates: number;
  parsed: number;
  lineCount: number;
  parsedFirstTokenLines: number;
}): boolean {
  // "Add the CO and CS" (2 of 5 parse) stays prose. A bare space-separated list qualifies
  // by its parse ratio; a .smi file (SMILES then name per line) can qualify by its first tokens.
  return input.parsed >= 2 && (input.parsed / input.candidates >= 0.5
    || (input.lineCount >= 2 && input.parsedFirstTokenLines === input.lineCount));
}

function parseV2000CountsLine(line: string): { atomCount: number; bondCount: number } | undefined {
  // CTfile counts are aaabbb: two right-justified 3-character integers, with no
  // separator when both reach 100 (e.g. 266267). Always try these columns first.
  const atoms = line.slice(0, 3).trim();
  const bonds = line.slice(3, 6).trim();
  if (/^\d+$/.test(atoms) && /^\d+$/.test(bonds)) {
    return { atomCount: Number(atoms), bondCount: Number(bonds) };
  }

  // Some writers omit padding. Accept separate, at-most-three-digit fields only:
  // a longer digit run may contain adjacent fixed-width counts and must not be split.
  const short = line.match(/^\s*(\d{1,3})\s+(\d{1,3})(?=\s|$)/);
  return short ? { atomCount: Number(short[1]), bondCount: Number(short[2]) } : undefined;
}

function findV2000CountsLineIndex(lines: readonly string[]): number {
  // A V2000 counts line is "aaabbb...  V2000" (atoms, bonds, then 9 more fields + tag).
  // Requiring either the explicit V2000 tag or the full 6+ field shape avoids mis-reading
  // ordinary two-number text (e.g. "42 17 results found") as a counts line.
  return lines.findIndex((line) =>
    parseV2000CountsLine(line) !== undefined && (
      /\bV2000\b/.test(line) || line.trim().split(/\s+/).length >= 6 ||
      // Count the remaining fields separately when aaa and bbb abut.
      /^(?:\s+\d+){4,}\s*$/.test(line.slice(6))
    )
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
function parseV2000AtomLine(line: string): {
  x: number; y: number; element: string; chargeCode: number; massDifference: number
} {
  if (line.length >= 34) {
    // x[0,10) y[10,20) z[20,30) symbol[31,34) … charge[36,39)
    return {
      x: Number(line.slice(0, 10)),
      y: Number(line.slice(10, 20)),
      element: line.slice(31, 34).trim() || "C",
      massDifference: Number(line.slice(34, 36).trim() || "0"),
      chargeCode: Number(line.slice(36, 39).trim() || "0")
    };
  }
  const fields = line.trim().split(/\s+/);
  return {
    x: Number(fields[0]),
    y: Number(fields[1]),
    element: fields[3] ?? "C",
    massDifference: Number(fields[4] ?? "0"),
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
  // Bond type 9 is the coordination (dative) bond. The native model carries dative as the dashed
  // display style on a single bond, not as a bond order — each format-specific caller adds the style.
  if (code === 9) {
    return "single";
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
