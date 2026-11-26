import { documentTooLargeReason, fitPicturesInDocument, pictureBudgetBytes, savedPictureBytes } from "./dropDocumentBudget";
import {
  MAX_DROPPED_IMAGES, MAX_DROPPED_IMAGE_BYTES, MAX_DROPPED_IMAGE_TOTAL_BYTES, classifyDroppedFile,
  droppedFileBaseName, droppedImageSizeError, dropRefusal, formatDropBytes
} from "./dropFiles";
import { prepareDroppedImage, type PrepareDroppedImageResult, type PreparedDroppedImage } from "./prepareDroppedImage";
import { untilAborted, type DecodeOptions, type DroppedImageDecoders } from "./rasterDecode";

/**
 * How long one file may take: its size from metadata, and separately its read from disk with the
 * decode through the webview (for JPEG, GIF and WebP the PNG encode too). A filesystem call or a
 * decoder that never settles would otherwise hold every later drop.
 */
export const DROPPED_IMAGE_DEADLINE_MS = 30_000;

/** One dropped file as either route sees it: a Tauri path or a browser `File`. */
export interface DroppedImageSource {
  name: string;
  /** Size from metadata (native stat, `File.size`), before anything is read. */
  size(options?: DecodeOptions): Promise<number>;
  /**
   * Read the whole file, failing as soon as it is longer than `maxBytes`. When `options.signal`
   * aborts, rejects at once and closes anything it opened.
   */
  read(maxBytes: number, options?: DecodeOptions): Promise<Uint8Array>;
}

export interface DropRefusalEntry {
  name: string;
  reason: string;
  /**
   * Set when the reason is about the whole drop rather than this file (the count cap, the total-bytes
   * cap): every file refused for the same one shares one status part, which still names each file.
   */
  wholeDrop?: "count" | "totalBytes";
}

export interface SplitDrop<T> {
  images: T[];
  documents: T[];
  refusals: DropRefusalEntry[];
}

/** Pictures by extension; picture types that cannot be dropped are refused by name; the rest open. */
export function splitDrop<T>(files: readonly T[], nameOf: (file: T) => string): SplitDrop<T> {
  const split: SplitDrop<T> = { images: [], documents: [], refusals: [] };
  for (const file of files) {
    const role = classifyDroppedFile(nameOf(file));
    if (role.kind === "image") split.images.push(file);
    else if (role.kind === "refused") split.refusals.push({ name: nameOf(file), reason: role.reason });
    else split.documents.push(file);
  }
  return split;
}

export interface PreparedDrop {
  images: PreparedDroppedImage[];
  refusals: DropRefusalEntry[];
}

export interface PrepareDropOptions {
  /** Per file; `DROPPED_IMAGE_DEADLINE_MS` by default. */
  deadlineMs?: number;
  /**
   * Saved bytes the pictures may add to the document (`pictureBudgetBytes`). A picture past it is
   * refused by name as soon as it is prepared, so the base64 held for one drop stays within what
   * the document could take; unlimited by default.
   */
  budgetBytes?: number;
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * `task` under a deadline: it sees the signal (a reader closes its file, a decoder stops), and
 * whatever it delivers after the deadline is dropped.
 */
async function withDeadline<T>(deadlineMs: number, message: (seconds: number) => string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const seconds = Math.round(deadlineMs / 100) / 10;
  const timer = setTimeout(() => controller.abort(new Error(message(seconds))), deadlineMs);
  try {
    return await untilAborted(task(controller.signal), controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** One file's read and preparation under one deadline. */
async function readAndPrepare(source: DroppedImageSource, decoders: DroppedImageDecoders, deadlineMs: number): Promise<PrepareDroppedImageResult> {
  try {
    return await withDeadline(deadlineMs, seconds => `reading it took longer than ${seconds} seconds.`, async signal => {
      const bytes = await source.read(MAX_DROPPED_IMAGE_BYTES, { signal });
      return prepareDroppedImage(droppedFileBaseName(source.name), bytes, decoders, { signal });
    });
  } catch (error) {
    return { ok: false, reason: errorText(error) };
  }
}

/**
 * Check the count and size caps from metadata, then read and prepare each picture in turn (one in
 * memory at a time, each under its deadline). One failure never stops the others.
 */
export async function prepareDroppedImages(
  sources: readonly DroppedImageSource[],
  decoders: DroppedImageDecoders,
  options: PrepareDropOptions = {}
): Promise<PreparedDrop> {
  const result: PreparedDrop = { images: [], refusals: [] };
  const refuse = (name: string, reason: string, wholeDrop?: DropRefusalEntry["wholeDrop"]) =>
    result.refusals.push(wholeDrop ? { name, reason, wholeDrop } : { name, reason });
  const deadlineMs = options.deadlineMs ?? DROPPED_IMAGE_DEADLINE_MS;
  let totalBytes = 0;
  const admitted: DroppedImageSource[] = [];
  for (const [index, source] of sources.entries()) {
    if (index >= MAX_DROPPED_IMAGES) {
      refuse(source.name, `only ${MAX_DROPPED_IMAGES} pictures can be dropped at once.`, "count");
      continue;
    }
    let size: number;
    try {
      size = await withDeadline(deadlineMs, seconds => `it took longer than ${seconds} seconds`, signal => source.size({ signal }));
    } catch (error) {
      refuse(source.name, `its size could not be read (${errorText(error)}).`);
      continue;
    }
    const sizeError = droppedImageSizeError(size);
    if (sizeError) { refuse(source.name, sizeError); continue; }
    if (totalBytes + size > MAX_DROPPED_IMAGE_TOTAL_BYTES) {
      refuse(source.name, `the pictures in one drop can total at most ${formatDropBytes(MAX_DROPPED_IMAGE_TOTAL_BYTES)}.`, "totalBytes");
      continue;
    }
    totalBytes += size;
    admitted.push(source);
  }
  let budget = options.budgetBytes ?? Number.POSITIVE_INFINITY;
  for (const source of admitted) {
    const prepared = await readAndPrepare(source, decoders, deadlineMs);
    if (!prepared.ok) { refuse(source.name, prepared.reason); continue; }
    const cost = savedPictureBytes(prepared.image.dataBase64.length);
    if (cost > budget) { refuse(source.name, documentTooLargeReason()); continue; }
    budget -= cost;
    result.images.push(prepared.image);
  }
  return result;
}

const LISTED = 5;

/**
 * Status parts joined with "; ". A part's own closing period is dropped before a separator, so a
 * refusal reason never reads "….; Couldn't"; the last part keeps its period.
 */
export function joinStatusParts(parts: readonly (string | undefined)[]): string {
  const shown = parts.filter((part): part is string => !!part);
  return shown.map((part, index) => index < shown.length - 1 ? part.replace(/\.$/, "") : part).join("; ");
}

function listNames(names: readonly string[]): string {
  const shown = names.slice(0, LISTED).join(", ");
  return names.length > LISTED ? `${shown} and ${names.length - LISTED} more` : shown;
}

/** `"a.png"`, `"a.png" and "b.png"`, `"a.png", "b.png" and "c.png"`: every name, quoted. */
function quotedNames(names: readonly string[]): string {
  const quoted = names.map(name => `"${droppedFileBaseName(name)}"`);
  return quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}` : quoted[0] ?? "";
}

/**
 * One part per refusal, in order. Refusals for the same whole-drop reason share one part, where the
 * first of them would have been, naming every file: `Couldn't drop "a.png", "b.png" and "c.png": …`.
 */
function refusalParts(refusals: readonly DropRefusalEntry[]): string[] {
  const groups = new Map<string, DropRefusalEntry[]>();
  const parts: Array<DropRefusalEntry | DropRefusalEntry[]> = [];
  for (const refusal of refusals) {
    if (!refusal.wholeDrop) { parts.push(refusal); continue; }
    const group = groups.get(refusal.wholeDrop);
    if (group) { group.push(refusal); continue; }
    const created = [refusal];
    groups.set(refusal.wholeDrop, created);
    parts.push(created);
  }
  return parts.map(part => {
    if (!Array.isArray(part)) return dropRefusal(part.name, part.reason);
    if (part.length === 1) return dropRefusal(part[0]!.name, part[0]!.reason);
    return `Couldn't drop ${quotedNames(part.map(refusal => refusal.name))}: ${part[0]!.reason}`;
  });
}

/** Pictures that were ready but not inserted, every one by name, and why. */
export interface NotInsertedPictures {
  names: readonly string[];
  /** Worded for one picture or several alike: no "they" or "them". */
  reason: string;
}

/** `"slow.png" was not inserted: …` or `"a.png" and "b.png" were not inserted: …`. */
function notInsertedPart({ names, reason }: NotInsertedPictures): string {
  return `${quotedNames(names)} ${names.length === 1 ? "was" : "were"} not inserted: ${reason}`;
}

/** What was inserted, how it was adjusted, and every refusal with its file and reason. */
export function formatImageDropStatus(outcome: {
  inserted: readonly PreparedDroppedImage[];
  scaledToPage?: readonly string[];
  refusals: readonly DropRefusalEntry[];
  notInserted?: NotInsertedPictures;
  /**
   * The drop held no picture to read, only files refused by their type (a .bmp, a web link): those
   * refusals are the whole status, without "No pictures were inserted".
   */
  nothingToRead?: boolean;
}): string {
  const parts: string[] = [];
  const count = outcome.inserted.length;
  if (outcome.notInserted) parts.push(notInsertedPart(outcome.notInserted));
  else if (count === 1) parts.push(`Inserted picture ${outcome.inserted[0]!.name}`);
  else if (count > 1) parts.push(`Inserted ${count} pictures (${listNames(outcome.inserted.map(image => image.name))})`);
  else if (outcome.refusals.length && !outcome.nothingToRead) parts.push("No pictures were inserted");
  if (!outcome.notInserted) {
    for (const image of outcome.inserted) {
      for (const note of image.notes) parts.push(`${image.name}: ${note}`);
    }
    if (outcome.scaledToPage?.length) parts.push(`scaled to fit the page: ${listNames(outcome.scaledToPage)}`);
  }
  for (const part of refusalParts(outcome.refusals)) parts.push(part);
  return joinStatusParts(parts);
}

export type DroppedImageInsertion =
  | { ok: true; scaledToPage: readonly string[] }
  | { ok: false; reason: string };

export interface DroppedFilesHandler<T> {
  nameOf(file: T): string;
  imageSource(file: T): DroppedImageSource;
  /**
   * The existing document-open path, unchanged; resolves to what the outcome says of the documents
   * (each by name, then any failures), if anything. Ignored for a drop of documents alone.
   */
  openDocuments(files: T[]): Promise<string | undefined>;
  /** Why the drop's target cannot take pictures now (the edit guards), asked at drop time. */
  insertRefusal?(): string | undefined;
  /** Saved bytes of the drop's target document, asked at drop time and again at commit. */
  documentBytes(): number;
  /** Checks the drop's target tab and edit guards, then commits all pictures as one undo entry. */
  insertImages(images: PreparedDroppedImage[]): DroppedImageInsertion;
  /**
   * Runs the commit once no canvas gesture is live (a gesture rebuilds the document from its own
   * start when it ends, which would wipe the pictures). Rejects, with the reason as its message, when
   * the canvas stays busy too long.
   */
  whenIdle?<R>(commit: () => R): Promise<R>;
  decoders: DroppedImageDecoders;
  /** A status for the tab the drop landed on, whichever tab is active by then. */
  setStatus(status: string): void;
  /**
   * The drop's whole outcome (the pictures' result joined with the documents' summary), for the tab
   * active once any documents have opened, which may not be the one the drop landed on: a refusal is
   * never shown only on a tab out of sight. `setStatus` when absent.
   */
  showOutcome?(status: string): void;
  /** Runs the picture work after any earlier drop's, so two drops never interleave their commits. */
  serialize?: <R>(task: () => Promise<R>) => Promise<R>;
}

/**
 * One handler for both drop routes. A drop with no pictures goes to the document-open path exactly
 * as before. Otherwise pictures are prepared and inserted first, into the tab under the drop, and any
 * documents open afterwards (opening one switches tabs).
 */
export async function handleDroppedFiles<T>(files: readonly T[], handler: DroppedFilesHandler<T>): Promise<void> {
  const split = splitDrop(files, handler.nameOf);
  if (!split.images.length && !split.refusals.length) {
    if (split.documents.length) await handler.openDocuments(split.documents);
    return;
  }
  // Told at once, before anything is read; asked again at commit, after the read.
  const refusedNow = split.images.length ? handler.insertRefusal?.() : undefined;
  const pictures = async () => {
    if (split.images.length) {
      handler.setStatus(`Reading ${split.images.length === 1 ? "the dropped picture" : `${split.images.length} dropped pictures`}…`);
    }
    const prepared = await prepareDroppedImages(split.images.map(handler.imageSource), handler.decoders,
      { budgetBytes: pictureBudgetBytes(handler.documentBytes()) });
    const prepareRefusals = [...split.refusals, ...prepared.refusals];
    if (!prepared.images.length) {
      return formatImageDropStatus({ inserted: [], refusals: prepareRefusals, nothingToRead: !split.images.length });
    }
    const commit = () => {
      // The document may have grown while the pictures were read: measure it again.
      const { fit, refused } = fitPicturesInDocument(prepared.images, handler.documentBytes());
      const refusals = [...prepareRefusals, ...refused];
      if (!fit.length) return formatImageDropStatus({ inserted: [], refusals });
      const insertion = handler.insertImages(fit);
      return insertion.ok
        ? formatImageDropStatus({ inserted: fit, scaledToPage: insertion.scaledToPage, refusals })
        : formatImageDropStatus({ inserted: fit, refusals, notInserted: { names: fit.map(image => image.name), reason: insertion.reason } });
    };
    try {
      return handler.whenIdle ? await handler.whenIdle(commit) : commit();
    } catch (error) {
      return formatImageDropStatus({ inserted: prepared.images, refusals: prepareRefusals, notInserted: {
        names: prepared.images.map(image => image.name), reason: error instanceof Error ? error.message : String(error)
      } });
    }
  };
  const status = refusedNow
    // Not queued behind an earlier drop still being read: the refusal shows now, naming the dropped picture files.
    ? formatImageDropStatus({ inserted: [], refusals: split.refusals,
      notInserted: { names: split.images.map(handler.nameOf), reason: refusedNow } })
    : await (handler.serialize ? handler.serialize(pictures) : pictures());
  // The pictures' result replaces "Reading…" on their own tab before any document opens a new one.
  handler.setStatus(status);
  const documentStatus = split.documents.length ? await handler.openDocuments(split.documents) : undefined;
  (handler.showOutcome ?? handler.setStatus)(joinStatusParts([status, documentStatus]));
}
