import { MAX_IMAGE_OBJECT_BYTES, buildPngChunk, concatBytes, pngChunkAt, validatePngImage } from "@chemdraft/chem-core";

/** Uncompressed UTF-8 iTXt: the same versioned JSON as the private clipboard flavor. */
export const CHEMDRAFT_PNG_SELECTION_KEYWORD = "application/x-chemdraft-selection+json";

/** Keep pixels/density untouched; replace only ChemDraft's own metadata before IEND. */
export function pngWithChemDraftSelection(png: Uint8Array, selectionJson: string): Uint8Array {
  const validation = validatePngImage(png);
  if (validation.error) throw new Error(`Clipboard PNG failed validation: ${validation.error}`);
  const encoder = new TextEncoder();
  const keyword = encoder.encode(CHEMDRAFT_PNG_SELECTION_KEYWORD);
  // Keyword terminator, compression flag/method, empty language and translated keyword.
  const prefix = encoder.encode(`${CHEMDRAFT_PNG_SELECTION_KEYWORD}\0\0\0\0\0`);
  const text = encoder.encode(selectionJson);
  const chunkLength = 12 + prefix.length + text.length;
  if (chunkLength + png.length > MAX_IMAGE_OBJECT_BYTES) {
    throw new Error("Clipboard PNG with editable selection data exceeds the 25 MB picture limit.");
  }
  const chunk = buildPngChunk("iTXt", concatBytes([prefix, text]));

  const parts = [png.subarray(0, 8)];
  for (let offset = 8, next = pngChunkAt(png, offset); next; next = pngChunkAt(png, offset)) {
    const { type, length, end } = next;
    const ownMetadata = ["iTXt", "tEXt", "zTXt"].includes(type)
      && length > keyword.length && png[offset + 8 + keyword.length] === 0
      && keyword.every((byte, index) => byte === png[offset + 8 + index]);
    if (type === "IEND") parts.push(chunk);
    if (!ownMetadata) parts.push(png.subarray(offset, end));
    if (type === "IEND") break;
    offset = end;
  }
  return concatBytes(parts);
}
