/** The decoded payload limit, shared by model validation and image builders. */
export const MAX_IMAGE_OBJECT_BYTES = 25 * 1024 * 1024;

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
  try {
    atob(dataBase64);
  } catch {
    return `${label} has invalid base64 image data.`;
  }
  return undefined;
}

export function decodeImageBase64(dataBase64: string, id: string): Uint8Array {
  const error = imageBase64Error(dataBase64, id);
  if (error) throw new Error(error);
  return Uint8Array.from(atob(dataBase64), (char) => char.charCodeAt(0));
}
