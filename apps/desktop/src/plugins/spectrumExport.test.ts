// @vitest-environment jsdom

import type { PluginLinkedFigureSpectrum } from "@chemdraft/plugin-api";
import { invoke } from "@tauri-apps/api/core";
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  copySpectrumToClipboard,
  exportSpectrumFigure,
  observeFrequencyMHz,
  saveTextFile,
  saveBinaryFile,
  spectrumToPdf,
  spectrumToJcampDx,
  standaloneSpectrumSvg,
  svgToPngBlob
} from "./spectrumExport";
import {
  ANALYSIS_WINDOW_ACTION_EVENT,
  ANALYSIS_WINDOW_ACTION_RESULT_EVENT,
  requestCopySpectrumFromMain,
  requestSaveBinaryFileFromMain
} from "./panelBridge";

const nativeSave = vi.hoisted(() => vi.fn());
const nativeWriteTextFile = vi.hoisted(() => vi.fn());
const nativeWriteFile = vi.hoisted(() => vi.fn());
const writeClipboard = vi.hoisted(() => vi.fn());
const convertSvg = vi.hoisted(() => vi.fn());

vi.mock("../clipboard", async (original) => ({
  ...await original<typeof import("../clipboard")>(),
  writeClipboardItems: writeClipboard
}));
vi.mock("@chemdraft/export-engine/pdf", () => ({ exportSvgToPdf: convertSvg }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: nativeSave }));
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...await original<typeof import("@tauri-apps/api/core")>(),
  invoke: vi.fn(async (command: string, args: { event: string; payload: unknown }) => {
    // Mirror the native allowlisted forwarder: detached panels cannot emit events directly.
    if (command !== "plugin_panel_event_forward") throw new Error(`Unexpected command: ${command}`);
    await bridgeEmit(args.event, args.payload);
  })
}));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: nativeWriteTextFile, writeFile: nativeWriteFile }));
const bridgeEmit = vi.hoisted(() => vi.fn());
const bridgeListeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/event", () => ({
  emit: bridgeEmit,
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    bridgeListeners.set(name, handler);
    return () => bridgeListeners.delete(name);
  }
}));

const originalClipboardItem = globalThis.ClipboardItem;

afterEach(() => {
  nativeSave.mockReset();
  nativeWriteTextFile.mockReset();
  nativeWriteFile.mockReset();
  writeClipboard.mockReset();
  convertSvg.mockReset();
  bridgeEmit.mockReset();
  bridgeListeners.clear();
  window.history.replaceState(null, "", "/");
  delete (globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  Reflect.deleteProperty(navigator, "clipboard");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (originalClipboardItem) {
    globalThis.ClipboardItem = originalClipboardItem;
  } else {
    Reflect.deleteProperty(globalThis, "ClipboardItem");
  }
});

const spectrum: PluginLinkedFigureSpectrum = {
  nucleus: "1H",
  domain: { min: 0, max: 8 },
  reversed: true,
  peaks: [
    { id: "a", ppm: 1.2, intensity: 3, atomIndices: [1] },
    { id: "b", ppm: 7.26, intensity: 5, atomIndices: [0] }
  ]
};

describe("spectrumToJcampDx", () => {
  it("omits absent method labels, supplies ownership status, and keeps every header ASCII", () => {
    const jdx = spectrumToJcampDx(spectrum, { title: "Predicted ¹³C NMR\n##OWNER=Injected" });
    expect(jdx).toMatch(/^##TITLE=Predicted 13C NMR ##OWNER=Injected\n/);
    expect(jdx).not.toContain("PRIMARY METHOD=");
    expect(jdx).not.toContain("ALTERNATIVE METHOD=");
    expect(jdx).toContain("\n##OWNER=UNKNOWN\n");
    expect(jdx).toMatch(/^[\x00-\x7f]*$/);
    const labelled = spectrumToJcampDx({ ...spectrum, comparison: { primaryLabel: "méthode", alternativeLabel: "δ check" } });
    expect(labelled).toContain("PRIMARY METHOD=methode");
    expect(labelled).toMatch(/^[\x00-\x7f]*$/);
  });
  it("emits a JCAMP-DX peak table with nucleus + frequency, peaks ppm-descending", () => {
    const jdx = spectrumToJcampDx(spectrum, { title: "Predicted 1H NMR", freqMHz: 400 });
    expect(jdx).toContain("##JCAMP-DX=5.01");
    expect(jdx).toContain("##DATA TYPE=NMR PEAK TABLE");
    expect(jdx).toContain("##.OBSERVE NUCLEUS=^1H");
    expect(jdx).toContain("##.OBSERVE FREQUENCY=400");
    expect(jdx).toContain("##PEAK TABLE=(XY..XY)");
    expect(jdx.trimEnd().endsWith("##END=")).toBe(true);

    const body = jdx.split("##PEAK TABLE=(XY..XY)\n")[1];
    expect(body.startsWith("7.2600, 5.000")).toBe(true); // highest ppm first
    expect(body).toContain("1.2000, 3.000");
  });

  it("maps ¹³C to the ^13C token", () => {
    expect(spectrumToJcampDx({ ...spectrum, nucleus: "13C" })).toContain("##.OBSERVE NUCLEUS=^13C");
  });

  it("exports the selected cross-check view instead of silently reverting to primary peaks", () => {
    const crossChecked: PluginLinkedFigureSpectrum = {
      ...spectrum,
      comparison: { primaryLabel: "HOSE", alternativeLabel: "increment", alternativeMarker: "ᵢ" },
      peaks: [{ id: "cc", ppm: 2, alternativePpm: 2.9, intensity: 1, atomIndices: [0] }]
    };

    const hose = spectrumToJcampDx(crossChecked, { comparisonMode: "primary" });
    expect(hose).toContain("2.0000, 1.000");
    expect(hose).not.toContain("2.9000, 1.000");
    expect(hose).toContain("##$CHEMDRAFT COMPARISON MODE=HOSE");
    expect(hose).toContain("##$CHEMDRAFT ALTERNATIVE METHOD=increment");
    expect(hose).toContain("##NPOINTS=1");

    const both = spectrumToJcampDx(crossChecked, { comparisonMode: "both" });
    expect(both).toContain("2.9000, 1.000");
    expect(both).toContain("2.0000, 1.000");
    expect(both).toContain("##NPOINTS=2");
  });

  it("normalizes a stale show-both export to the primary method when no alternatives exist", () => {
    const hoseOnly: PluginLinkedFigureSpectrum = {
      ...spectrum,
      comparison: { primaryLabel: "HOSE", alternativeLabel: "increment", alternativeMarker: "ᵢ" }
    };
    const jdx = spectrumToJcampDx(hoseOnly, { comparisonMode: "both" });
    expect(jdx).toContain("##$CHEMDRAFT COMPARISON MODE=HOSE");
    expect(jdx).toContain("##NPOINTS=2");
  });

  it("derives a 13C observe frequency from the proton-rated field and preserves intensity semantics", () => {
    const carbon = spectrumToJcampDx({ ...spectrum, nucleus: "13C" }, { protonFrequencyMHz: 300 });
    expect(observeFrequencyMHz("13C", 300)).toBeCloseTo(75.434859, 6);
    expect(carbon).toContain("##.OBSERVE FREQUENCY=75.434859");
    expect(carbon).toContain("##$CHEMDRAFT PROTON FREQUENCY=300");
    expect(carbon).toContain("Predicted equivalent-nuclei count; not experimental integration");
  });
});

describe("standaloneSpectrumSvg", () => {
  it("wraps the live svg into a self-contained, styled SVG document", () => {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg") as SVGSVGElement;
    svg.setAttribute("viewBox", "0 0 680 240");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("class", "lf-curve is-estimated");
    path.setAttribute("d", "M0 0 L10 10");
    svg.appendChild(path);
    const alternativePath = document.createElementNS(ns, "path");
    alternativePath.setAttribute("class", "lf-curve is-alternative");
    alternativePath.setAttribute("d", "M0 10 L10 0");
    svg.appendChild(alternativePath);

    const out = standaloneSpectrumSvg(svg, "increment", "HOSE");
    expect(out.startsWith("<?xml")).toBe(true);
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(out).toContain('width="680"');
    expect(out).toContain('height="240"');
    expect(out).toContain(".lf-curve{fill:none;stroke:#2f7d6f"); // inlined style travels with the copy
    expect(out).toContain(".lf-curve.is-estimated{stroke:#8a8f98");
    expect(out).toContain(".lf-curve.is-alternative{stroke:#b5651d");
    expect(out).toContain('class="lf-curve is-estimated"'); // original provenance class preserved
    expect(out).toContain('class="lf-curve is-alternative"');
    expect(out).toContain("Height = predicted equivalent nuclei (not experimental integration)");
    expect(out).toContain("grey dashed = rule-estimated");
    expect(out).toContain("dashed orange = increment");
    expect(out).toContain("methods = HOSE + increment");
    expect(out).toContain('data-comparison-mode="both"');
    expect(out).toContain('data-primary-method="HOSE"');
    expect(out).toContain("stroke-dasharray:5 3");
  });

  it("does not claim an orange comparison series when a copied SVG has only primary peaks", () => {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg") as SVGSVGElement;
    svg.setAttribute("viewBox", "0 0 680 240");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("class", "lf-curve");
    path.setAttribute("d", "M0 0 L10 10");
    svg.appendChild(path);

    const out = standaloneSpectrumSvg(svg, "increment", "HOSE");
    // A plain-primary spectrum makes no confidence or provenance claims it cannot show (ADR-0025).
    expect(out).not.toContain("lower confidence");
    expect(out).not.toContain("rule-estimated");
    expect(out).not.toContain("orange = increment");
    expect(out).toContain("method = HOSE only");
    expect(out).toContain('data-comparison-mode="primary"');
  });
});

describe("copySpectrumToClipboard", () => {
  it("writes both optional native SVG flavors alongside PNG without text", async () => {
    vi.stubGlobal("Blob", NodeBlob);
    (globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    writeClipboard.mockResolvedValue({ ok: true });
    await expect(copySpectrumToClipboard("<svg/>", async () => new Blob(["png"], { type: "image/png" }))).resolves.toBe("image");
    expect(writeClipboard).toHaveBeenCalledWith([
      { type: "image/png", bytes: expect.any(Uint8Array), required: true },
      { type: "public.svg-image", text: "<svg/>", required: false },
      { type: "image/svg+xml", text: "<svg/>", required: false }
    ]);
    expect(Array.from(writeClipboard.mock.calls[0][0][0].bytes)).toEqual([112, 110, 103]);
  });
  it("initiates ClipboardItem.write synchronously while PNG rasterization remains promise-backed", async () => {
    type ClipboardPayload = Record<string, Blob | Promise<Blob>>;
    class TestClipboardItem {
      static supports(type: string): boolean { return type === "image/svg+xml"; }
      static latest: TestClipboardItem | undefined;
      readonly types = ["image/png", "image/svg+xml"];
      readonly presentationStyle = "unspecified" as const;
      constructor(readonly payload: ClipboardPayload) {
        TestClipboardItem.latest = this;
      }
      async getType(type: string): Promise<Blob> {
        return await this.payload[type];
      }
    }
    globalThis.ClipboardItem = TestClipboardItem as unknown as typeof ClipboardItem;

    let resolvePng: ((blob: Blob | null) => void) | undefined;
    const rasterize = vi.fn(
      () =>
        new Promise<Blob | null>((resolve) => {
          resolvePng = resolve;
        })
    );
    const write = vi.fn((items: ClipboardItem[]) => items[0].getType("image/png").then(() => undefined));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write, writeText: vi.fn() }
    });

    const pending = copySpectrumToClipboard("<svg/>", rasterize);
    expect(rasterize).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce(); // called before resolvePng: user activation is still live
    expect(TestClipboardItem.latest?.payload["image/png"]).toBeInstanceOf(Promise);
    expect(TestClipboardItem.latest?.payload["image/svg+xml"]).toBeInstanceOf(Blob);
    expect(TestClipboardItem.latest?.payload["text/plain"]).toBeUndefined();

    resolvePng?.(new Blob(["png"], { type: "image/png" }));
    await expect(pending).resolves.toBe("image");
  });

  it.each([false, undefined])("omits unsupported SVG when supports returns %s and never writes text", async (support) => {
    let payload: Record<string, Blob | Promise<Blob>> = {};
    class TestItem {
      static supports = support === undefined ? undefined : () => support;
      constructor(contents: typeof payload) { payload = contents; }
    }
    vi.stubGlobal("ClipboardItem", TestItem);
    const write = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write, writeText } });
    await expect(copySpectrumToClipboard("<svg/>", async () => new Blob(["png"], { type: "image/png" }))).resolves.toBe("image");
    expect(Object.keys(payload)).toEqual(["image/png"]);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("returns none for unavailable or rejected image copy without a source-text fallback", async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await expect(copySpectrumToClipboard("<svg/>")).resolves.toBe("none");
    vi.stubGlobal("ClipboardItem", class { constructor(_contents: unknown) {} });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true, value: { write: vi.fn().mockRejectedValue(new Error("denied")), writeText }
    });
    await expect(copySpectrumToClipboard("<svg/>", async () => null)).resolves.toBe("none");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("routes desktop panel copy to the document and returns its real result", async () => {
    vi.stubGlobal("Blob", NodeBlob);
    (globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    window.history.replaceState(null, "", "/?window=pluginPanel");
    bridgeEmit.mockImplementation(async (_name: string, action: { requestId: string }) => {
      bridgeListeners.get(ANALYSIS_WINDOW_ACTION_RESULT_EVENT)?.({ payload: { requestId: action.requestId, ok: false } });
    });
    await expect(copySpectrumToClipboard("<svg/>", async () => new Blob(["png"], { type: "image/png" }))).resolves.toBe("none");
    expect(bridgeEmit).toHaveBeenCalledWith(ANALYSIS_WINDOW_ACTION_EVENT,
      expect.objectContaining({ kind: "copySpectrum", pngBase64: btoa("png"), svg: "<svg/>" }));
    expect(bridgeListeners.size).toBe(0);
  });

  it("times out unanswered image requests and ignores results for other requests", async () => {
    vi.useFakeTimers();
    (globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    window.history.replaceState(null, "", "/?window=pluginPanel");
    bridgeEmit.mockImplementation(async () => {
      bridgeListeners.get(ANALYSIS_WINDOW_ACTION_RESULT_EVENT)?.({ payload: { requestId: "other", ok: true } });
    });
    const result = requestCopySpectrumFromMain("cG5n", "<svg/>");
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(result).resolves.toBe(false);
    expect(bridgeListeners.size).toBe(0);
  });

  it("reports binary bridge transport failure and unsubscribes", async () => {
    (globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    window.history.replaceState(null, "", "/?window=pluginPanel");
    bridgeEmit.mockRejectedValue(new Error("document closed"));
    await expect(requestSaveBinaryFileFromMain("spectrum.png", "cG5n", {
      title: "PNG", formatLabel: "PNG", mimeType: "image/png", extensions: ["png"]
    })).resolves.toBe("failed");
    expect(bridgeListeners.size).toBe(0);
  });
});

const tinyPng = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

describe("spectrum picture exports", () => {
  it("declines rasterization without a DOM and refuses excessive raster dimensions", async () => {
    vi.stubGlobal("Image", undefined);
    vi.stubGlobal("DOMParser", undefined);
    await expect(svgToPngBlob("<svg/>")).resolves.toBeNull();
    vi.unstubAllGlobals();
    await expect(svgToPngBlob('<svg width="100000" height="100000"/>')).resolves.toBeNull();
    await expect(svgToPngBlob("<svg/>", Number.NaN)).resolves.toBeNull();
  });
  it.each([2, 3])("embeds %sx96 dpi and uses the SVG CSS dimensions for rasterization", async (scale) => {
    vi.stubGlobal("Blob", NodeBlob);
    vi.stubGlobal("Image", class {
      onload?: () => void;
      set src(_value: string) { this.onload?.(); }
    });
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:svg"), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ fillRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    let rasterSize: number[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (this: HTMLCanvasElement, callback) {
      rasterSize = [this.width, this.height];
      callback(new Blob([tinyPng], { type: "image/png" }));
    });
    const blob = await svgToPngBlob('<svg width="340" height="120" viewBox="0 0 680 240"/>', scale);
    expect(rasterSize).toEqual([340 * scale, 120 * scale]);
    expect(blob?.type).toBe("image/png");
    const bytes = new Uint8Array(await blob!.arrayBuffer());
    const tagOffset = new TextDecoder("latin1").decode(bytes).indexOf("pHYs");
    expect(tagOffset).toBeGreaterThan(0);
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(tagOffset + 4)).toBe(Math.round(scale * 96 / 0.0254));
    expect(view.getUint32(tagOffset + 8)).toBe(Math.round(scale * 96 / 0.0254));
    expect(bytes[tagOffset + 12]).toBe(1);
  });

  it.each(["png", "svg", "pdf"] as const)("exports %s with its own filename, title and writer", async (format) => {
    vi.stubGlobal("Blob", NodeBlob);
    const dependencies = {
      rasterize: vi.fn(async () => new Blob([tinyPng], { type: "image/png" })),
      pdf: vi.fn(async () => new TextEncoder().encode("%PDF-1.4")),
      saveText: vi.fn().mockResolvedValue("saved"), saveBinary: vi.fn().mockResolvedValue("cancelled")
    };
    await expect(exportSpectrumFigure(format, "<svg/>", "13C", dependencies)).resolves.toBe(format === "svg" ? "saved" : "cancelled");
    const options = expect.objectContaining({ title: `Export spectrum as ${format.toUpperCase()}`, extensions: [format] });
    if (format === "svg") {
      expect(dependencies.saveText).toHaveBeenCalledWith("predicted-13C-nmr.svg", "<svg/>", options);
      expect(dependencies.saveBinary).not.toHaveBeenCalled();
    } else {
      expect(dependencies.saveBinary.mock.calls[0][0]).toBe(`predicted-13C-nmr.${format}`);
      expect(Array.from(dependencies.saveBinary.mock.calls[0][1] as Uint8Array)).toEqual(
        Array.from(format === "pdf" ? new TextEncoder().encode("%PDF-1.4") : tinyPng)
      );
      expect(dependencies.saveBinary.mock.calls[0][2]).toEqual(options);
      expect(dependencies.saveText).not.toHaveBeenCalled();
    }
    expect(dependencies.pdf).toHaveBeenCalledTimes(format === "pdf" ? 1 : 0);
    expect(dependencies.rasterize).toHaveBeenCalledTimes(format === "png" ? 1 : 0);
  });

  it("reports conversion failures without claiming a save", async () => {
    const dependencies = { rasterize: vi.fn(async () => null), pdf: vi.fn(async () => { throw new Error("failed"); }), saveText: vi.fn(), saveBinary: vi.fn() };
    await expect(exportSpectrumFigure("png", "<svg/>", "13C", dependencies)).resolves.toBe("failed");
    await expect(exportSpectrumFigure("pdf", "<svg/>", "13C", dependencies)).resolves.toBe("failed");
    expect(dependencies.saveBinary).not.toHaveBeenCalled();
  });

  it("passes the SVG dimensions to the shared PDF converter", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    convertSvg.mockResolvedValue({ bytes });
    const svg = '<svg width="340" height="120" viewBox="0 0 680 240"/>';
    await expect(spectrumToPdf(svg)).resolves.toBe(bytes);
    expect(convertSvg).toHaveBeenCalledWith(svg, { outputWidth: 340, outputHeight: 120 });
  });

  it("downloads SVG and binary files on the web with the requested MIME types", async () => {
    const createObjectURL = vi.fn(() => "blob:download");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download); });
    await expect(exportSpectrumFigure("svg", "<svg/>", "13C")).resolves.toBe("saved");
    await expect(saveBinaryFile("spectrum.png", tinyPng, { title: "PNG", formatLabel: "PNG", extensions: ["png"], mimeType: "image/png" })).resolves.toBe("saved");
    expect(downloads).toEqual(["predicted-13C-nmr.svg", "spectrum.png"]);
    expect(createObjectURL.mock.calls.map(([blob]) => blob.type)).toEqual(["image/svg+xml", "image/png"]);
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("saves desktop binaries with the native dialog and reports cancellation and disk failure", async () => {
    (globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const options = { title: "Export spectrum as PNG", formatLabel: "PNG", extensions: ["png"], mimeType: "image/png" };
    nativeSave.mockResolvedValue("/tmp/spectrum.png");
    nativeWriteFile.mockResolvedValue(undefined);
    await expect(saveBinaryFile("spectrum.png", tinyPng, options)).resolves.toBe("saved");
    expect(nativeWriteFile).toHaveBeenCalledWith("/tmp/spectrum.png", tinyPng);
    expect(nativeSave).toHaveBeenCalledWith(expect.objectContaining({ title: options.title, defaultPath: "spectrum.png" }));
    nativeWriteFile.mockRejectedValue(new Error("disk full"));
    await expect(saveBinaryFile("spectrum.png", tinyPng, options)).resolves.toBe("failed");
    nativeSave.mockResolvedValue(null);
    await expect(saveBinaryFile("spectrum.png", tinyPng, options)).resolves.toBe("cancelled");
  });

  it("forwards desktop panel binaries without opening a panel dialog", async () => {
    (globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    window.history.replaceState(null, "", "/?window=pluginPanel");
    bridgeEmit.mockImplementation(async (_name: string, action: { requestId: string }) => {
      bridgeListeners.get(ANALYSIS_WINDOW_ACTION_RESULT_EVENT)?.({ payload: { requestId: action.requestId, result: "saved" } });
    });
    await expect(saveBinaryFile("spectrum.pdf", new TextEncoder().encode("%PDF-1.4"), {
      title: "Export spectrum as PDF", formatLabel: "PDF", extensions: ["pdf"], mimeType: "application/pdf"
    })).resolves.toBe("saved");
    expect(bridgeEmit).toHaveBeenCalledWith(ANALYSIS_WINDOW_ACTION_EVENT,
      expect.objectContaining({ kind: "saveBinaryFile", filename: "spectrum.pdf", bytesBase64: btoa("%PDF-1.4") }));
    expect(nativeSave).not.toHaveBeenCalled();
    expect(bridgeListeners.size).toBe(0);
  });
});

describe("saveTextFile", () => {
  it("reports a native write failure without falling through to a Tauri-inert browser download", async () => {
    (globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    nativeSave.mockResolvedValue("/tmp/predicted.jdx");
    nativeWriteTextFile.mockRejectedValue(new Error("disk full"));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click");

    await expect(
      saveTextFile("predicted.jdx", "data", {
        title: "Export",
        formatLabel: "JCAMP-DX",
        extensions: ["jdx"],
        mimeType: "chemical/x-jcamp-dx"
      })
    ).resolves.toBe("failed");
    expect(click).not.toHaveBeenCalled();
  });

  it("hands a report window's save to the main window instead of opening a dialog it cannot use", async () => {
    (globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    window.history.replaceState(null, "", "/?window=pluginPanel&panelId=v1x61x62");
    bridgeEmit.mockImplementation(async (_name: string, action: { requestId: string }) => {
      bridgeListeners.get(ANALYSIS_WINDOW_ACTION_RESULT_EVENT)?.({
        payload: { requestId: action.requestId, result: "cancelled" }
      });
    });

    await expect(
      saveTextFile("predicted.jdx", "data", {
        title: "Export",
        formatLabel: "JCAMP-DX",
        extensions: ["jdx"],
        mimeType: "chemical/x-jcamp-dx"
      })
    ).resolves.toBe("cancelled");
    expect(nativeSave).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("plugin_panel_event_forward", {
      event: ANALYSIS_WINDOW_ACTION_EVENT,
      payload: expect.objectContaining({ kind: "saveTextFile", filename: "predicted.jdx", text: "data" })
    });
    expect(bridgeEmit).toHaveBeenCalledWith(
      ANALYSIS_WINDOW_ACTION_EVENT,
      expect.objectContaining({ kind: "saveTextFile", filename: "predicted.jdx", text: "data" })
    );
    // The listener is gone once answered.
    expect(bridgeListeners.has(ANALYSIS_WINDOW_ACTION_RESULT_EVENT)).toBe(false);
  });

  it("reports failed when the request cannot reach the main window", async () => {
    (globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    window.history.replaceState(null, "", "/?window=pluginPanel&panelId=v1x61x62");
    bridgeEmit.mockRejectedValue(new Error("event bridge unavailable"));
    await expect(
      saveTextFile("predicted.jdx", "data", {
        title: "Export",
        formatLabel: "JCAMP-DX",
        extensions: ["jdx"],
        mimeType: "chemical/x-jcamp-dx"
      })
    ).resolves.toBe("failed");
    expect(bridgeListeners.has(ANALYSIS_WINDOW_ACTION_RESULT_EVENT)).toBe(false);
  });
});
