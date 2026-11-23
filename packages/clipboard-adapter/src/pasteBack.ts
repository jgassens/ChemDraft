import { MAX_IMAGE_OBJECT_BYTES } from "@chemdraft/chem-core";
import { decodeBase64Bounded } from "./carrierBytes";
import type { ClipboardReadPayload } from "./index";
import {
  OFFICE_IMPORT_LIMITS, readCarrierEnvelope, unsafeEntryNameReason, type CarrierText, type OfficeCarrierWarningReason,
} from "./officeImport";
import { isChemDraftOleClassId } from "./oleObject";
import {
  drawingPictureReferences, folderOf, inReadingOrder, isOfficeRelationshipType, officeRelationships, readZip, relsPartFor, resolvePartTarget,
  type OfficeRelationship, type OfficeZipEntry,
} from "./officePackage";
import { CHEMDRAFT_PNG_SELECTION_KEYWORD, readChemDraftSelectionFromPng } from "./pngSelection";

/**
 * Paste-back (docs/architecture/office-editing.md, slice 3): the user copies a ChemDraft structure
 * picture in Word or PowerPoint and pastes it into ChemDraft. Office's PNG rendition may be
 * re-encoded without the carrier chunk, but its picture archive (GVML, a ZIP) keeps the original
 * media bytes. Pure and bounded: the clipboard is untrusted input. Reads, in order:
 *
 * 1. A copied ChemDraft OLE object (Windows "Embedded Object" or "Embed Source"): the native reader
 *    checks the object's class and reads its `ChemDraftDocument` stream with the OLE server's own
 *    storage reader; here its class is checked again and its text is judged like a carrier's.
 *    Another program's object is ignored.
 * 2. The GVML archive, with the slice 0 ZIP and relationship readers and the carrier reader.
 * 3. The PNG rendition, with the same carrier reader (ChemDraft's own PNG, or Office's when it kept
 *    the chunk).
 * 4. EMF/EMF+ is not read: ChemDraft has no EMF reader (its only EMF code is the Windows preview
 *    writer, in Rust), so an EMF rendition is noted and skipped.
 */

/** Office's picture archive on Windows and on macOS. */
export const OFFICE_PICTURE_ARCHIVE_TYPES: readonly string[] = ["Art::GVML ClipFormat", "com.microsoft.Art--GVML-ClipFormat"];

/** A copied OLE object on Windows: from Word or PowerPoint, then from the object's own server. */
export const OFFICE_EMBEDDED_OBJECT_TYPES: readonly string[] = ["Embedded Object", "Embed Source"];

const PNG_TYPES: ReadonlySet<string> = new Set(["image/png", "PNG", "public.png"]);

function isEmfType(type: string): boolean {
  const lower = type.toLowerCase();
  return lower.includes("emf") || lower.includes("enhmetafile");
}

export const PASTE_BACK_LIMITS = Object.freeze({
  /** The native readers refuse a larger archive before copying it (32 MB, `clipboard_images.rs`). */
  maxArchiveBytes: 32 * 1024 * 1024,
  /** Windows reports the archive's allocation, which may run a few bytes past its end record. */
  maxArchivePaddingBytes: 4096,
  maxEntries: 200,
  /** One part; the largest is the picture, at most a 25 MB PNG. */
  maxEntryBytes: MAX_IMAGE_OBJECT_BYTES,
  maxInflatedBytes: 64 * 1024 * 1024,
  /** Pictures examined in one archive. */
  maxPictures: 50,
  maxCarrierJsonBytes: OFFICE_IMPORT_LIMITS.maxCarrierJsonBytes,
  maxTotalCarrierJsonBytes: 16 * 1024 * 1024,
  /** A copied object's drawing as the native reader sends it (its 25 MiB `ChemDraftDocument` cap). */
  maxEmbeddedObjectBytes: 25 * 1024 * 1024,
});

export type PasteBackLimits = { -readonly [K in keyof typeof PASTE_BACK_LIMITS]: number };

/** One clipboard flavor's raw bytes, by its native format name. */
export interface PasteBackClipboardItem {
  type: string;
  bytes: Uint8Array;
  /** For an embedded object: the OLE class it was stored under. Its bytes are the drawing's text. */
  clsid?: string;
}

export type PasteBackSource = "embedded-object" | "office-archive" | "png";

export interface PasteBackStructure {
  source: PasteBackSource;
  /** The clipboard format it came from, e.g. `Embedded Object` or `Art::GVML ClipFormat`. */
  format: string;
  /** The archive part holding the picture, for the archive. */
  mediaPart?: string;
  /** The carrier's (or the embedded object's `ChemDraftDocument`) exact UTF-8 JSON. */
  json: string;
  /** The parsed `chemdraft-selection` envelope; the app still runs its chemistry check. */
  document: Record<string, unknown>;
}

export interface PasteBackRefusal {
  source: PasteBackSource;
  format: string;
  mediaPart?: string;
  reason: OfficeCarrierWarningReason;
  /** "The copied structure has damaged ChemDraft data: PNG iTXt CRC mismatch." */
  message: string;
}

export type PasteBackNoneReason =
  /** ChemDraft's own selection flavor is on the clipboard; it wins, as it always has. */
  | "native-data"
  /** No ChemDraft object, no picture archive and no PNG. */
  | "no-pictures"
  /** Pictures were read and none holds ChemDraft data. */
  | "no-carrier"
  /** The archive could not be read and no PNG holds ChemDraft data. */
  | "archive-unreadable";

export type PasteBackResult =
  /** Paste these (after the app's chemistry check). */
  | { kind: "found"; structures: PasteBackStructure[]; refusals: PasteBackRefusal[]; notes: string[] }
  /** ChemDraft data is present but unusable: paste nothing and report `message`. */
  | { kind: "refused"; refusals: PasteBackRefusal[]; message: string; notes: string[] }
  /** No ChemDraft data: the ordinary paste goes ahead (a plain picture still pastes as a picture). */
  | { kind: "none"; reason: PasteBackNoneReason; message: string; notes: string[] };

function limitsWith(overrides: Partial<PasteBackLimits>): PasteBackLimits {
  const limits: PasteBackLimits = { ...PASTE_BACK_LIMITS };
  for (const [key, value] of Object.entries(overrides) as [keyof PasteBackLimits, number | undefined][]) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid paste-back limit: ${key}.`);
    limits[key] = Math.min(value, PASTE_BACK_LIMITS[key]); // only ever tighter
  }
  return limits;
}

/**
 * Cut allocation padding (zero bytes) after the ZIP end record, so the strict reader sees the end
 * record last. Anything else after it is left for the reader to refuse.
 */
export function trimZipPadding(bytes: Uint8Array, maxPadding: number): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lowest = Math.max(0, bytes.length - 22 - maxPadding - 0xffff);
  for (let at = bytes.length - 22; at >= lowest; at--) {
    if (view.getUint32(at, true) !== 0x06054b50) continue;
    const end = at + 22 + view.getUint16(at + 20, true);
    if (end > bytes.length || bytes.length - end > maxPadding) continue;
    if (bytes.subarray(end).every((byte) => byte === 0)) return bytes.subarray(0, end);
  }
  return bytes;
}

function wantedEntry(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".xml") || lower.endsWith(".rels") || lower.endsWith(".png");
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/**
 * The archive's pictures, one entry per picture its drawing lists (`a:blip r:embed` in the main
 * part), so two pictures that share one media part are two entries. They come in reading order:
 * left to right, then top to bottom, by their place in the copied drawing, not their stacking
 * order (`inReadingOrder`); pictures without a place follow in drawing order. A drawing
 * that names no picture falls back to its image relationships, once each; an archive without that
 * layout falls back to every PNG part, by name.
 */
function archivePictureParts(parts: ReadonlyMap<string, OfficeZipEntry>): string[] {
  const text = (part: string): string | undefined => {
    const entry = parts.get(part.toLowerCase());
    return entry && !entry.skipped ? utf8.decode(entry.data) : undefined;
  };
  const relationshipsOf = (part: string): Map<string, OfficeRelationship> => {
    const xml = text(relsPartFor(part));
    return xml === undefined ? new Map() : officeRelationships(xml);
  };
  const main = [...relationshipsOf("").values()].find((relationship) =>
    !relationship.external && isOfficeRelationshipType(relationship.type, "officeDocument"));
  const mainPart = main ? resolvePartTarget("", main.target) : null;
  if (mainPart) {
    const relationships = relationshipsOf(mainPart);
    const imagePart = (relationship: OfficeRelationship | undefined): string[] => {
      if (!relationship || relationship.external || !isOfficeRelationshipType(relationship.type, "image")) return [];
      const part = resolvePartTarget(folderOf(mainPart), relationship.target);
      return part ? [part] : [];
    };
    const drawing = text(mainPart);
    const references = drawing === undefined ? [] : drawingPictureReferences(drawing);
    const pictures = inReadingOrder(references, (reference) => reference.box)
      .flatMap(({ relationshipId }) => imagePart(relationships.get(relationshipId)));
    if (pictures.length) return pictures;
    const related = [...new Set([...relationships.values()].flatMap(imagePart))];
    if (related.length) return related;
  }
  return [...parts.values()].filter((entry) => entry.name.toLowerCase().endsWith(".png"))
    .map((entry) => entry.name).sort();
}

interface Collected {
  structures: PasteBackStructure[];
  refusals: PasteBackRefusal[];
  notes: string[];
  picturesRead: number;
  archiveUnreadable: boolean;
}

function archiveRefusal(detail: string): string {
  return `Office's picture data could not be read (${detail.replace(/\.$/, "")}).`;
}

async function readArchive(
  archive: PasteBackClipboardItem, limits: PasteBackLimits, collected: Collected, readCarrier: CarrierCollector,
): Promise<void> {
  const unreadable = (detail: string) => {
    collected.archiveUnreadable = true;
    collected.notes.push(archiveRefusal(detail));
  };
  let entries: OfficeZipEntry[];
  try {
    const bytes = archive.bytes;
    if (bytes.length > limits.maxArchiveBytes + limits.maxArchivePaddingBytes) {
      unreadable(`it is larger than the ${Math.round(limits.maxArchiveBytes / (1024 * 1024))} MB limit`);
      return;
    }
    entries = await readZip(trimZipPadding(bytes, limits.maxArchivePaddingBytes), {
      maxArchiveBytes: limits.maxArchiveBytes,
      maxEntries: limits.maxEntries,
      maxEntryBytes: limits.maxEntryBytes,
      maxInflatedBytes: limits.maxInflatedBytes,
      include: wantedEntry,
    });
  } catch (error) {
    unreadable(error instanceof Error ? error.message : String(error));
    return;
  }
  const parts = new Map<string, OfficeZipEntry>();
  for (const entry of entries) {
    const reason = unsafeEntryNameReason(entry.name);
    const key = entry.name.toLowerCase();
    if (reason || parts.has(key)) {
      unreadable(`an entry name ${reason ?? "is duplicated"}: "${entry.name.slice(0, 120)}"`);
      return;
    }
    parts.set(key, entry);
  }
  let pictures: string[];
  try {
    pictures = archivePictureParts(parts);
  } catch (error) {
    unreadable(`its relationships are damaged: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (pictures.length > limits.maxPictures) {
    collected.notes.push(`Only the first ${limits.maxPictures} of ${pictures.length} copied pictures were checked for ChemDraft data.`);
  }
  for (const part of pictures.slice(0, limits.maxPictures)) {
    const entry = parts.get(part.toLowerCase());
    if (!entry || entry.skipped || entry.data[0] !== 0x89 || entry.data[1] !== 0x50) continue; // not a PNG
    await readCarrier("office-archive", archive.type, entry.data, entry.name);
  }
}

type CarrierCollector = (source: PasteBackSource, format: string, png: Uint8Array, mediaPart?: string) => Promise<void>;

/** A copied embedded object of ChemDraft's own class; another program's is never read. */
function isChemDraftObjectItem(item: { type: string; clsid?: string }): boolean {
  return OFFICE_EMBEDDED_OBJECT_TYPES.includes(item.type) && isChemDraftOleClassId(item.clsid);
}

/**
 * Recover the ChemDraft structures from raw clipboard flavors (by native format name). A ChemDraft
 * embedded object is read first; GVML only when it yields no structure; the PNG only when neither
 * does. `advertisedTypes` (every format on the clipboard, read or not) lets the result say when an
 * EMF rendition was skipped.
 */
export async function recoverPasteBackStructures(
  items: readonly PasteBackClipboardItem[],
  options: {
    advertisedTypes?: readonly string[];
    limits?: Partial<PasteBackLimits>;
    /** Set when the caller could not even decode the archive flavor: why. */
    unreadableArchive?: string;
    /** Set when the caller could not decode a ChemDraft object's drawing: its format and why. */
    unreadableEmbeddedObject?: { format: string; reason: string };
  } = {},
): Promise<PasteBackResult> {
  const limits = limitsWith(options.limits ?? {});
  const collected: Collected = { structures: [], refusals: [], notes: [], picturesRead: 0, archiveUnreadable: false };
  if (options.unreadableArchive !== undefined) {
    collected.archiveUnreadable = true;
    collected.notes.push(archiveRefusal(options.unreadableArchive));
  }
  let totalJsonBytes = 0;
  const collect = (source: PasteBackSource, format: string, read: CarrierText, mediaPart?: string) => {
    const envelope = readCarrierEnvelope(read, limits.maxCarrierJsonBytes, (jsonBytes) => {
      if (totalJsonBytes + jsonBytes > limits.maxTotalCarrierJsonBytes) {
        return `was not read: the copied structures together exceed ${Math.round(limits.maxTotalCarrierJsonBytes / (1024 * 1024))} MB.`;
      }
      totalJsonBytes += jsonBytes;
      return undefined;
    });
    if (!envelope) return;
    if (envelope.ok) collected.structures.push({ source, format, ...(mediaPart ? { mediaPart } : {}), json: envelope.json, document: envelope.document });
    else collected.refusals.push({ source, format, ...(mediaPart ? { mediaPart } : {}), reason: envelope.reason, message: `The copied structure ${envelope.phrase}` });
  };
  // A media part shared by several pictures is decoded once; each picture still counts against
  // the size budget, since each becomes a structure of its own.
  const readByPart = new Map<string, Awaited<ReturnType<typeof readChemDraftSelectionFromPng>>>();
  const readCarrier: CarrierCollector = async (source, format, png, mediaPart) => {
    collected.picturesRead++;
    let read = mediaPart === undefined ? undefined : readByPart.get(mediaPart);
    if (!read) {
      read = await readChemDraftSelectionFromPng(png);
      if (mediaPart !== undefined) readByPart.set(mediaPart, read);
    }
    collect(source, format, read, mediaPart);
  };

  // The drawing of a ChemDraft object: its text is judged, and refused, like a carrier's.
  if (options.unreadableEmbeddedObject) {
    collect("embedded-object", options.unreadableEmbeddedObject.format, { kind: "invalid", reason: options.unreadableEmbeddedObject.reason });
  }
  const objects = items.filter(isChemDraftObjectItem).slice(0, 1);
  for (const object of objects) {
    let read: CarrierText;
    try {
      read = { kind: "found", json: utf8.decode(object.bytes) };
    } catch {
      read = { kind: "invalid", reason: "the object's drawing is not UTF-8 text" };
    }
    collect("embedded-object", object.type, read);
  }
  const archive = items.find((item) => OFFICE_PICTURE_ARCHIVE_TYPES.includes(item.type));
  if (!collected.structures.length && archive) await readArchive(archive, limits, collected, readCarrier);
  if (!collected.structures.length) {
    for (const png of items.filter((item) => PNG_TYPES.has(item.type)).slice(0, 1)) {
      await readCarrier("png", png.type, png.bytes);
    }
  }
  const emf = [...options.advertisedTypes ?? [], ...items.map((item) => item.type)].find(isEmfType);
  // A ChemDraft object's EMF is only its preview; its drawing was read from the object itself.
  if (emf && !collected.structures.length && !objects.length && !options.unreadableEmbeddedObject) {
    collected.notes.push(`The ${emf} picture was not checked: ChemDraft cannot read ChemDraft data from EMF pictures.`);
  }

  const { structures, refusals, notes } = collected;
  if (structures.length) return { kind: "found", structures, refusals, notes };
  if (refusals.length) return { kind: "refused", refusals, message: refusals[0]!.message, notes };
  if (collected.archiveUnreadable) {
    return { kind: "none", reason: "archive-unreadable", message: notes.find((note) => note.startsWith("Office's")) ?? archiveRefusal("unknown error"), notes };
  }
  if (collected.picturesRead || archive) {
    return { kind: "none", reason: "no-carrier", message: "The copied picture has no ChemDraft data.", notes };
  }
  return { kind: "none", reason: "no-pictures", message: "The clipboard has no picture to read ChemDraft data from.", notes };
}

/**
 * The same recovery from a native clipboard read. `officeItems` can hold both a ChemDraft object's
 * drawing and its GVML fallback. Decode the archive only if the drawing is absent or refused.
 * An embedded object of another class is left out. ChemDraft's own selection flavor takes
 * precedence, so its presence returns `none` without reading anything.
 */
export async function recoverPasteBackFromClipboard(
  read: ClipboardReadPayload, options: { limits?: Partial<PasteBackLimits> } = {},
): Promise<PasteBackResult> {
  if (read.types.includes(CHEMDRAFT_PNG_SELECTION_KEYWORD) || read.textItems.some((item) => item.type === CHEMDRAFT_PNG_SELECTION_KEYWORD)) {
    return { kind: "none", reason: "native-data", message: "The clipboard holds ChemDraft's own selection.", notes: [] };
  }
  const limits = limitsWith(options.limits ?? {});
  const items: PasteBackClipboardItem[] = [];
  let unreadableEmbeddedObject: { format: string; reason: string } | undefined;
  const object = read.officeItems?.find(isChemDraftObjectItem);
  if (object) {
    try {
      items.push({ type: object.type, clsid: object.clsid, bytes: decodeBase64Bounded(object.bytesBase64, limits.maxEmbeddedObjectBytes) });
    } catch (error) {
      unreadableEmbeddedObject = { format: object.type, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  const archive = read.officeItems?.find((item) => OFFICE_PICTURE_ARCHIVE_TYPES.includes(item.type));
  if (archive) {
    items.push({
      type: archive.type,
      get bytes() {
        return decodeBase64Bounded(archive.bytesBase64, limits.maxArchiveBytes + limits.maxArchivePaddingBytes);
      },
    });
  }
  const png = read.imageItems?.find((item) => item.type === "image/png");
  if (png) {
    try {
      items.push({ type: png.type, bytes: decodeBase64Bounded(png.bytesBase64, MAX_IMAGE_OBJECT_BYTES) });
    } catch {
      // The ordinary picture paste reports an unreadable PNG; here it simply holds no carrier.
    }
  }
  return recoverPasteBackStructures(items, { advertisedTypes: read.types, limits, unreadableEmbeddedObject });
}
