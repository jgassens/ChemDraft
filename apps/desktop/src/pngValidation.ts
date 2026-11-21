import { crc32 } from "./crc32";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const PNG_MAX_BYTES = 4 * 1024 * 1024;
const IHDR = 0x49484452;
const IDAT = 0x49444154;
const IEND = 0x49454e44;

export function hasPngSignature(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

export function checkPngDimensions(width: number, height: number, maxDimension: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 ||
      Math.max(width, height) > maxDimension) throw new Error("The rendered PNG exceeds the requested dimensions.");
}

export function checkPngRawSize(length: number): void {
  if (length > PNG_MAX_BYTES) throw new Error("Rendered PNG exceeds the 4 MiB limit.");
}

export function checkPngEncodedSize(length: number): void {
  if (length > PNG_MAX_BYTES) throw new Error("Encoded PNG exceeds the 4 MiB payload limit.");
}

/** Inspect PNG structure and checksums without decoding pixel data. */
export function validateBase64Png(data: string, maxDimension: number): void {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  checkPngRawSize(Math.floor(data.length / 4) * 3 - padding);
  checkPngEncodedSize(data.length);
  if (data.length < 44 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new Error("Expected base64 PNG data with a complete image header.");
  }
  const decoded = atob(data);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < bytes.length; index++) bytes[index] = decoded.charCodeAt(index);
  const view = new DataView(bytes.buffer);
  if (bytes.length < 33 || !hasPngSignature(bytes) || view.getUint32(8) !== 13 || view.getUint32(12) !== IHDR) {
    throw new Error("The tool image is missing a valid PNG signature or IHDR header.");
  }
  checkPngDimensions(view.getUint32(16), view.getUint32(20), maxDimension);

  let idatBytes: number | undefined;
  let previousType = IHDR;
  for (let offset = PNG_SIGNATURE.length; offset < bytes.length;) {
    if (bytes.length - offset < 12) throw new Error("The tool image has a truncated PNG chunk.");
    const length = view.getUint32(offset);
    const end = offset + length + 12;
    if (end > bytes.length) throw new Error("The tool image has a truncated PNG chunk.");
    const type = view.getUint32(offset + 4);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)) {
      throw new Error("The tool image has an invalid PNG chunk CRC.");
    }
    if (type === IHDR && offset !== PNG_SIGNATURE.length) throw new Error("The tool image has a duplicate PNG IHDR chunk.");
    if (type === IDAT) {
      if (idatBytes !== undefined && previousType !== IDAT) throw new Error("PNG IDAT chunks must be consecutive.");
      idatBytes = (idatBytes ?? 0) + length;
    } else if (type === IEND) {
      if (length !== 0 || end !== bytes.length) throw new Error("PNG IEND must be last and empty.");
      if (!idatBytes) throw new Error("The tool image is missing IDAT image data.");
      return;
    }
    previousType = type;
    offset = end;
  }
  throw new Error("The tool image is missing IEND.");
}
