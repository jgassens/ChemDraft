/** The decoded payload limit, shared by model validation and image builders. */
export const MAX_IMAGE_OBJECT_BYTES = 25 * 1024 * 1024;

/**
 * Why `dataBase64` is not picture data: not canonical base64 (only the base64 alphabet, padding only
 * at the end and only to a multiple of four), or over the size limit. Checked without decoding: text
 * that passes is exactly what `atob` accepts, so decoding it cannot fail.
 */
export function imageBase64Error(dataBase64: string, id: string): string | undefined {
  const label = `Image object ${id}`;
  const padding = dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0;
  const bodyLength = dataBase64.length - padding;
  if (bodyLength === 0 || bodyLength % 4 === 1 ||
    (padding > 0 && dataBase64.length % 4 !== 0) ||
    /[^A-Za-z0-9+/]/.test(dataBase64.slice(0, bodyLength))) {
    return `${label} has invalid base64 image data.`;
  }
  const byteLength = Math.floor(bodyLength * 3 / 4);
  if (byteLength > MAX_IMAGE_OBJECT_BYTES) {
    return `${label} is ${(byteLength / (1024 * 1024)).toFixed(1)} MB; the limit is 25 MB.`;
  }
  return undefined;
}

/**
 * Bytes of base64 text `imageBase64Error` accepts. The engine decodes it where it can
 * (`Uint8Array.fromBase64`: Safari 18.2, Chromium 140, Node 25); otherwise a plain loop over
 * `atob`'s string. Mapping each character through a callback (`Uint8Array.from(atob(text), callback)`)
 * took 140 ms for a 3 MB picture.
 */
export function decodeBase64Bytes(dataBase64: string): Uint8Array {
  const decoder = (Uint8Array as { fromBase64?: (value: string) => Uint8Array }).fromBase64;
  if (typeof decoder === "function") return decoder(dataBase64);
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function decodeImageBase64(dataBase64: string, id: string): Uint8Array {
  const error = imageBase64Error(dataBase64, id);
  if (error) throw new Error(error);
  return decodeBase64Bytes(dataBase64);
}
