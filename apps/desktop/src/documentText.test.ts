import { describe, expect, it } from "vitest";
import { decodeDocumentBytes } from "./documentText";

const xml = '<?xml version="1.0"?><CDXML><page id="1"/></CDXML>';

function utf16(text: string, endian: "le" | "be", bom = true): Uint8Array {
  const out = new Uint8Array((bom ? 2 : 0) + text.length * 2);
  let offset = 0;
  if (bom) {
    out.set(endian === "le" ? [0xff, 0xfe] : [0xfe, 0xff]);
    offset = 2;
  }
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out[offset + i * 2] = endian === "le" ? code & 0xff : code >> 8;
    out[offset + i * 2 + 1] = endian === "le" ? code >> 8 : code & 0xff;
  }
  return out;
}

describe("decodeDocumentBytes", () => {
  it("reads UTF-8 with and without a byte-order mark", () => {
    const plain = new TextEncoder().encode(xml);
    expect(decodeDocumentBytes(plain)).toBe(xml);
    expect(decodeDocumentBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...plain]))).toBe(xml);
  });

  it("reads UTF-16 little- and big-endian XML by its byte-order mark", () => {
    expect(decodeDocumentBytes(utf16(xml, "le"))).toBe(xml);
    expect(decodeDocumentBytes(utf16(xml, "be"))).toBe(xml);
  });

  it("drops a dangling odd byte after UTF-16, as the Rust decoder does", () => {
    const truncated = new Uint8Array([...utf16(xml, "le"), 0x41]);
    expect(decodeDocumentBytes(truncated)).toBe(xml);
  });

  it("never throws on binary input, and keeps an ASCII signature readable", () => {
    const cdx = new Uint8Array([...new TextEncoder().encode("VjCD0100"), 0x04, 0x03, 0x02, 0x01, 0xff, 0x00, 0x80]);
    const text = decodeDocumentBytes(cdx);
    expect(text.startsWith("VjCD0100")).toBe(true);
  });
});
