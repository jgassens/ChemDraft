import {
  docxDrawingReferences, folderOf, inReadingOrder, isOfficeRelationshipType, officeMainPartKind, officeRelationships, pptxSlideDrawingReferences,
  pptxSlideRelationshipIds, readZip, relsPartFor, resolvePartTarget, type OfficeRelationship, type OfficeZipEntry,
} from "./officePackage";
import { isChemDraftOleProgId, readChemDraftOleObject } from "./oleObject";
import { readChemDraftSelectionFromPng, type CarrierReadResult } from "./pngSelection";

/**
 * Find every ChemDraft structure (a carrier PNG, or a ChemDraft embedded OLE object made on
 * Windows) in a .docx or .pptx file. Pure and bounded: the file is untrusted input, so the ZIP
 * layer, the XML layer, the compound-file reader and the carrier reader each enforce their own
 * limits, and this layer adds a lower archive limit, entry-name checks and a picture cap.
 */

/** The file limits, lower than the generic Office ZIP reader's hard limits. */
export const OFFICE_IMPORT_LIMITS = Object.freeze({
  /** Same as the app's open-document limit. */
  maxArchiveBytes: 64 * 1024 * 1024,
  maxEntries: 2000,
  maxEntryBytes: 50 * 1024 * 1024,
  maxInflatedBytes: 200 * 1024 * 1024,
  /** Picture references examined; later ones are reported in one file-level warning. */
  maxPictures: 500,
  /** One carrier's JSON. A large drawing is well under 1 MB. */
  maxCarrierJsonBytes: 8 * 1024 * 1024,
  /** All carriers' JSON together. */
  maxTotalCarrierJsonBytes: 64 * 1024 * 1024,
});

export type OfficeImportLimits = { -readonly [K in keyof typeof OFFICE_IMPORT_LIMITS]: number };

export type OfficeImportErrorCode =
  | "too-large" | "not-zip" | "unsafe-entry-name" | "not-office" | "malformed-package" | "unsupported-runtime";

/** A refusal of the whole file. The message is short and specific enough to show the user. */
export class OfficeImportError extends Error {
  constructor(readonly code: OfficeImportErrorCode, message: string, readonly detail?: string) {
    super(message);
    this.name = "OfficeImportError";
  }
}

export type OfficeFileKind = "word" | "powerpoint";

export type OfficeStructureSource =
  | { kind: "slide"; slide: number }
  | { kind: "paragraph"; paragraph: number };

export interface OfficeStructure {
  /**
   * 1-based position among every picture checked: slides in order, each slide's pictures and
   * objects left to right, then top to bottom; a Word document's in body order.
   */
  picture: number;
  source: OfficeStructureSource;
  /** Plain words for the source: "slide 2", "paragraph 14". */
  location: string;
  /**
   * The package part holding the PNG, e.g. `ppt/media/image3.png`, or the embedded object, e.g.
   * `word/embeddings/oleObject1.bin`.
   */
  mediaPart: string;
  /** The carrier's exact UTF-8 JSON. */
  json: string;
  /**
   * The parsed carrier envelope: a `chemdraft-selection` object of a supported version. The
   * caller validates the drawing with the app's own native reader before inserting it.
   */
  document: Record<string, unknown>;
}

export type OfficeCarrierWarningReason = "malformed" | "unknown-version" | "too-large" | "unsupported";

export interface OfficeCarrierWarning {
  picture: number;
  source: OfficeStructureSource;
  location: string;
  mediaPart?: string;
  reason: OfficeCarrierWarningReason;
  message: string;
}

export interface OfficeImportResult {
  kind: OfficeFileKind;
  structures: OfficeStructure[];
  /** Per-picture: a carrier is present but cannot be used. Pictures without a carrier are not listed. */
  warnings: OfficeCarrierWarning[];
  /** File-level notes, such as pictures beyond the picture cap. */
  notes: string[];
  /** Picture references examined (pictures with and without a carrier). */
  picturesChecked: number;
}

export const SUPPORTED_CARRIER_VERSIONS: readonly number[] = [1];

/** A carrier's text from a picture (`CarrierReadResult`) or from a ChemDraft OLE object's document stream. */
export type CarrierText = Exclude<CarrierReadResult, { kind: "found" }> | { kind: "found"; json: string };

export type CarrierEnvelope =
  | { ok: true; json: string; document: Record<string, unknown> }
  /** `phrase` completes "The structure on slide 2 …" or "The copied structure …". */
  | { ok: false; reason: OfficeCarrierWarningReason; phrase: string };

/**
 * Turn one carrier read into the parsed `chemdraft-selection` envelope of a supported version, or
 * the reason it is unusable. Shared by the file importer and clipboard paste-back, so both refuse
 * the same carriers with the same words. `admitJsonBytes` may refuse by size (a phrase) before the
 * JSON is parsed. Returns undefined for a picture without a carrier.
 */
export function readCarrierEnvelope(
  read: CarrierText, maxJsonBytes: number, admitJsonBytes?: (bytes: number) => string | undefined,
): CarrierEnvelope | undefined {
  if (read.kind === "absent") return undefined;
  if (read.kind === "unsupported") return { ok: false, reason: "unsupported", phrase: `could not be read on this system: ${read.reason}` };
  if (read.kind === "invalid") {
    return { ok: false, reason: /limit/.test(read.reason) ? "too-large" : "malformed", phrase: `has damaged ChemDraft data: ${read.reason}` };
  }
  const jsonBytes = new TextEncoder().encode(read.json).length;
  if (jsonBytes > maxJsonBytes) {
    return { ok: false, reason: "too-large", phrase: `is larger than the ${megabytes(maxJsonBytes)} limit for one structure.` };
  }
  const refusal = admitJsonBytes?.(jsonBytes);
  if (refusal !== undefined) return { ok: false, reason: "too-large", phrase: refusal };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.json);
  } catch {
    return { ok: false, reason: "malformed", phrase: "has damaged ChemDraft data: it is not valid JSON." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
      (parsed as { kind?: unknown }).kind !== "chemdraft-selection") {
    return { ok: false, reason: "malformed", phrase: "has damaged ChemDraft data: it is not a ChemDraft drawing." };
  }
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== "number" || !SUPPORTED_CARRIER_VERSIONS.includes(version)) {
    return { ok: false, reason: "unknown-version", phrase: `was made by a newer or unknown ChemDraft (data version ${
      typeof version === "number" || typeof version === "string" ? String(version).slice(0, 20) : "missing"}).` };
  }
  return { ok: true, json: read.json, document: parsed as Record<string, unknown> };
}

function limitsWith(overrides: Partial<OfficeImportLimits>): OfficeImportLimits {
  const limits: OfficeImportLimits = { ...OFFICE_IMPORT_LIMITS };
  for (const [key, value] of Object.entries(overrides) as [keyof OfficeImportLimits, number | undefined][]) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid Office import limit: ${key}.`);
    // Overrides may only tighten a limit, never loosen it.
    limits[key] = Math.min(value, OFFICE_IMPORT_LIMITS[key]);
  }
  return limits;
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * Entry names are package part names: forward-slash paths relative to the package root. Nothing here
 * writes them to disk, but a name that would escape a folder, or that only some platforms read as a
 * path, is a sign of a crafted file and is refused rather than silently ignored.
 */
export function unsafeEntryNameReason(name: string): string | undefined {
  if (name.includes("\\")) return "contains a backslash";
  if (name.startsWith("/")) return "is an absolute path";
  if (/^[A-Za-z]:/.test(name)) return "starts with a drive letter";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return "contains a control character";
  if (name.split("/").some((segment) => segment === ".." || segment === ".")) return "contains a '.' or '..' segment";
  return undefined;
}

const xmlDecoders = {
  "utf-8": new TextDecoder("utf-8", { fatal: true }),
  "utf-16le": new TextDecoder("utf-16le", { fatal: true }),
  "utf-16be": new TextDecoder("utf-16be", { fatal: true }),
};

/** Only metadata is needed before we know which image and object parts are referenced. */
function isXmlEntry(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".xml") || lower.endsWith(".rels");
}

function locationOf(source: OfficeStructureSource): string {
  return source.kind === "slide" ? `slide ${source.slide}` : `paragraph ${source.paragraph}`;
}

interface PictureRef {
  source: OfficeStructureSource;
  /** Set for an embedded OLE object: the ProgID its markup names. */
  oleProgId?: string;
  /** Undefined for an irrelevant relationship, null for an invalid package path. */
  target?: string | null;
}

type CachedCarrier =
  | { kind: "envelope"; envelope: CarrierEnvelope | undefined; jsonBytes: number }
  | { kind: "unreadable-object"; reason: string; knownClass: boolean };

/**
 * Read every ChemDraft structure in a Word (.docx) or PowerPoint (.pptx) file, in reading order:
 * a Word document's in body order, a deck's slide by slide, each slide's by place on the slide.
 * Throws `OfficeImportError` when the file itself is refused (too large, not a ZIP, crafted entry
 * names, not a Word or PowerPoint package); returns per-picture warnings for unusable carriers.
 * `limits` may only lower the built-in limits (tests use it to check the bounds cheaply).
 */
export async function importOfficeStructures(
  bytes: Uint8Array, options: { limits?: Partial<OfficeImportLimits> } = {},
): Promise<OfficeImportResult> {
  const limits = limitsWith(options.limits ?? {});
  if (bytes.length > limits.maxArchiveBytes) {
    throw new OfficeImportError("too-large",
      `The file is larger than the ${megabytes(limits.maxArchiveBytes)} limit for importing structures.`);
  }
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new OfficeImportError("not-zip", "The file is not a Word (.docx) or PowerPoint (.pptx) file.");
  }

  const zipCaps = {
    maxArchiveBytes: limits.maxArchiveBytes,
    maxEntries: limits.maxEntries,
    maxEntryBytes: limits.maxEntryBytes,
    maxInflatedBytes: limits.maxInflatedBytes,
  };
  let entries: OfficeZipEntry[];
  try {
    entries = await readZip(bytes, { ...zipCaps, include: isXmlEntry });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && "code" in error && error.code === "unsupported-decompression") {
      throw new OfficeImportError("unsupported-runtime", "This system cannot decompress the file.", detail);
    }
    if (/exceeds \d+ entries/.test(detail)) {
      throw new OfficeImportError("too-large",
        `The file has more than ${limits.maxEntries} parts, the limit for importing structures.`, detail);
    }
    if (/exceeds/.test(detail)) {
      throw new OfficeImportError("too-large",
        `The file expands beyond the limits for importing structures (${detail.replace(/\.$/, "")}).`, detail);
    }
    throw new OfficeImportError("not-zip", `The file is damaged or is not a Word or PowerPoint file (${detail.replace(/\.$/, "")}).`, detail);
  }

  for (const { name } of entries) {
    const reason = unsafeEntryNameReason(name);
    if (reason) {
      throw new OfficeImportError("unsafe-entry-name",
        `The file was refused because an entry name ${reason}: "${name.slice(0, 120)}".`);
    }
  }
  // Part names are case-insensitive in OPC; refuse a package that relies on case to tell parts apart.
  const parts = new Map<string, OfficeZipEntry>();
  for (const entry of entries) {
    const key = entry.name.toLowerCase();
    if (parts.has(key)) {
      throw new OfficeImportError("unsafe-entry-name", `The file was refused because two entries share the name "${entry.name.slice(0, 120)}".`);
    }
    parts.set(key, entry);
  }

  const text = (name: string): string | undefined => {
    const entry = parts.get(name.toLowerCase());
    if (!entry || entry.skipped) return undefined;
    const [first, second] = entry.data;
    const encoding = first === 0xff && second === 0xfe ? "utf-16le"
      : first === 0xfe && second === 0xff ? "utf-16be" : "utf-8";
    try {
      return xmlDecoders[encoding].decode(entry.data);
    } catch {
      throw new OfficeImportError("malformed-package", `The file's part ${name} is not valid ${encoding.toUpperCase()} XML.`);
    }
  };
  const malformed = (what: string, error: unknown): OfficeImportError => {
    const detail = error instanceof Error ? error.message : String(error);
    return new OfficeImportError("malformed-package", `The file's ${what} could not be read (${detail.replace(/\.$/, "")}).`, detail);
  };
  const relationshipsOf = (part: string): Map<string, OfficeRelationship> => {
    const xml = text(relsPartFor(part));
    if (xml === undefined) return new Map();
    try {
      return officeRelationships(xml);
    } catch (error) {
      throw malformed(`relationships for ${part}`, error);
    }
  };

  const rootRelationships = relationshipsOf("");
  const main = [...rootRelationships.values()].find((relationship) =>
    !relationship.external && isOfficeRelationshipType(relationship.type, "officeDocument"));
  const mainPart = main && resolvePartTarget("", main.target);
  const mainXml = mainPart ? text(mainPart) : undefined;
  if (!mainPart || mainXml === undefined) {
    throw new OfficeImportError("not-office", "The file is not a Word (.docx) or PowerPoint (.pptx) file.");
  }
  let kind: ReturnType<typeof officeMainPartKind>;
  try {
    kind = officeMainPartKind(mainXml);
  } catch (error) {
    throw malformed(`main part ${mainPart}`, error);
  }
  if (kind === "other") {
    throw new OfficeImportError("not-office",
      "The file is an Office package but not a Word document or PowerPoint presentation.");
  }

  const pictureRefs: PictureRef[] = [];
  let picturesFound = 0;
  const addPicture = (source: OfficeStructureSource, ownerPart: string, relationships: ReadonlyMap<string, OfficeRelationship>,
    relationshipId: string, oleProgId: string | undefined) => {
    const relationship = relationships.get(relationshipId);
    const type = oleProgId === undefined ? "image" : "oleObject";
    const target = relationship && !relationship.external && isOfficeRelationshipType(relationship.type, type)
      ? resolvePartTarget(folderOf(ownerPart), relationship.target) : undefined;
    pictureRefs.push({ source, oleProgId, target });
  };
  const mainRelationships = relationshipsOf(mainPart);
  if (kind === "word") {
    let references;
    try {
      references = docxDrawingReferences(mainXml);
    } catch (error) {
      throw malformed(`document body ${mainPart}`, error);
    }
    picturesFound = references.length;
    for (const { relationshipId, paragraph, oleProgId } of references.slice(0, limits.maxPictures)) {
      addPicture({ kind: "paragraph", paragraph }, mainPart, mainRelationships, relationshipId, oleProgId);
    }
  } else {
    let slideIds: string[];
    try {
      slideIds = pptxSlideRelationshipIds(mainXml);
    } catch (error) {
      throw malformed(`slide list ${mainPart}`, error);
    }
    const seenParts = new Set<string>();
    const slideParts = slideIds.map((slideId) => {
      const relationship = mainRelationships.get(slideId);
      const part = relationship && !relationship.external && isOfficeRelationshipType(relationship.type, "slide")
        ? resolvePartTarget(folderOf(mainPart), relationship.target) : null;
      if (part) {
        const key = part.toLowerCase();
        if (seenParts.has(key)) throw malformed(`slide list ${mainPart}`, `Duplicate slide part: ${part}.`);
        seenParts.add(key);
      }
      return part;
    });
    for (const [index, slidePart] of slideParts.entries()) {
      const slide = index + 1;
      const slideXml = slidePart ? text(slidePart) : undefined;
      if (!slidePart || slideXml === undefined) continue;
      let references: ReturnType<typeof pptxSlideDrawingReferences>;
      try {
        references = pptxSlideDrawingReferences(slideXml);
      } catch (error) {
        throw malformed(`slide ${slide}`, error);
      }
      picturesFound += references.length;
      const remaining = limits.maxPictures - pictureRefs.length;
      if (!remaining || !references.length) continue;
      const relationships = relationshipsOf(slidePart);
      // A slide reads left to right, then top to bottom, whatever order its shapes are stacked in.
      for (const { relationshipId, oleProgId } of inReadingOrder(references, (reference) => reference.box).slice(0, remaining)) {
        addPicture({ kind: "slide", slide }, slidePart, relationships, relationshipId, oleProgId);
      }
    }
  }

  const notes: string[] = [];
  if (picturesFound > pictureRefs.length) {
    notes.push(`Only the first ${pictureRefs.length} of ${picturesFound} pictures were checked for ChemDraft structures.`);
  }
  // Both passes validate the same archive-wide inflated-size budget. Inflate each selected
  // part once, and only load media referenced by the retained pictures and embedded objects.
  const mediaParts = new Set<string>();
  for (const { target } of pictureRefs) {
    const key = target?.toLowerCase();
    if (key && parts.get(key)?.skipped) mediaParts.add(key);
  }
  if (mediaParts.size) {
    try {
      const media = await readZip(bytes, { ...zipCaps, include: (name) => mediaParts.has(name.toLowerCase()) });
      for (const entry of media) if (!entry.skipped) parts.set(entry.name.toLowerCase(), entry);
    } catch (error) {
      throw malformed("referenced media", error);
    }
  }

  const structures: OfficeStructure[] = [];
  const warnings: OfficeCarrierWarning[] = [];
  const readByPart = new Map<string, CachedCarrier>();
  let remainingJsonBytes = limits.maxTotalCarrierJsonBytes;
  const totalLimit: CarrierEnvelope = { ok: false, reason: "too-large",
    phrase: `was not read: the file's structures together exceed ${megabytes(limits.maxTotalCarrierJsonBytes)}.` };
  const readPart = async (entry: OfficeZipEntry, embedded: boolean): Promise<CachedCarrier> => {
    let read: CarrierText;
    if (embedded) {
      const object = readChemDraftOleObject(entry.data, limits.maxCarrierJsonBytes);
      if (object.kind === "invalid") return { kind: "unreadable-object", reason: object.reason, knownClass: !!object.clsid };
      if (object.kind === "too-large") {
        return { kind: "envelope", jsonBytes: 0, envelope: { ok: false, reason: "too-large",
          phrase: `is larger than the ${megabytes(limits.maxCarrierJsonBytes)} limit for one structure.` } };
      }
      read = object.kind === "chemdraft" ? { kind: "found", json: object.json } : { kind: "absent" };
    } else {
      read = await readChemDraftSelectionFromPng(entry.data);
    }
    let jsonBytes = 0;
    const envelope = readCarrierEnvelope(read, limits.maxCarrierJsonBytes, (size) => {
      if (size > remainingJsonBytes) return totalLimit.phrase;
      jsonBytes = size;
      return undefined;
    });
    // Only a successful envelope retains decoded text. The aggregate budget shrinks throughout
    // the import, so a refusal can be reused even if other pictures reference the same part.
    return { kind: "envelope", envelope, jsonBytes };
  };

  for (const [index, { source, oleProgId, target: mediaPart }] of pictureRefs.entries()) {
    const picture = index + 1;
    const location = locationOf(source);
    const embedded = oleProgId !== undefined;
    if (mediaPart === undefined) continue;
    if (mediaPart === null) {
      warnings.push({ picture, source, location, reason: "malformed",
        message: `The ${embedded ? "object" : "picture"} on ${location} points outside the file, so it was not read.` });
      continue;
    }
    const entry = parts.get(mediaPart.toLowerCase());
    const warnUnreadableObject = (part: string, reason: string) => {
      warnings.push({ picture, source, location, mediaPart: part, reason: "malformed",
        message: `The embedded ChemDraft object on ${location} could not be read: ${reason}. ` +
          "Open the file in Word or PowerPoint on Windows, copy the object and paste it into ChemDraft." });
    };
    if (!entry || entry.skipped) {
      if (isChemDraftOleProgId(oleProgId)) warnUnreadableObject(mediaPart, `the embedded part ${mediaPart} is missing`);
      continue;
    }
    if (!embedded && (entry.data[0] !== 0x89 || entry.data[1] !== 0x50)) continue;
    const key = `${embedded ? "ole" : "png"}:${entry.name}`;
    const cached = readByPart.get(key);
    const read = cached ?? await readPart(entry, embedded);
    if (!cached) readByPart.set(key, read);
    if (read.kind === "unreadable-object") {
      if (read.knownClass || isChemDraftOleProgId(oleProgId)) warnUnreadableObject(entry.name, read.reason);
      continue;
    }
    // A repeated part is read once, but every placement shares the same byte budget.
    const fits = read.jsonBytes <= remainingJsonBytes;
    const envelope = fits ? read.envelope : totalLimit;
    if (fits) remainingJsonBytes -= read.jsonBytes;
    if (!envelope) continue;
    if (!envelope.ok) {
      warnings.push({ picture, source, location, mediaPart: entry.name, reason: envelope.reason,
        message: `The structure on ${location} ${envelope.phrase}` });
      continue;
    }
    // Each admitted placement owns its parsed drawing, even when it shares the carrier text.
    const document = cached ? JSON.parse(envelope.json) as Record<string, unknown> : envelope.document;
    structures.push({ picture, source, location, mediaPart: entry.name, json: envelope.json, document });
  }

  return { kind, structures, warnings, notes, picturesChecked: pictureRefs.length };
}
