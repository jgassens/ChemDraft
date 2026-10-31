// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { crc32, deflateSync } from "node:zlib";
import { pngWithPhysicalDensity } from "../clipboard";

import { ANALYSIS_WINDOW_ACTION_EVENT, listenForAnalysisWindowActions } from "./panelBridge";
import {
  handleSpectrumWindowAction,
  MAX_SPECTRUM_TRANSFER_BYTES,
  type SpectrumWindowActionDependencies
} from "./spectrumExport";

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const pngBytes = Uint8Array.from(atob(pngBase64), (character) => character.charCodeAt(0));
const copy = { kind: "copySpectrum", requestId: "copy-1", pngBase64, svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' };
const save = {
  kind: "saveBinaryFile", requestId: "save-1", filename: "spectrum.png", bytesBase64: pngBase64,
  format: "png"
};

function chunk(type: string, data: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(data.length + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  bytes.set(new TextEncoder().encode(type), 4);
  bytes.set(data, 8);
  view.setUint32(bytes.length - 4, crc32(bytes.subarray(4, -4)));
  return bytes;
}

const header = pngBytes.slice(8, 33);
const imageData = pngBytes.slice(33, -12);
const imageEnd = pngBytes.slice(-12);
function png(...chunks: Uint8Array[]): Uint8Array {
  const length = 8 + chunks.reduce((total, bytes) => total + bytes.length, 0);
  const result = new Uint8Array(length);
  result.set(pngBytes.slice(0, 8));
  let offset = 8;
  for (const bytes of chunks) {
    result.set(bytes, offset);
    offset += bytes.length;
  }
  return result;
}
function base64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}
function ihdr(change: (data: Uint8Array, view: DataView) => void): Uint8Array {
  const data = header.slice(8, -4);
  change(data, new DataView(data.buffer));
  return chunk("IHDR", data);
}
function phys(x: number, y = x, unit = 1): Uint8Array {
  const data = new Uint8Array(9);
  const view = new DataView(data.buffer);
  view.setUint32(0, x);
  view.setUint32(4, y);
  data[8] = unit;
  return chunk("pHYs", data);
}

function fakes() {
  return {
    writeClipboard: vi.fn<SpectrumWindowActionDependencies["writeClipboard"]>().mockResolvedValue({
      ok: true, written: ["image/png", "image/svg+xml"], failed: [], warnings: []
    }),
    saveBinary: vi.fn<SpectrumWindowActionDependencies["saveBinary"]>().mockResolvedValue("saved"),
    saveText: vi.fn<SpectrumWindowActionDependencies["saveText"]>().mockResolvedValue("saved"),
    pdf: vi.fn<SpectrumWindowActionDependencies["pdf"]>().mockResolvedValue(new TextEncoder().encode("%PDF-host")),
    respondCopy: vi.fn<SpectrumWindowActionDependencies["respondCopy"]>().mockResolvedValue(undefined),
    respondSave: vi.fn<SpectrumWindowActionDependencies["respondSave"]>().mockResolvedValue(undefined)
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("document-window spectrum actions", () => {
  it("writes a required PNG and both optional SVG flavors, without plain text, and answers success", async () => {
    const dependencies = fakes();
    await handleSpectrumWindowAction(copy, dependencies);
    expect(dependencies.writeClipboard).toHaveBeenCalledWith([
      { type: "image/png", bytes: pngBytes, required: true },
      { type: "public.svg-image", text: copy.svg, required: false },
      { type: "image/svg+xml", text: copy.svg, required: false }
    ]);
    expect(dependencies.respondCopy).toHaveBeenCalledWith("copy-1", true);
    expect(dependencies.writeClipboard.mock.calls[0][0].some((item) => item.type === "text/plain")).toBe(false);
  });

  it("keeps PNG success when the optional SVG cannot be written", async () => {
    const dependencies = fakes();
    dependencies.writeClipboard.mockResolvedValue({
      ok: true, written: ["image/png"], failed: [{ type: "image/svg+xml", reason: "unsupported" }], warnings: []
    });
    await handleSpectrumWindowAction(copy, dependencies);
    expect(dependencies.respondCopy).toHaveBeenCalledWith("copy-1", true);
  });

  it("requires PNG success and answers clipboard errors", async () => {
    const dependencies = fakes();
    dependencies.writeClipboard.mockResolvedValue({ ok: true, written: ["image/svg+xml"], failed: [], warnings: [] });
    await handleSpectrumWindowAction(copy, dependencies);
    expect(dependencies.respondCopy).toHaveBeenLastCalledWith("copy-1", false);
    dependencies.writeClipboard.mockRejectedValue(new Error("denied"));
    await handleSpectrumWindowAction(copy, dependencies);
    expect(dependencies.respondCopy).toHaveBeenLastCalledWith("copy-1", false);
  });

  it("allows PNG-only requests without introducing a text fallback", async () => {
    const dependencies = fakes();
    await handleSpectrumWindowAction({ ...copy, svg: undefined }, dependencies);
    expect(dependencies.writeClipboard).toHaveBeenCalledWith([{ type: "image/png", bytes: pngBytes, required: true }]);
  });

  it.each([["x", 1], ["μ", 2], ["界", 3], ["😀", 4]] as const)(
    "counts UTF-8 for %s at the exact remaining budget for both SVG flavors", async (character, byteSize) => {
      const dependencies = fakes();
      const budget = Math.floor((MAX_SPECTRUM_TRANSFER_BYTES - pngBytes.length) / 2);
      const wrapper = "<svg><text></text></svg>";
      const textBudget = budget - wrapper.length;
      const svg = `<svg><text>${character.repeat(Math.floor(textBudget / byteSize))}${"x".repeat(textBudget % byteSize)}</text></svg>`;
      const encode = vi.spyOn(TextEncoder.prototype, "encode");
      await handleSpectrumWindowAction({ ...copy, svg }, dependencies);
      expect(dependencies.respondCopy).toHaveBeenLastCalledWith("copy-1", true);
      dependencies.writeClipboard.mockClear();
      encode.mockClear();
      const decode = vi.spyOn(globalThis, "atob");
      await handleSpectrumWindowAction({ ...copy, svg: svg + "x" }, dependencies);
      expect(dependencies.respondCopy).toHaveBeenLastCalledWith("copy-1", false);
      expect(encode).not.toHaveBeenCalled();
      expect(decode).not.toHaveBeenCalled();
      expect(dependencies.writeClipboard).not.toHaveBeenCalled();
    }
  );

  it.each([
    { pngBase64: 12 }, { pngBase64: "" }, { pngBase64: "????" }, { pngBase64: "YWJj=" },
    { pngBase64: "Y=Jj" }, { svg: 12 }, { svg: "" },
    { pngBase64: "A".repeat(Math.ceil(MAX_SPECTRUM_TRANSFER_BYTES / 3) * 4 + 4) },
    { svg: "x".repeat(MAX_SPECTRUM_TRANSFER_BYTES + 1) },
    { svg: "x".repeat(MAX_SPECTRUM_TRANSFER_BYTES) },
    { svg: "μ".repeat(MAX_SPECTRUM_TRANSFER_BYTES / 2) },
    { svg: "x".repeat(MAX_SPECTRUM_TRANSFER_BYTES / 2) },
    { svg: "界".repeat(Math.floor(MAX_SPECTRUM_TRANSFER_BYTES / 3)) }
  ])("rejects invalid or oversized clipboard payloads before decoding (%#)", async (invalid) => {
    const dependencies = fakes();
    const decode = vi.spyOn(globalThis, "atob");
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    await handleSpectrumWindowAction({ ...copy, ...invalid }, dependencies);
    expect(decode).not.toHaveBeenCalled();
    expect(encode).not.toHaveBeenCalled();
    expect(dependencies.writeClipboard).not.toHaveBeenCalled();
    expect(dependencies.respondCopy).toHaveBeenCalledWith("copy-1", false);
  });

  it("refuses binary data without a PNG signature", async () => {
    const dependencies = fakes();
    await handleSpectrumWindowAction({ ...copy, pngBase64: btoa("this is not a PNG") }, dependencies);
    expect(dependencies.writeClipboard).not.toHaveBeenCalled();
    expect(dependencies.respondCopy).toHaveBeenCalledWith("copy-1", false);
  });

  it("accepts Chromium color chunks before IDAT and rejects duplicates, late chunks and oversized profiles", async () => {
    const dependencies = fakes();
    const gamma = chunk("gAMA", new Uint8Array(4));
    const chromaticity = chunk("cHRM", new Uint8Array(32));
    const profile = chunk("iCCP", new Uint8Array([0x70, 0, 0, 1]));
    const valid = png(header, gamma, chromaticity, profile, imageData, imageEnd);
    await handleSpectrumWindowAction({ ...copy, pngBase64: base64(valid) }, dependencies);
    expect(dependencies.writeClipboard).toHaveBeenCalledWith([
      { type: "image/png", bytes: valid, required: true },
      { type: "public.svg-image", text: copy.svg, required: false },
      { type: "image/svg+xml", text: copy.svg, required: false }
    ]);
    expect(dependencies.respondCopy).toHaveBeenCalledWith("copy-1", true);

    for (const invalid of [
      png(header, gamma, gamma, imageData, imageEnd),
      png(header, imageData, profile, imageEnd),
      png(header, chunk("iCCP", new Uint8Array(1024 * 1024 + 1)), imageData, imageEnd)
    ]) {
      const isolated = fakes();
      await handleSpectrumWindowAction({ ...copy, pngBase64: base64(invalid) }, isolated);
      expect(isolated.writeClipboard).not.toHaveBeenCalled();
      expect(isolated.respondCopy).toHaveBeenCalledWith("copy-1", false);
    }
  });

  it.each([
    pngBytes.slice(0, 33),
    pngBytes.map((byte, index) => index === 29 ? byte ^ 1 : byte),
    pngBytes.map((byte, index) => index === 45 ? byte ^ 1 : byte),
    pngBytes.map((byte, index) => index === pngBytes.length - 1 ? byte ^ 1 : byte),
    png(imageData, header, imageEnd), png(header, header, imageData, imageEnd),
    png(chunk("IHDR", new Uint8Array(12)), imageData, imageEnd),
    png(ihdr((_data, view) => view.setUint32(0, 0)), imageData, imageEnd),
    png(ihdr((_data, view) => view.setUint32(4, 16385)), imageData, imageEnd),
    png(ihdr((_data, view) => { view.setUint32(0, 16384); view.setUint32(4, 16384); }), imageData, imageEnd),
    png(ihdr((data) => { data[8] = 16; }), imageData, imageEnd),
    png(ihdr((data) => { data[9] = 3; }), imageData, imageEnd),
    png(ihdr((data) => { data[10] = 1; }), imageData, imageEnd),
    png(ihdr((data) => { data[11] = 1; }), imageData, imageEnd),
    png(ihdr((data) => { data[12] = 1; }), imageData, imageEnd),
    png(header, imageEnd), png(header, imageData), png(header, imageData, chunk("IEND", new Uint8Array(1))),
    png(header, imageData, imageEnd, new Uint8Array([1])),
    png(header, chunk("tEXt", new TextEncoder().encode("payload")), imageData, imageEnd),
    png(header, chunk("acTL", new Uint8Array(8)), imageData, imageEnd),
    png(header, phys(0), imageData, imageEnd), png(header, phys(1), imageData, imageEnd),
    png(header, phys(11339, 0), imageData, imageEnd), png(header, phys(0xffffffff), imageData, imageEnd),
    png(header, phys(11339, 11339, 0), imageData, imageEnd),
    png(header, chunk("pHYs", new Uint8Array(8)), imageData, imageEnd),
    png(header, phys(11339), phys(11339), imageData, imageEnd),
    png(header, imageData, phys(11339), imageEnd),
    png(header, chunk("IDAT", new Uint8Array()), phys(11339), imageData, imageEnd),
    png(header, phys(11339).map((byte, index) => index === 20 ? byte ^ 1 : byte), imageData, imageEnd),
    png(header, chunk("sRGB", new Uint8Array([4])), imageData, imageEnd),
    png(header, chunk("eXIf", new Uint8Array()), imageData, imageEnd),
    png(header, chunk("eXIf", new Uint8Array(65537)), imageData, imageEnd),
    png(header, new Uint8Array([0x7f, 0xff, 0xff, 0xff, 73, 68, 65, 84]), imageEnd)
  ])("rejects malformed PNG structure, CRC, dimensions, chunks and density for copy and save (%#)", async (bytes) => {
    const dependencies = fakes();
    await handleSpectrumWindowAction({ ...copy, pngBase64: base64(bytes) }, dependencies);
    await handleSpectrumWindowAction({ ...save, bytesBase64: base64(bytes) }, dependencies);
    expect(dependencies.writeClipboard).not.toHaveBeenCalled();
    expect(dependencies.saveBinary).not.toHaveBeenCalled();
    expect(dependencies.respondCopy).toHaveBeenCalledWith("copy-1", false);
    expect(dependencies.respondSave).toHaveBeenCalledWith("save-1", "failed");
  });

  it("preserves rasterizer PNG chunks, split IDATs, RGB and print density", async () => {
    const dependencies = fakes();
    const exif = new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const data = imageData.slice(8, -4);
    const bytes = pngWithPhysicalDensity(png(header, chunk("sRGB", new Uint8Array([0])), chunk("eXIf", exif),
      chunk("IDAT", data.slice(0, 5)), chunk("IDAT", data.slice(5)), imageEnd), 288);
    await handleSpectrumWindowAction({ ...copy, pngBase64: base64(bytes) }, dependencies);
    await handleSpectrumWindowAction({ ...save, bytesBase64: base64(bytes) }, dependencies);
    expect(dependencies.writeClipboard.mock.calls[0][0][0].bytes).toEqual(bytes);
    expect(dependencies.saveBinary.mock.calls[0][1]).toEqual(bytes);
    expect(dependencies.respondCopy).toHaveBeenCalledWith("copy-1", true);
    expect(dependencies.respondSave).toHaveBeenCalledWith("save-1", "saved");
    const rgb = png(ihdr((data) => { data[9] = 2; }), chunk("IDAT", deflateSync(new Uint8Array([0, 255, 0, 0]))), imageEnd);
    await handleSpectrumWindowAction({ ...save, bytesBase64: base64(rgb) }, dependencies);
    expect(dependencies.saveBinary).toHaveBeenLastCalledWith("spectrum.png", rgb, expect.any(Object));
  });

  it.each([
    '<script>alert(1)</script><foreignObject/><image href="https://attacker.invalid/x"/>',
    '<a href="https://attacker.invalid">link</a>', '<path onload="alert(1)"/>',
    '<style>@import "https://attacker.invalid/x";</style>'
  ])("refuses review SVG payloads for clipboard, file and PDF before privileged use (%#)", async (body) => {
    const dependencies = fakes();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
    await handleSpectrumWindowAction({ ...copy, svg }, dependencies);
    for (const format of ["svg", "pdf"]) {
      await handleSpectrumWindowAction({ ...save, kind: "saveTextFile", format, filename: `spectrum.${format}`, text: svg }, dependencies);
    }
    expect(dependencies.writeClipboard).not.toHaveBeenCalled();
    expect(dependencies.saveText).not.toHaveBeenCalled();
    expect(dependencies.saveBinary).not.toHaveBeenCalled();
    expect(dependencies.pdf).not.toHaveBeenCalled();
  });

  it.each([
    ["report\u202Efdp.svg", "reportfdp.svg"],
    ["\u2066predicted-13C-nmr\u2069.svg", "predicted-13C-nmr.svg"],
    ["spec\u200btrum\u00ad\ufeff.svg", "spectrum.svg"],
    ["cafe\u0301.svg", "café.svg"], ["predicted-1H-nmr.svg", "predicted-1H-nmr.svg"]
  ])("normalizes hostile filename controls without changing ordinary defaults: %s", async (filename, expected) => {
    const dependencies = fakes();
    await handleSpectrumWindowAction({ kind: "saveTextFile", requestId: "name", filename, format: "svg", text: copy.svg }, dependencies);
    expect(dependencies.saveText.mock.calls[0][0]).toBe(expected);
  });

  it.each(["saved", "cancelled", "failed"] as const)("returns the native binary save result: %s", async (result) => {
    const dependencies = fakes();
    dependencies.saveBinary.mockResolvedValue(result);
    await handleSpectrumWindowAction(save, dependencies);
    expect(dependencies.saveBinary).toHaveBeenCalledWith("spectrum.png", pngBytes, {
      title: "Export spectrum as PNG", formatLabel: "PNG", extensions: ["png"], mimeType: "image/png"
    });
    expect(dependencies.respondSave).toHaveBeenCalledWith("save-1", result);
  });

  it("refuses panel PDF bytes, including a signature-valid JavaScript OpenAction", async () => {
    const dependencies = fakes();
    await handleSpectrumWindowAction({
      ...save, filename: "spectrum.pdf", bytesBase64: btoa("%PDF-1.4\n<< /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>"), format: "pdf"
    }, dependencies);
    expect(dependencies.saveBinary).not.toHaveBeenCalled();
    expect(dependencies.pdf).not.toHaveBeenCalled();
    expect(dependencies.respondSave).toHaveBeenCalledWith("save-1", "failed");
  });

  it("generates PDF in the document window from sanitized SVG", async () => {
    const dependencies = fakes();
    await handleSpectrumWindowAction({
      ...save, kind: "saveTextFile", filename: "spectrum.pdf", text: copy.svg, format: "pdf"
    }, dependencies);
    expect(dependencies.pdf).toHaveBeenCalledWith(copy.svg);
    expect(dependencies.saveBinary.mock.calls[0][0]).toBe("spectrum.pdf");
    expect(dependencies.saveBinary.mock.calls[0][1]).toEqual(new TextEncoder().encode("%PDF-host"));
    expect(dependencies.saveBinary.mock.calls[0][2]).toEqual(expect.objectContaining({ mimeType: "application/pdf", extensions: ["pdf"] }));
    expect(dependencies.respondSave).toHaveBeenCalledWith("save-1", "saved");
  });

  it.each([
    { filename: "../file.png" }, { filename: "C:\\file.png" }, { filename: "file\u0000.png" },
    { filename: 3 }, { filename: "" }, { filename: "CON.png" }, { filename: "file:stream.png" },
    { filename: "file.png " }, { filename: "x".repeat(201) }, { filename: ".." },
    { filename: "CONIN$.png" }, { filename: "conout$.png" },
    { filename: "COM¹.png" }, { filename: "com².png" }, { filename: "LPT³.png" },
    { filename: "COM\u200b¹.png" }, { format: "pdf" },
    { format: "exe" }, { format: "toString" }, { format: null }, { format: "svg" },
    { bytesBase64: "?===" }, { bytesBase64: 1 },
    { bytesBase64: "A".repeat(Math.ceil(MAX_SPECTRUM_TRANSFER_BYTES / 3) * 4 + 4) }
  ])("refuses malformed binary saves before decoding or opening a dialog (%#)", async (invalid) => {
    const dependencies = fakes();
    const decode = vi.spyOn(globalThis, "atob");
    await handleSpectrumWindowAction({ ...save, ...invalid }, dependencies);
    expect(decode).not.toHaveBeenCalled();
    expect(dependencies.saveBinary).not.toHaveBeenCalled();
    expect(dependencies.respondSave).toHaveBeenCalledWith("save-1", "failed");
  });

  it.each(["jcamp", "svg", "png", "pdf"] as const)("owns metadata and forces the extension for %s saves", async (format) => {
    const dependencies = fakes();
    const text = format !== "png";
    await handleSpectrumWindowAction({
      ...save, kind: text ? "saveTextFile" : "saveBinaryFile", format, filename: "spectrum.exe",
      text: format === "jcamp" ? "μ spectrum" : copy.svg, bytesBase64: pngBase64,
      title: "Untrusted", formatLabel: "Executable", extensions: ["exe"], mimeType: "text/html"
    }, dependencies);
    const writer = format === "jcamp" || format === "svg" ? dependencies.saveText : dependencies.saveBinary;
    const extension = format === "jcamp" ? "jdx" : format;
    expect(writer.mock.calls[0][0]).toBe(`spectrum.${extension}`);
    expect(writer.mock.calls[0][2]).toEqual({
      title: format === "jcamp" ? "Export spectrum (JCAMP-DX)" : `Export spectrum as ${format.toUpperCase()}`,
      formatLabel: format === "jcamp" ? "JCAMP-DX" : format.toUpperCase(),
      extensions: format === "jcamp" ? ["jdx", "dx"] : [format],
      mimeType: { jcamp: "chemical/x-jcamp-dx", svg: "image/svg+xml", png: "image/png", pdf: "application/pdf" }[format]
    });
    expect(dependencies.respondSave).toHaveBeenCalledWith("save-1", "saved");
  });

  it.each([
    { text: 1 }, { text: "界".repeat(Math.floor(MAX_SPECTRUM_TRANSFER_BYTES / 3) + 1) },
    { text: "x".repeat(MAX_SPECTRUM_TRANSFER_BYTES + 1) },
    { filename: "../spectrum.svg" }, { filename: "C:\\spectrum.svg" }, { filename: "spectrum\n.svg" },
    { format: "png" }, { format: "html" }, { format: undefined }
  ])("rejects malformed text saves before encoding or opening a dialog (%#)", async (invalid) => {
    const dependencies = fakes();
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    const decode = vi.spyOn(globalThis, "atob");
    await handleSpectrumWindowAction({ kind: "saveTextFile", requestId: "text-1", filename: "spectrum.svg", format: "svg", text: "<svg/>", ...invalid }, dependencies);
    expect(encode).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
    expect(dependencies.saveText).not.toHaveBeenCalled();
    expect(dependencies.saveBinary).not.toHaveBeenCalled();
    expect(dependencies.respondSave).toHaveBeenCalledWith("text-1", "failed");
  });

  it.each(["saved", "cancelled", "failed"] as const)("returns the native text save result: %s", async (result) => {
    const dependencies = fakes();
    dependencies.saveText.mockResolvedValue(result);
    await handleSpectrumWindowAction({ kind: "saveTextFile", requestId: "text-1", filename: "spectrum.jdx", format: "jcamp", text: "data" }, dependencies);
    expect(dependencies.respondSave).toHaveBeenCalledWith("text-1", result);
  });

  it("refuses a binary signature mismatch and reports a thrown write failure", async () => {
    const dependencies = fakes();
    await handleSpectrumWindowAction({ ...save, bytesBase64: btoa("not a PNG") }, dependencies);
    expect(dependencies.saveBinary).not.toHaveBeenCalled();
    expect(dependencies.respondSave).toHaveBeenLastCalledWith("save-1", "failed");
    dependencies.saveBinary.mockRejectedValue(new Error("disk full"));
    await handleSpectrumWindowAction(save, dependencies);
    expect(dependencies.respondSave).toHaveBeenLastCalledWith("save-1", "failed");
  });

  it("ignores unknown actions or invalid request identifiers", async () => {
    const dependencies = fakes();
    for (const payload of [null, false, {}, { ...copy, kind: "exec" }, { ...copy, requestId: 3 }, { ...copy, requestId: "" }, { ...copy, requestId: "x".repeat(201) }]) {
      await handleSpectrumWindowAction(payload, dependencies);
    }
    expect(dependencies.writeClipboard).not.toHaveBeenCalled();
    expect(dependencies.saveBinary).not.toHaveBeenCalled();
    expect(dependencies.respondCopy).not.toHaveBeenCalled();
    expect(dependencies.respondSave).not.toHaveBeenCalled();
  });

  it("delivers malformed actions with a safe request ID through the listener so they receive failures", async () => {
    const dependencies = fakes();
    const pending: Promise<void>[] = [];
    const unlisten = listenForAnalysisWindowActions((action) => { pending.push(handleSpectrumWindowAction(action, dependencies)); });
    try {
      window.dispatchEvent(new CustomEvent(ANALYSIS_WINDOW_ACTION_EVENT, { detail: { kind: "copySpectrum", requestId: "bad-copy", pngBase64: 42 } }));
      window.dispatchEvent(new CustomEvent(ANALYSIS_WINDOW_ACTION_EVENT, { detail: { kind: "saveBinaryFile", requestId: "bad-save" } }));
      window.dispatchEvent(new CustomEvent(ANALYSIS_WINDOW_ACTION_EVENT, { detail: { kind: "saveTextFile", requestId: "bad-text" } }));
      await Promise.all(pending);
      expect(dependencies.respondCopy).toHaveBeenCalledWith("bad-copy", false);
      expect(dependencies.respondSave).toHaveBeenCalledWith("bad-save", "failed");
      expect(dependencies.respondSave).toHaveBeenCalledWith("bad-text", "failed");
    } finally {
      unlisten();
    }
  });
});
