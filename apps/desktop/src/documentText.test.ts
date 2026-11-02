import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertDocumentSize, decodeDocumentBytes, decodeNativeDocumentContents, documentContentsKey, MAX_OPEN_DOCUMENT_BYTES, readBrowserDocumentFile, readNativeDocumentFile } from "./documentText";
import { open, stat } from "@tauri-apps/plugin-fs";
import { exportDocumentToCdx } from "@chemdraft/cdx-compat";
import { applyNativeChainTool, createNativeSavePayload, createPhase4Document, exportPhase4Cdxml, openNativeDocument } from "./documentWorkflow";

const xml = '<?xml version="1.0"?><CDXML><page id="1"/></CDXML>';
vi.mock("@tauri-apps/plugin-fs", () => ({ stat: vi.fn(), open: vi.fn() }));

describe("bounded document opening", () => {
  beforeEach(() => vi.resetAllMocks());

  it("allows the exact limit and refuses oversized sizes", () => {
    expect(() => assertDocumentSize(MAX_OPEN_DOCUMENT_BYTES)).not.toThrow();
    for (const size of [MAX_OPEN_DOCUMENT_BYTES + 1, -1, NaN, Infinity]) {
      expect(() => assertDocumentSize(size)).toThrow("64 MB size limit");
    }
  });

  it("refuses an oversized browser file before allocating its arrayBuffer", async () => {
    const arrayBuffer = vi.fn();
    await expect(readBrowserDocumentFile({ size: MAX_OPEN_DOCUMENT_BYTES + 1, arrayBuffer })).rejects.toThrow("64 MB size limit");
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it.each(["drawing.cdx", "renamed.data", "C:\\drawings\\drawing.cdx"])("checks native metadata before reading %s", async (path) => {
    vi.mocked(stat).mockResolvedValue({ size: MAX_OPEN_DOCUMENT_BYTES + 1 } as Awaited<ReturnType<typeof stat>>);
    await expect(readNativeDocumentFile(path)).rejects.toThrow("64 MB size limit");
    expect(stat).toHaveBeenCalledWith(path);
    expect(open).not.toHaveBeenCalled();
  });

  it("decodes a permitted native file after checking metadata", async () => {
    vi.mocked(stat).mockResolvedValue({ size: xml.length } as Awaited<ReturnType<typeof stat>>);
    const data = new TextEncoder().encode(xml);
    const read = vi.fn().mockImplementationOnce(async (buffer: Uint8Array) => { buffer.set(data); return data.length; }).mockResolvedValueOnce(null);
    const close = vi.fn();
    vi.mocked(open).mockResolvedValue({ read, close } as unknown as Awaited<ReturnType<typeof open>>);
    expect(await readNativeDocumentFile("drawing.cdxml")).toBe(xml);
    expect(close).toHaveBeenCalledOnce();
  });

  it("refuses a file that grows after its metadata check and closes it", async () => {
    vi.mocked(stat).mockResolvedValue({ size: 1 } as Awaited<ReturnType<typeof stat>>);
    const read = vi.fn(async (buffer: Uint8Array) => buffer.length);
    const close = vi.fn();
    vi.mocked(open).mockResolvedValue({ read, close } as unknown as Awaited<ReturnType<typeof open>>);
    await expect(readNativeDocumentFile("drawing.cdx")).rejects.toThrow("Document exceeds the 64 MB size limit");
    expect(read.mock.calls.reduce((sum, [buffer]) => sum + buffer.length, 0)).toBe(MAX_OPEN_DOCUMENT_BYTES + 1);
    expect(close).toHaveBeenCalledOnce();
  });

  it("checks a shell byte array before iteration or copying", () => {
    const bytes = new Array<number>(MAX_OPEN_DOCUMENT_BYTES + 1);
    bytes.every = () => { throw new Error("must not iterate oversized transport"); };
    expect(() => decodeNativeDocumentContents({ contents: "", bytes })).toThrow("64 MB size limit");
    expect(decodeNativeDocumentContents({ contents: "", bytes: [1, 2, 255] })).toEqual(new Uint8Array([1, 2, 255]));
    expect(() => decodeNativeDocumentContents({ contents: "", bytes: [256] })).toThrow("invalid binary bytes");
  });

  it("refuses oversized binary contents before decoding or building a hash key", () => {
    const bytes = new Uint8Array(MAX_OPEN_DOCUMENT_BYTES + 1);
    expect(() => decodeDocumentBytes(bytes)).toThrow("64 MB size limit");
    expect(() => documentContentsKey(bytes)).toThrow("64 MB size limit");
  });
});

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

  it("preserves every CDX byte before decoding, including invalid UTF-8 and NUL", () => {
    const cdx = new Uint8Array([...new TextEncoder().encode("VjCD0100"), 0x04, 0x03, 0x02, 0x01, 0xff, 0x00, 0x80]);
    expect(decodeDocumentBytes(cdx)).toBe(cdx);
    expect(documentContentsKey(cdx)).not.toBe(documentContentsKey(new TextDecoder().decode(cdx)));
    const invalid = openNativeDocument(decodeDocumentBytes(cdx));
    expect(invalid.document).toBeUndefined();
    expect(invalid.warnings.some(warning => warning.code === "cdx.invalid_binary")).toBe(true);
  });

  it("opens header-detected CDX and keeps CDXML and native .chemdraft on the text path", () => {
    const document = applyNativeChainTool(createPhase4Document("Binary opening"), { x: 100, y: 100 }, { x: 180, y: 100 });
    const cdx = exportDocumentToCdx(document, { embedNativePayload: true });
    // Detection receives no extension: renamed files take the same path.
    const contents = decodeDocumentBytes(cdx.bytes);
    expect(contents).toBe(cdx.bytes);
    const openedCdx = openNativeDocument(contents);
    expect(openedCdx.document).toBeDefined();
    expect(openedCdx.document).toEqual(openNativeDocument(createNativeSavePayload(document).contents).document);
    for (const text of [exportPhase4Cdxml(document).contents, createNativeSavePayload(document).contents, JSON.stringify(document)]) {
      const decoded = decodeDocumentBytes(new TextEncoder().encode(text));
      expect(decoded).toBe(text);
      const opened = openNativeDocument(decoded);
      expect(opened.document, JSON.stringify(opened.warnings)).toBeDefined();
    }
    // A partial/mistyped signature is not enough to select the binary parser.
    expect(typeof decodeDocumentBytes(new TextEncoder().encode("VjCD0101"))).toBe("string");
  });
});
