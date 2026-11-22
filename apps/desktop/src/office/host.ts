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
/** `warnings` names shape state the host could not carry over to the replacement. */
export type ReplaceResult = { kind: "replaced"; warnings?: string[] } | Refusal;

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
  } finally {
    await officeAsync<void>(done => file.closeAsync(done));
  }
  return readZip(bytes);
}

export async function readCarrier(bytes: Uint8Array | undefined) {
  if (!bytes) return refuse("Office did not return the selected picture’s stored image.");
  if (bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) {
    return refuse("The selected picture has no ChemDraft carrier.");
  }
  const result = await readChemDraftSelectionFromPng(bytes);
  if (result.kind === "found") return result;
  return refuse(result.kind === "absent" ? "The selected picture has no ChemDraft carrier." : result.reason);
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
  return { base64: pngBase64(png), aspect: size.height / size.width };
}
