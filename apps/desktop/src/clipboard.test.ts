import { describe, expect, it } from "vitest";
import {
  clipboardPayloadFromDataTransfer,
  normalizeClipboardWriteTextItems,
  pngWithPhysicalDensity,
  writeClipboardDataTransfer
} from "./clipboard";

describe("desktop clipboard bridge", () => {
  it("extracts text items from paste event clipboard data", () => {
    const payload = clipboardPayloadFromDataTransfer({
      types: ["text/html", "text/plain", "public.svg-image"],
      getData: (type: string) => {
        if (type === "text/plain") {
          return "pasted text";
        }

        if (type === "public.svg-image") {
          return "<svg />";
        }

        return "";
      }
    } as unknown as DataTransfer);

    expect(payload).toEqual({
      types: ["text/html", "text/plain", "public.svg-image"],
      textItems: [
        { type: "text/plain", text: "pasted text" },
        { type: "public.svg-image", text: "<svg />" }
      ]
    });
  });

  it("normalizes clipboard write items without keeping duplicate or empty types", () => {
    expect(normalizeClipboardWriteTextItems([
      { type: " application/vnd.chemdraft.selection+json ", text: "{}" },
      { type: "text/plain", text: "{}" },
      { type: "text/plain", text: "duplicate" },
      { type: "", text: "missing type" },
      { type: "text/html", text: "" }
    ])).toEqual([
      { type: "application/vnd.chemdraft.selection+json", text: "{}" },
      { type: "text/plain", text: "{}" }
    ]);
  });

  it("writes all ChemDraft clipboard flavors into copy event data", () => {
    const writes: Record<string, string> = {};
    const wrote = writeClipboardDataTransfer({
      setData: (type: string, text: string) => {
        writes[type] = text;
      }
    } as unknown as DataTransfer, [
      { type: "application/vnd.chemdraft.selection+json", text: "selection-json" },
      { type: "text/plain", text: "selection-json" }
    ]);

    expect(wrote).toBe(true);
    expect(writes).toEqual({
      "application/vnd.chemdraft.selection+json": "selection-json",
      "text/plain": "selection-json"
    });
  });

  it("reports failed copy event writes instead of pretending success", () => {
    const wrote = writeClipboardDataTransfer({
      setData: () => {
        throw new Error("clipboard is locked");
      }
    } as unknown as DataTransfer, [
      { type: "text/plain", text: "selection-json" }
    ]);

    expect(wrote).toBe(false);
  });
});

describe("pngWithPhysicalDensity", () => {
  const pngChunk = (type: string, data: readonly number[]): number[] => {
    const length = [0, 0, 0, data.length >>> 0];
    const typeBytes = Array.from(type, (char) => char.charCodeAt(0));
    return [...length, ...typeBytes, ...data, 0, 0, 0, 0];
  };
  const minimalPng = (extraChunks: readonly number[] = []): Uint8Array =>
    Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ...pngChunk("IHDR", Array.from({ length: 13 }, () => 0)),
      ...extraChunks,
      ...pngChunk("IEND", [])
    ]);

  const readPhysChunks = (bytes: Uint8Array): Array<{ ppmX: number; ppmY: number; unit: number; offset: number }> => {
    const found: Array<{ ppmX: number; ppmY: number; unit: number; offset: number }> = [];
    for (let offset = 8; offset + 8 <= bytes.length; ) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
      const length = view.getUint32(0);
      const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
      if (type === "pHYs") {
        found.push({ ppmX: view.getUint32(8), ppmY: view.getUint32(12), unit: bytes[offset + 16], offset });
      }
      offset += 12 + length;
    }
    return found;
  };

  it("inserts a metric pHYs chunk directly after IHDR", () => {
    const output = pngWithPhysicalDensity(minimalPng(), 288);
    const physChunks = readPhysChunks(output);
    expect(physChunks).toHaveLength(1);
    // 288 dpi is 11339 pixels per meter; unit byte 1 means "per meter".
    expect(physChunks[0]).toMatchObject({ ppmX: 11339, ppmY: 11339, unit: 1 });
    expect(physChunks[0].offset).toBe(8 + 12 + 13);
  });

  it("replaces an existing pHYs chunk instead of duplicating it", () => {
    const stale = pngChunk("pHYs", [0, 0, 0, 1, 0, 0, 0, 1, 1]);
    const output = pngWithPhysicalDensity(minimalPng(stale), 144);
    const physChunks = readPhysChunks(output);
    expect(physChunks).toHaveLength(1);
    expect(physChunks[0].ppmX).toBe(Math.round(144 / 0.0254));
  });

  it("returns non-PNG or malformed payloads unchanged", () => {
    const notPng = Uint8Array.from([1, 2, 3, 4]);
    expect(pngWithPhysicalDensity(notPng, 288)).toBe(notPng);
    const png = minimalPng();
    expect(pngWithPhysicalDensity(png, Number.NaN)).toBe(png);
    expect(pngWithPhysicalDensity(png, -72)).toBe(png);
  });
});
