import {
  docxDrawingReferences, folderOf, isOfficeRelationshipType, officeMainPartKind, officeRelationships, pptxSlideDrawingReferences,
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
  /** 1-based position among every picture checked, in document order. */
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

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** Bytes of the PNG pictures we may need, and the XML parts that lead to them. */
function wantedEntry(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".xml") || lower.endsWith(".rels") || lower.endsWith(".png");
}

function locationOf(source: OfficeStructureSource): string {
  return source.kind === "slide" ? `slide ${source.slide}` : `paragraph ${source.paragraph}`;
}

interface PictureRef {
  source: OfficeStructureSource;
  relationshipId: string;
  /** Set for an embedded OLE object: the ProgID its markup names. */
  oleProgId?: string;
  ownerPart: string;
  relationships: ReadonlyMap<string, OfficeRelationship>;
}

/**
 * Read every ChemDraft structure in a Word (.docx) or PowerPoint (.pptx) file, in document order.
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

  let entries: OfficeZipEntry[];
  try {
    entries = await readZip(bytes, {
      maxArchiveBytes: limits.maxArchiveBytes,
      maxEntries: limits.maxEntries,
      maxEntryBytes: limits.maxEntryBytes,
      maxInflatedBytes: limits.maxInflatedBytes,
      include: wantedEntry,
    });
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
    if (!entry) return undefined;
    try {
      return decoder.decode(entry.data);
    } catch {
      throw new OfficeImportError("malformed-package", `The file's part ${name} is not valid UTF-8 XML.`);
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
  const mainRelationships = relationshipsOf(mainPart);
  if (kind === "word") {
    let references;
    try {
      references = docxDrawingReferences(mainXml);
    } catch (error) {
      throw malformed(`document body ${mainPart}`, error);
    }
    for (const { relationshipId, paragraph, oleProgId } of references) {
      pictureRefs.push({ source: { kind: "paragraph", paragraph }, relationshipId, ...(oleProgId === undefined ? {} : { oleProgId }),
        ownerPart: mainPart, relationships: mainRelationships });
    }
  } else {
    let slideIds: string[];
    try {
      slideIds = pptxSlideRelationshipIds(mainXml);
    } catch (error) {
      throw malformed(`slide list ${mainPart}`, error);
    }
    for (const [index, slideId] of slideIds.entries()) {
      const slide = index + 1;
      const relationship = mainRelationships.get(slideId);
      const slidePart = relationship && !relationship.external && isOfficeRelationshipType(relationship.type, "slide")
        ? resolvePartTarget(folderOf(mainPart), relationship.target) : null;
      const slideXml = slidePart ? text(slidePart) : undefined;
      if (!slidePart || slideXml === undefined) continue;
      let references: ReturnType<typeof pptxSlideDrawingReferences>;
      try {
        references = pptxSlideDrawingReferences(slideXml);
      } catch (error) {
        throw malformed(`slide ${slide}`, error);
      }
      const relationships = relationshipsOf(slidePart);
      for (const { relationshipId, oleProgId } of references) {
        pictureRefs.push({ source: { kind: "slide", slide }, relationshipId, ...(oleProgId === undefined ? {} : { oleProgId }),
          ownerPart: slidePart, relationships });
      }
    }
  }

  const notes: string[] = [];
  if (pictureRefs.length > limits.maxPictures) {
    notes.push(`Only the first ${limits.maxPictures} of ${pictureRefs.length} pictures were checked for ChemDraft structures.`);
  }
  const checkedRefs = pictureRefs.slice(0, limits.maxPictures);
  // An embedded object's own part is inflated only when the document places the object, in a
  // second, equally bounded pass over the same archive.
  const objectParts = new Set<string>();
  for (const ref of checkedRefs) {
    const relationship = ref.oleProgId === undefined ? undefined : ref.relationships.get(ref.relationshipId);
    if (!relationship || relationship.external || !isOfficeRelationshipType(relationship.type, "oleObject")) continue;
    const part = resolvePartTarget(folderOf(ref.ownerPart), relationship.target);
    if (part && parts.get(part.toLowerCase())?.skipped) objectParts.add(part.toLowerCase());
  }
  if (objectParts.size) {
    try {
      const objects = await readZip(bytes, {
        maxArchiveBytes: limits.maxArchiveBytes,
        maxEntries: limits.maxEntries,
        maxEntryBytes: limits.maxEntryBytes,
        maxInflatedBytes: limits.maxInflatedBytes,
        include: (name) => objectParts.has(name.toLowerCase()),
      });
      for (const entry of objects) if (!entry.skipped) parts.set(entry.name.toLowerCase(), entry);
    } catch (error) {
      throw malformed("embedded objects", error);
    }
  }

  const structures: OfficeStructure[] = [];
  const warnings: OfficeCarrierWarning[] = [];
  const readByPart = new Map<string, Awaited<ReturnType<typeof readChemDraftSelectionFromPng>>>();
  let totalJsonBytes = 0;

  for (const [index, ref] of checkedRefs.entries()) {
    const picture = index + 1;
    const { source } = ref;
    const location = locationOf(source);
    const relationship = ref.relationships.get(ref.relationshipId);
    const embedded = ref.oleProgId !== undefined;
    // Linked (external) pictures and objects, and other relationships, cannot hold a drawing.
    if (!relationship || relationship.external || !isOfficeRelationshipType(relationship.type, embedded ? "oleObject" : "image")) continue;
    const mediaPart = resolvePartTarget(folderOf(ref.ownerPart), relationship.target);
    if (!mediaPart) {
      warnings.push({ picture, source, location, reason: "malformed",
        message: `The ${embedded ? "object" : "picture"} on ${location} points outside the file, so it was not read.` });
      continue;
    }
    const entry = parts.get(mediaPart.toLowerCase());
    let read: CarrierText;
    if (embedded) {
      if (!entry || entry.skipped) continue;
      // The object's class decides, not its preview: a ChemDraft object's preview holds no carrier.
      const object = readChemDraftOleObject(entry.data, limits.maxCarrierJsonBytes);
      if (object.kind === "other") continue; // another program's object
      if (object.kind === "too-large") {
        warnings.push({ picture, source, location, mediaPart: entry.name, reason: "too-large",
          message: `The structure on ${location} is larger than the ${megabytes(limits.maxCarrierJsonBytes)} limit for one structure.` });
        continue;
      }
      if (object.kind === "invalid") {
        if (!isChemDraftOleProgId(ref.oleProgId) && !object.clsid) continue; // unreadable, and not marked as ChemDraft's
        warnings.push({ picture, source, location, mediaPart: entry.name, reason: "malformed",
          message: `The embedded ChemDraft object on ${location} could not be read: ${object.reason}. ` +
            "Open the file in Word or PowerPoint on Windows, copy the object and paste it into ChemDraft." });
        continue;
      }
      read = { kind: "found", json: object.json };
    } else {
      if (!entry || entry.skipped || entry.data[0] !== 0x89 || entry.data[1] !== 0x50) continue; // not a PNG
      let png = readByPart.get(entry.name);
      if (!png) {
        png = await readChemDraftSelectionFromPng(entry.data);
        readByPart.set(entry.name, png);
      }
      read = png;
    }
    const envelope = readCarrierEnvelope(read, limits.maxCarrierJsonBytes, (jsonBytes) => {
      if (totalJsonBytes + jsonBytes > limits.maxTotalCarrierJsonBytes) {
        return `was not read: the file's structures together exceed ${megabytes(limits.maxTotalCarrierJsonBytes)}.`;
      }
      totalJsonBytes += jsonBytes;
      return undefined;
    });
    if (!envelope) continue;
    if (!envelope.ok) {
      warnings.push({ picture, source, location, mediaPart: entry.name, reason: envelope.reason,
        message: `The structure on ${location} ${envelope.phrase}` });
      continue;
    }
    structures.push({ picture, source, location, mediaPart: entry.name, json: envelope.json, document: envelope.document });
  }

  return { kind, structures, warnings, notes, picturesChecked: Math.min(pictureRefs.length, limits.maxPictures) };
}
