// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { ANALYSIS_WINDOW_ACTION_EVENT, listenForAnalysisWindowActions } from "./panelBridge";
import {
  handleSpectrumWindowAction,
  MAX_SPECTRUM_TRANSFER_BYTES,
  type SpectrumWindowActionDependencies
} from "./spectrumExport";

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==";
const pngBytes = Uint8Array.from(atob(pngBase64), (character) => character.charCodeAt(0));
const copy = { kind: "copySpectrum", requestId: "copy-1", pngBase64, svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' };
const save = {
  kind: "saveBinaryFile", requestId: "save-1", filename: "spectrum.png", bytesBase64: pngBase64,
  format: "png"
};

function fakes() {
  return {
    writeClipboard: vi.fn<SpectrumWindowActionDependencies["writeClipboard"]>().mockResolvedValue({
      ok: true, written: ["image/png", "image/svg+xml"], failed: [], warnings: []
    }),
    saveBinary: vi.fn<SpectrumWindowActionDependencies["saveBinary"]>().mockResolvedValue("saved"),
    saveText: vi.fn<SpectrumWindowActionDependencies["saveText"]>().mockResolvedValue("saved"),
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

  it.each([["x", 1], ["μ", 2], ["界", 3], ["😀", 4], ["\ud800", 3], ["\udc00", 3]] as const)(
    "counts UTF-8 for %s at the exact remaining budget for both SVG flavors", async (character, byteSize) => {
      const dependencies = fakes();
      const budget = Math.floor((MAX_SPECTRUM_TRANSFER_BYTES - pngBytes.length) / 2);
      const svg = character.repeat(Math.floor(budget / byteSize)) + "x".repeat(budget % byteSize);
      const encode = vi.spyOn(TextEncoder.prototype, "encode");
      await handleSpectrumWindowAction({ ...copy, svg }, dependencies);
      expect(dependencies.respondCopy).toHaveBeenLastCalledWith("copy-1", true);
      dependencies.writeClipboard.mockClear();
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

  it.each(["saved", "cancelled", "failed"] as const)("returns the native binary save result: %s", async (result) => {
    const dependencies = fakes();
    dependencies.saveBinary.mockResolvedValue(result);
    await handleSpectrumWindowAction(save, dependencies);
    expect(dependencies.saveBinary).toHaveBeenCalledWith("spectrum.png", pngBytes, {
      title: "Export spectrum as PNG", formatLabel: "PNG", extensions: ["png"], mimeType: "image/png"
    });
    expect(dependencies.respondSave).toHaveBeenCalledWith("save-1", result);
  });

  it("decodes and saves PDF bytes without converting them to text", async () => {
    const dependencies = fakes();
    await handleSpectrumWindowAction({
      ...save, filename: "spectrum.pdf", bytesBase64: btoa("%PDF-1.4\n"), format: "pdf"
    }, dependencies);
    expect(dependencies.saveBinary.mock.calls[0][0]).toBe("spectrum.pdf");
    expect(Array.from(dependencies.saveBinary.mock.calls[0][1])).toEqual(Array.from(new TextEncoder().encode("%PDF-1.4\n")));
    expect(dependencies.saveBinary.mock.calls[0][2]).toEqual(expect.objectContaining({ mimeType: "application/pdf", extensions: ["pdf"] }));
    expect(dependencies.respondSave).toHaveBeenCalledWith("save-1", "saved");
  });

  it.each([
    { filename: "../file.png" }, { filename: "C:\\file.png" }, { filename: "file\u0000.png" },
    { filename: 3 }, { filename: "" }, { filename: "CON.png" }, { filename: "file:stream.png" },
    { filename: "file.png " }, { filename: "x".repeat(201) }, { filename: ".." },
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
    const text = format === "jcamp" || format === "svg";
    await handleSpectrumWindowAction({
      ...save, kind: text ? "saveTextFile" : "saveBinaryFile", format, filename: "spectrum.exe",
      text: "μ spectrum", bytesBase64: format === "pdf" ? btoa("%PDF-1.4") : pngBase64,
      title: "Untrusted", formatLabel: "Executable", extensions: ["exe"], mimeType: "text/html"
    }, dependencies);
    const writer = text ? dependencies.saveText : dependencies.saveBinary;
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
