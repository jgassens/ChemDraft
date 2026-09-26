/**
 * Turn an opened file's bytes into the text the document opener parses. The same rule runs in Rust
 * for files opened from the shell (`decode_document_text` in lib.rs), so a file opens the same way
 * whether it arrives by File ▸ Open or by a double-click in Explorer.
 *
 * A byte-order mark decides: UTF-8, UTF-16LE, or UTF-16BE (XML written by .NET, PowerShell, and some
 * Windows tools is UTF-16). Without one the bytes are UTF-8, decoded leniently: a binary file must
 * still reach the opener — which says what it is (a ChemDraw .cdx, say) — instead of failing inside
 * the read with a bare "invalid UTF-8".
 */
export function decodeDocumentBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  return new TextDecoder("utf-8").decode(bytes);
}
