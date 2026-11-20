import { MAX_IMAGE_OBJECT_BYTES, readPngInfo, validatePngImage } from "@chemdraft/chem-core";
import { crc32, inflateBounded } from "./carrierBytes";

/** Uncompressed UTF-8 iTXt: the same versioned JSON as the private clipboard flavor. */
export const CHEMDRAFT_PNG_SELECTION_KEYWORD = "application/x-chemdraft-selection+json";

const selectionKeyword = new TextEncoder().encode(CHEMDRAFT_PNG_SELECTION_KEYWORD);

function hasSelectionKeyword(data: Uint8Array): boolean {
  return data[selectionKeyword.length] === 0 && selectionKeyword.every((byte, index) => byte === data[index]);
}

/** Keep pixels/density untouched; replace only ChemDraft's own metadata before IEND. */
export function pngWithChemDraftSelection(png: Uint8Array, selectionJson: string): Uint8Array {
  const validation = validatePngImage(png);
  if (validation.error) throw new Error(`Clipboard PNG failed validation: ${validation.error}`);
  const encoder = new TextEncoder();
  // Keyword terminator, compression flag/method, empty language and translated keyword.
  const prefix = encoder.encode(`${CHEMDRAFT_PNG_SELECTION_KEYWORD}\0\0\0\0\0`);
  const text = encoder.encode(selectionJson);
  const chunkLength = 12 + prefix.length + text.length;
  if (chunkLength + png.length > MAX_IMAGE_OBJECT_BYTES) {
    throw new Error("Clipboard PNG with editable selection data exceeds the 25 MB picture limit.");
  }
  const chunk = new Uint8Array(chunkLength);
  const chunkView = new DataView(chunk.buffer);
  chunkView.setUint32(0, prefix.length + text.length);
  chunk.set(encoder.encode("iTXt"), 4);
  chunk.set(prefix, 8);
  chunk.set(text, 8 + prefix.length);
  chunkView.setUint32(chunk.length - 4, crc32(chunk.subarray(4, -4)));

  const parts = [png.subarray(0, 8)];
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const ownMetadata = ["iTXt", "tEXt", "zTXt"].includes(type)
      && hasSelectionKeyword(png.subarray(offset + 8, end - 4));
    if (type === "IEND") parts.push(chunk);
    if (!ownMetadata) parts.push(png.subarray(offset, end));
    if (type === "IEND") break;
    offset = end;
  }
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

export type CarrierReadResult =
  | { kind: "found"; json: string; chunk: "iTXt" | "zTXt" }
  | { kind: "absent" }
  | { kind: "invalid"; reason: string };

function carrierText(chunk: "iTXt" | "zTXt", data: Uint8Array) {
  let offset = selectionKeyword.length + 1;
  if (chunk === "zTXt") {
    if (data[offset] !== 0) throw new Error("Unsupported zTXt compression method.");
    return { compressed: true, bytes: data.subarray(offset + 1) };
  }
  const flag = data[offset];
  if ((flag !== 0 && flag !== 1) || data[offset + 1] !== 0) {
    throw new Error("Unsupported iTXt compression flag or method.");
  }
  offset += 2;
  for (const field of ["language tag", "translated keyword"]) {
    const end = data.indexOf(0, offset);
    if (end === -1) throw new Error(`Missing iTXt ${field} terminator.`);
    offset = end + 1;
  }
  return { compressed: flag === 1, bytes: data.subarray(offset) };
}

/** Read the selection's exact UTF-8 text, leaving JSON validation to the caller. */
export async function readChemDraftSelectionFromPng(png: Uint8Array): Promise<CarrierReadResult> {
  if (png.length > MAX_IMAGE_OBJECT_BYTES) return { kind: "invalid", reason: "PNG exceeds the 25 MB picture limit." };
  // Validates the signature and chunk framing through IEND, including required image chunks.
  if (!readPngInfo(png)) return { kind: "invalid", reason: "Invalid PNG structure." };

  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let carrier: { chunk: "iTXt" | "zTXt"; data: Uint8Array } | undefined;
  for (let offset = 8; offset < png.length;) {
    const end = offset + 12 + view.getUint32(offset);
    const chunk = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    if (crc32(png.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)) {
      return { kind: "invalid", reason: `PNG ${chunk} CRC mismatch.` };
    }
    if (chunk === "IEND") break;
    const data = png.subarray(offset + 8, end - 4);
    if ((chunk === "iTXt" || chunk === "zTXt") && hasSelectionKeyword(data)) {
      if (carrier) return { kind: "invalid", reason: "Duplicate ChemDraft PNG selection chunks." };
      carrier = { chunk, data };
    }
    offset = end;
  }
  if (!carrier) return { kind: "absent" };

  const { chunk, data } = carrier;
  try {
    const { compressed, bytes } = carrierText(chunk, data);
    const text = compressed
      ? await inflateBounded([bytes], new DecompressionStream("deflate"), MAX_IMAGE_OBJECT_BYTES,
        "PNG selection exceeds the 25 MB inflated limit.")
      : bytes;
    // Older zTXt carriers also used UTF-8, despite the PNG specification's Latin-1 convention.
    const json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(text);
    return { kind: "found", chunk, json };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { kind: "invalid", reason: `Invalid PNG ${chunk} selection: ${reason}` };
  }
}
