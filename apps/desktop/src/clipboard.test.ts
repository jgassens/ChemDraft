import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clipboardPayloadFromDataTransfer,
  normalizeClipboardWriteTextItems,
  pngWithPhysicalDensity,
  writeClipboardDataTransfer,
  writeClipboardImage,
  writeClipboardItems,
  writeClipboardText,
  writeClipboardTextItems
} from "./clipboard";

const native = vi.hoisted(() => ({ desktop: true, invoke: vi.fn() }));
vi.mock("./window-manager", () => ({ isDesktopRuntime: () => native.desktop }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));

beforeEach(() => {
  native.desktop = true;
  native.invoke.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("desktop clipboard bridge", () => {
  it("extracts text items from paste event clipboard data", async () => {
    const payload = await clipboardPayloadFromDataTransfer({
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

describe("writeClipboardItems native transaction", () => {
  it("sends text, HTML, RTF and base64 binary in one invocation and returns per-item results", async () => {
    const result = {
      ok: true,
      written: ["text/plain", "text/html", "text/rtf", "image/png"],
      failed: [{ type: "application/pdf", reason: "format unavailable" }],
      warnings: []
    };
    native.invoke.mockResolvedValue(result);
    const items = [
      { type: "text/plain", text: "Δ" },
      { type: "text/html", text: "<html><!--StartFragment-->Δ<!--EndFragment--></html>" },
      { type: "text/rtf", text: "{\\rtf1 \\u916?}" },
      { type: "image/png", bytes: Uint8Array.from([0, 1, 255]) },
      { type: "application/pdf", bytes: Uint8Array.from([37, 80, 68, 70]), required: false }
    ];

    expect(await writeClipboardItems(items)).toEqual(result);
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("write_clipboard_items", {
      items: [
        { type: "text/plain", text: "Δ", required: true },
        { type: "text/html", text: items[1].text, required: true },
        { type: "text/rtf", text: items[2].text, required: true },
        { type: "image/png", bytesBase64: "AAH/", required: true },
        { type: "application/pdf", bytesBase64: "JVBERg==", required: false }
      ]
    });
  });

  it("reports a required write failure without retrying through the browser", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const result = {
      ok: false,
      written: ["text/plain"],
      failed: [{ type: "text/html", reason: "Could not write HTML Format" }],
      warnings: []
    };
    native.invoke.mockResolvedValue(result);
    expect(await writeClipboardItems([
      { type: "text/plain", text: "table" },
      { type: "text/html", text: "table" }
    ])).toEqual(result);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("returns native compatibility warnings without treating them as requested format failures", async () => {
    const result = {
      ok: true,
      written: ["image/png"],
      failed: [],
      warnings: ["Windows CF_DIBV5 copy skipped: picture is 20000x20000, over the 16384-pixel limit."]
    };
    native.invoke.mockResolvedValue(result);
    expect(await writeClipboardItems([{ type: "image/png", bytes: Uint8Array.from([137, 80]) }]))
      .toEqual(result);
    expect(await writeClipboardImage(Uint8Array.from([137, 80]))).toBe(true);
  });

  it("returns validation/IPC errors for each requested flavour and honours optional items", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    native.invoke.mockRejectedValue("HTML clipboard item has no <!--StartFragment--> marker");
    expect(await writeClipboardItems([
      { type: "text/html", text: "invalid" },
      { type: "text/plain", text: "table", required: false }
    ])).toEqual({
      ok: false,
      written: [],
      failed: [
        { type: "text/html", reason: "HTML clipboard item has no <!--StartFragment--> marker" },
        { type: "text/plain", reason: "HTML clipboard item has no <!--StartFragment--> marker" }
      ],
      warnings: []
    });
    native.invoke.mockRejectedValue(new Error("format unavailable"));
    expect(await writeClipboardItems([{ type: "private/data", text: "optional", required: false }]))
      .toEqual({ ok: true, written: [], failed: [{ type: "private/data", reason: "format unavailable" }], warnings: [] });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("drops empty items and keeps the first non-empty item for each trimmed type", async () => {
    native.invoke.mockResolvedValue({ ok: true, written: ["private/data", "text/plain"], failed: [], warnings: [] });
    await writeClipboardItems([
      { type: "private/data", bytes: new Uint8Array() },
      { type: " private/data ", bytes: Uint8Array.from([255]), required: false },
      { type: "private/data", text: "duplicate", required: true },
      { type: "text/plain", text: "" },
      { type: "text/plain", text: "first" },
      { type: "text/plain", text: "duplicate" },
      { type: " ", text: "missing type" }
    ]);
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("write_clipboard_items", {
      items: [
        { type: "private/data", bytesBase64: "/w==", required: true },
        { type: "text/plain", text: "first", required: true }
      ]
    });
  });

  it("keeps a trimmed type optional when every non-empty duplicate is optional", async () => {
    native.invoke.mockResolvedValue({ ok: true, written: ["private/data"], failed: [], warnings: [] });
    await writeClipboardItems([
      { type: "private/data", text: "first", required: false },
      { type: " private/data ", text: "duplicate", required: false }
    ]);
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("write_clipboard_items", {
      items: [{ type: "private/data", text: "first", required: false }]
    });
  });

  it("does not invoke or clear for an empty write", async () => {
    expect(await writeClipboardItems([])).toEqual({ ok: false, written: [], failed: [], warnings: [] });
    expect(await writeClipboardTextItems([{ type: "text/plain", text: "" }])).toBe(false);
    expect(await writeClipboardImage(new Uint8Array())).toBe(false);
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("base64-encodes large byte views without serializing arrays or overflowing argument limits", async () => {
    native.invoke.mockResolvedValue({ ok: true, written: ["image/png"], failed: [], warnings: [] });
    const buffer = new Uint8Array(200_002).fill(255);
    const bytes = buffer.subarray(1, -1);
    expect(await writeClipboardImage(bytes)).toBe(true);
    const encoded = native.invoke.mock.calls[0][1].items[0];
    expect(Object.keys(encoded)).toEqual(["type", "bytesBase64", "required"]);
    expect(encoded.bytesBase64).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("keeps text and image helpers boolean-returning delegates", async () => {
    native.invoke.mockResolvedValue({ ok: true, written: ["text/plain"], failed: [], warnings: [] });
    expect(await writeClipboardTextItems([{ type: "text/plain", text: "structure" }])).toBe(true);
    expect(await writeClipboardText("SMILES")).toBe(true);
    expect(native.invoke).toHaveBeenLastCalledWith("write_clipboard_items", {
      items: [{ type: "text/plain", text: "SMILES", required: true }]
    });
    native.invoke.mockResolvedValue({ ok: false, written: [], failed: [{ type: "image/png", reason: "locked" }], warnings: [] });
    expect(await writeClipboardImage(Uint8Array.from([137, 80]))).toBe(false);
    expect(native.invoke).toHaveBeenLastCalledWith("write_clipboard_items", {
      items: [{ type: "image/png", bytesBase64: "iVA=", required: true }]
    });
    native.invoke.mockResolvedValue({ ok: false, written: [], failed: [{ type: "text/plain", reason: "locked" }], warnings: [] });
    expect(await writeClipboardTextItems([{ type: "text/plain", text: "structure" }])).toBe(false);
  });
});

describe("writeClipboardItems browser fallback", () => {
  class BrowserClipboardItem {
    static supports = vi.fn((_type: string) => true);
    constructor(readonly data: Record<string, Blob>) {}
  }

  beforeEach(() => {
    native.desktop = false;
    BrowserClipboardItem.supports.mockReset().mockReturnValue(true);
    vi.stubGlobal("ClipboardItem", BrowserClipboardItem);
  });

  it("keeps plain-text preference and reports unsupported flavours honestly", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const write = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText, write } });
    expect(await writeClipboardItems([
      { type: "private/data", text: "private selection" },
      { type: "text/plain", text: "structure" }
    ])).toEqual({
      ok: false,
      written: ["text/plain"],
      failed: [{ type: "private/data", reason: "Browser clipboard does not support this format." }],
      warnings: []
    });
    expect(writeText).toHaveBeenCalledExactlyOnceWith("structure");
    expect(write).not.toHaveBeenCalled();
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("writes byte-backed plain text through writeText", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await writeClipboardItems([
      { type: "text/plain", bytes: new TextEncoder().encode("structure") }
    ])).toEqual({ ok: true, written: ["text/plain"], failed: [], warnings: [] });
    expect(writeText).toHaveBeenCalledExactlyOnceWith("structure");
  });

  it("keeps byte-backed plain text when optional HTML cannot be written", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await writeClipboardItems([
      { type: "text/plain", bytes: new TextEncoder().encode("expected") },
      { type: "text/html", text: "<b>different</b>", required: false }
    ])).toEqual({
      ok: true,
      written: ["text/plain"],
      failed: [{ type: "text/html", reason: "Browser clipboard does not support this format." }],
      warnings: []
    });
    expect(writeText).toHaveBeenCalledExactlyOnceWith("expected");
  });

  it("rejects byte-backed plain text that is not valid UTF-8", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await writeClipboardItems([
      { type: "text/plain", bytes: Uint8Array.from([0xc3, 0x28]) }
    ])).toEqual({
      ok: false,
      written: [],
      failed: [{ type: "text/plain", reason: "text/plain bytes are not valid UTF-8." }],
      warnings: []
    });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("keeps the legacy text helper lenient when plain text was written", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await writeClipboardTextItems([
      { type: "private/data", text: "private selection" },
      { type: "text/plain", text: "structure" }
    ])).toBe(true);
    expect(writeText).toHaveBeenLastCalledWith("structure");
    expect(await writeClipboardTextItems([{ type: "private/data", text: "fallback source" }])).toBe(true);
    expect(writeText).toHaveBeenLastCalledWith("fallback source");

    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { write } });
    expect(await writeClipboardTextItems([{ type: "text/html", text: "<b>table</b>" }])).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("writes HTML, PNG and plain text together in one ClipboardItem", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { write, writeText } });
    const result = await writeClipboardItems([
      { type: "text/plain", text: "Δ" },
      { type: "text/html", text: "<b>Δ</b>" },
      { type: "image/png", bytes: Uint8Array.from([137, 80]) },
      { type: "text/rtf", text: "{\\rtf1 text}", required: false }
    ]);
    expect(result).toEqual({
      ok: true,
      written: ["text/plain", "text/html", "image/png"],
      failed: [{ type: "text/rtf", reason: "Browser clipboard does not support this format." }],
      warnings: []
    });
    expect(write).toHaveBeenCalledTimes(1);
    const clipboardItems: BrowserClipboardItem[] = write.mock.calls[0][0];
    expect(clipboardItems).toHaveLength(1);
    const { data } = clipboardItems[0];
    expect(await data["text/plain"].text()).toBe("Δ");
    expect(await data["text/html"].text()).toBe("<b>Δ</b>");
    expect(Array.from(new Uint8Array(await data["image/png"].arrayBuffer()))).toEqual([137, 80]);
    expect(data["image/png"].type).toBe("image/png");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("uses the same browser image path for writeClipboardImage", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { write } });
    expect(await writeClipboardImage(Uint8Array.from([137, 80]))).toBe(true);
    expect(Object.keys(write.mock.calls[0][0][0].data)).toEqual(["image/png"]);
  });

  it("fails when a required rich flavour is omitted despite writing plain text", async () => {
    BrowserClipboardItem.supports.mockImplementation((type) => type !== "text/html");
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { write } });
    expect(await writeClipboardItems([
      { type: "text/html", text: "<b>table</b>", required: true },
      { type: "text/plain", text: "table" }
    ])).toEqual({
      ok: false,
      written: ["text/plain"],
      failed: [{ type: "text/html", reason: "Browser clipboard does not support this format." }],
      warnings: []
    });
  });

  it("does not claim a required private item was written as its plain-text fallback", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    expect(await writeClipboardItems([{ type: "private/data", text: "fallback source" }])).toEqual({
      ok: false,
      written: ["text/plain"],
      failed: [{ type: "private/data", reason: "Browser clipboard does not support this format." }],
      warnings: []
    });
  });

  it("preserves writeText fallback when rich clipboard APIs are unavailable or reject", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("ClipboardItem", undefined);
    expect(await writeClipboardTextItems([{ type: "text/html", text: "<b>source</b>" }])).toBe(true);
    expect(writeText).toHaveBeenLastCalledWith("<b>source</b>");

    vi.stubGlobal("ClipboardItem", BrowserClipboardItem);
    const write = vi.fn().mockRejectedValue(new Error("rich write refused"));
    vi.stubGlobal("navigator", { clipboard: { write, writeText } });
    expect(await writeClipboardItems([
      { type: "text/html", text: "<b>source</b>" },
      { type: "text/plain", text: "source" }
    ])).toEqual({
      ok: false,
      written: ["text/plain"],
      failed: [{ type: "text/html", reason: "rich write refused" }],
      warnings: []
    });
  });

  it("reports unavailable/denied clipboard access without throwing", async () => {
    vi.stubGlobal("navigator", {});
    expect((await writeClipboardItems([{ type: "text/plain", text: "table" }])).ok).toBe(false);
    expect(await writeClipboardImage(Uint8Array.from([137, 80]))).toBe(false);
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    expect(await writeClipboardItems([{ type: "text/plain", text: "table", required: false }])).toEqual({
      ok: true, written: [], failed: [{ type: "text/plain", reason: "denied" }], warnings: []
    });
    vi.stubGlobal("navigator", { clipboard: { write: vi.fn().mockRejectedValue(new Error("image refused")) } });
    expect(await writeClipboardItems([{ type: "image/png", bytes: Uint8Array.from([137, 80]) }])).toEqual({
      ok: false, written: [], failed: [{ type: "image/png", reason: "image refused" }], warnings: []
    });
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
