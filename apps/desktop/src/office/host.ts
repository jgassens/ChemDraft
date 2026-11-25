import { readChemDraftSelectionFromPng, readZip } from "@chemdraft/clipboard-adapter";
import { readPngInfo } from "@chemdraft/chem-core";

export interface PictureSize {
  width: number;
  height: number;
}

export interface SelectedStructure {
  kind: "structure";
  key: string;
  json: string;
  updateRefusal?: string;
}

export interface NoStructure {
  kind: "no-structure";
}

export interface Refusal {
  kind: "refusal";
  reason: string;
}

export type SelectionResult = SelectedStructure | NoStructure | Refusal;
/** A missing key means the host wrote the picture but could not identify it for rebinding. */
export type ReplaceResult = { kind: "replaced"; key: string | undefined; warnings?: string[] } | Refusal;

export interface OfficeHostAdapter {
  readSelectedStructure(): Promise<SelectionResult>;
  replaceSelectedStructure(png: Uint8Array, json: string, size: PictureSize): Promise<ReplaceResult>;
}

export const noStructure: NoStructure = { kind: "no-structure" };
export const refuse = (reason: string): Refusal => ({ kind: "refusal", reason });
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
export const selectionChanged = "The Office selection changed. Select the original picture to update it.";

type Done<T> = (result: { status: string; value: T; error?: { message: string } }) => void;
interface OfficeFile {
  size: number;
  sliceCount: number;
  getSliceAsync(index: number, done: Done<{ index: number; size: number; data: number[] }>): void;
  closeAsync(done: Done<void>): void;
}

export interface OfficeDocument {
  getFileAsync(type: "compressed", options: { sliceSize: number }, done: Done<OfficeFile>): void;
  setSelectedDataAsync(base64: string, options: {
    coercionType: "image";
    imageLeft: number;
    imageTop: number;
    imageWidth: number;
    imageHeight: number;
  }, done: Done<void>): void;
  addHandlerAsync(event: "documentSelectionChanged", listener: () => void, done: Done<void>): void;
  removeHandlerAsync(event: "documentSelectionChanged", options: { handler: () => void }, done: Done<void>): void;
}

export interface OfficeContext {
  document: OfficeDocument;
  requirements: { isSetSupported(name: string, version: string): boolean };
}

export interface OfficeApi {
  onReady(): Promise<{ host: string | null }>;
  context: OfficeContext;
}

export function officeAsync<T>(call: (done: Done<T>) => void): Promise<T> {
  return new Promise((resolve, reject) => call(result => {
    if (result.status === "succeeded") resolve(result.value);
    else reject(new Error(result.error?.message ?? "Office did not complete the request."));
  }));
}

/**
 * Office keeps at most two files of a document open and rejects a third `getFileAsync`, so reads of
 * one document run one at a time: each waits until the previous one has closed its file.
 */
const documentReads = new WeakMap<OfficeDocument, Promise<unknown>>();

export function readOfficeDocument(context: OfficeContext) {
  if (!context.requirements.isSetSupported("CompressedFile", "1.1")) {
    return Promise.reject(new Error("This version of Office cannot read the compressed document."));
  }
  const previous = documentReads.get(context.document) ?? Promise.resolve();
  const read = previous.then(() => readCompressedFile(context), () => readCompressedFile(context));
  documentReads.set(context.document, read.catch(() => undefined));
  return read;
}

async function readCompressedFile(context: OfficeContext) {
  const sliceSize = 1024 * 1024;
  const file = await officeAsync<OfficeFile>(done => context.document.getFileAsync("compressed", { sliceSize }, done));
  const close = () => officeAsync<void>(done => file.closeAsync(done));
  let bytes: Uint8Array;
  try {
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > 200 * 1024 * 1024 ||
        !Number.isSafeInteger(file.sliceCount) || file.sliceCount < 1 || file.sliceCount > file.size) {
      throw new Error("The compressed Office document has an invalid size or exceeds 200 MiB.");
    }
    bytes = new Uint8Array(file.size);
    let offset = 0;
    for (let index = 0; index < file.sliceCount; index++) {
      const slice = await officeAsync<{ index: number; size: number; data: number[] }>(
        done => file.getSliceAsync(index, done)
      );
      if (slice.index !== index || !Number.isSafeInteger(slice.size) || slice.size < 1 || slice.size > file.size - offset ||
          slice.data.length !== slice.size) {
        throw new Error("Office returned an incomplete document.");
      }
      bytes.set(slice.data, offset);
      offset += slice.size;
    }
    if (offset !== bytes.length) throw new Error("Office returned an incomplete document.");
  } catch (readError) {
    try {
      await close();
    } catch (closeError) {
      throw new Error(errorMessage(readError) + " Closing the Office document also failed. " + errorMessage(closeError),
        { cause: readError });
    }
    throw readError;
  }
  await close();
  return readZip(bytes);
}

/**
 * ChemDraft keeps its drawing only in its PNG. An ordinary paste may make Office store the PDF or
 * SVG copy instead, which has no drawing data, so the message says how to paste the PNG.
 */
const pasteAsPng = "If it came from ChemDraft, copy it again and paste with Paste Special → Picture (PNG).";
export const noCarrier = "This picture has no ChemDraft data. " + pasteAsPng;
export const pdfWithoutCarrier = "This picture was pasted as a PDF and has no ChemDraft data. " + pasteAsPng;

/**
 * Reads the ChemDraft drawing from a stored picture. A found carrier also gives the PNG's natural
 * size (see `pngNaturalSize`), which an Update needs to keep the drawing's scale on the page.
 */
export async function readCarrier(bytes: Uint8Array | undefined) {
  if (!bytes) return refuse("Office did not return the selected picture’s stored image.");
  if (bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) {
    const pdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
    return refuse(pdf ? pdfWithoutCarrier : noCarrier);
  }
  const result = await readChemDraftSelectionFromPng(bytes);
  if (result.kind === "found") return { ...result, natural: pngNaturalSize(bytes) };
  return refuse(result.kind === "absent" ? noCarrier : result.reason);
}

/** DrawingML English Metric Units per point. */
export const EMU_PER_POINT = 12700;

/**
 * The size in points a PNG is meant to show at: its pixels over the density in its pHYs chunk.
 * ChemDraft stamps that density on every PNG it renders (Copy, and the Office pane's Update),
 * after any clamping of the raster, so this is the drawing's own size on the page whatever the
 * raster's resolution. Undefined when the PNG carries no density.
 */
export function pngNaturalSize(png: Uint8Array): PictureSize | undefined {
  const info = readPngInfo(png);
  const density = info?.pixelsPerMeter;
  if (!info || !density) return undefined;
  const points = (pixels: number, perMeter: number) => pixels / perMeter / 0.0254 * 72;
  const size = { width: points(info.pixelWidth, density.x), height: points(info.pixelHeight, density.y) };
  return size.width > 0 && size.height > 0 && Number.isFinite(size.width) && Number.isFinite(size.height) ? size : undefined;
}

/**
 * Below this relative difference, a frame is taken to be its content's natural size. Office keeps
 * sizes in whole EMUs (Word) or hundredths of a point (PowerPoint), and pHYs in whole pixels per
 * meter; both are far inside 0.5%, and a deliberate resize is far outside it.
 */
const naturalTolerance = 0.005;

/**
 * The frame, in points, for a replacement picture. The drawing keeps its scale on the page, so
 * bonds stay the length they were and the frame grows or shrinks with the drawing.
 *
 * The old picture's scale is its frame width over the natural width of its own stored PNG. A frame
 * at its natural size (within `naturalTolerance`) has scale 1, which is snapped exactly so repeated
 * Updates cannot drift. Any other scale means the user resized the picture, and the replacement
 * keeps that scale. The width's scale is used for both sides, so a picture the user stretched out
 * of proportion comes back in proportion, as it always has.
 *
 * Without a density on both PNGs the scale is unknown; the old width is kept, as before.
 */
export function replacementFrame(
  frame: PictureSize, original: PictureSize | undefined, replacement: { aspect: number; natural?: PictureSize },
): PictureSize {
  const natural = replacement.natural;
  if (!original || !natural) return { width: frame.width, height: frame.width * replacement.aspect };
  let scale = frame.width / original.width;
  if (Math.abs(scale - 1) <= naturalTolerance) scale = 1;
  const width = natural.width * scale;
  return { width, height: width * replacement.aspect };
}

export function pngBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 8192) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  }
  return btoa(binary);
}

export async function replacementImage(png: Uint8Array, json: string, size: PictureSize) {
  const dimensions = readPngInfo(png);
  const carrier = await readChemDraftSelectionFromPng(png);
  if (carrier.kind !== "found" || carrier.json !== json ||
      dimensions?.pixelWidth !== size.width || dimensions.pixelHeight !== size.height) {
    throw new Error("The replacement PNG does not match the drawing or its dimensions.");
  }
  return { base64: pngBase64(png), aspect: size.height / size.width, natural: pngNaturalSize(png) };
}
