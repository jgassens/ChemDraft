/** Decode user text files, honoring a leading BOM without changing BOM-free UTF-8. */
export function decodeUserText(bytes: Buffer): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString("utf8");
  }
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
    : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : undefined;
  if (encoding) {
    try {
      return new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes.subarray(2));
    } catch {
      throw new Error(`Invalid ${encoding.toUpperCase()} text. Save the file as UTF-8 (PowerShell: Set-Content -Encoding UTF8).`);
    }
  }
  return bytes.toString("utf8");
}
