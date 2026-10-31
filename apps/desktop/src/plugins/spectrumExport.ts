import type { PluginLinkedFigurePeak, PluginLinkedFigureSpectrum } from "@chemdraft/plugin-api";

import { pngWithPhysicalDensity, writeClipboardItems } from "../clipboard";
import type { ClipboardWriteItem, ClipboardWriteResult } from "../clipboard";
import { isDesktopRuntime } from "../window-manager";
import { sanitizeSpectrumSvg, STANDALONE_SPECTRUM_STYLE } from "./spectrumSvgSanitizer";
import {
  isPluginPanelWindowRoute,
  requestCopySpectrumFromMain,
  requestSaveBinaryFileFromMain,
  requestSaveTextFileFromMain,
  respondToCopyMolecularInspector,
  respondToSaveTextFile
} from "./panelBridge";

/**
 * Portable figure and peak-table exports, kept separate from the React controls.
 */

function jcampAscii(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[\r\n]+/g, " ").replace(/[^\x20-\x7e]/g, "?");
}

/** Nucleus → JCAMP `.OBSERVE NUCLEUS` token (e.g. "1H" → "^1H"). */
function jcampNucleus(nucleus: string): string {
  const match = /^(\d+)([A-Za-z]+)$/.exec(nucleus);
  return match ? `^${match[1]}${match[2]}` : `^${nucleus}`;
}

export type SpectrumComparisonMode = "primary" | "both";

export interface SpectrumComparisonLabels {
  primaryLabel: string;
  alternativeLabel: string;
  alternativeMarker?: string;
}

/** Provider-neutral display labels. NMR supplies HOSE/increment; other linked figures may name a
 * different pair without teaching the desktop about either method. */
export function spectrumComparisonLabels(spectrum: PluginLinkedFigureSpectrum): SpectrumComparisonLabels {
  return spectrum.comparison ?? { primaryLabel: "primary", alternativeLabel: "alternative" };
}

export interface DisplaySpectrumPeak {
  key: string;
  sourceId: string;
  ppm: number;
  intensity: number;
  label: string;
  atomIndices: readonly number[];
  couplings?: PluginLinkedFigurePeak["couplings"];
  confidence?: PluginLinkedFigurePeak["confidence"];
  estimated?: boolean;
  variant: "primary" | "alternative";
}

/** Resolve alternatives exactly as the linked figure does, so screen and export cannot silently
 * disagree. "primary" keeps the provider's primary value; "both" adds its alternative. */
export function spectrumPeaksForMode(
  peaks: readonly PluginLinkedFigurePeak[],
  mode: SpectrumComparisonMode
): DisplaySpectrumPeak[] {
  const out: DisplaySpectrumPeak[] = [];
  for (const peak of peaks) {
    const shared = {
      sourceId: peak.id,
      intensity: peak.intensity,
      atomIndices: peak.atomIndices,
      couplings: peak.couplings,
      confidence: peak.confidence,
      estimated: peak.estimated
    };
    if (peak.alternativePpm === undefined) {
      out.push({
        ...shared,
        key: peak.id,
        ppm: peak.ppm,
        label: peak.label ?? peak.ppm.toFixed(2),
        variant: "primary"
      });
      continue;
    }
    if (mode === "primary") {
      out.push({
        ...shared,
        key: peak.id,
        ppm: peak.ppm,
        label: peak.label ?? peak.ppm.toFixed(2),
        variant: "primary"
      });
    } else {
      out.push({
        ...shared,
        key: peak.id,
        ppm: peak.ppm,
        label: peak.label ?? peak.ppm.toFixed(2),
        variant: "primary"
      });
      out.push({
        ...shared,
        key: `${peak.id}~alternative`,
        ppm: peak.alternativePpm,
        label: peak.alternativePpm.toFixed(2),
        variant: "alternative"
      });
    }
  }
  return out;
}

// NMR instruments are conventionally named by their proton frequency. A nucleus is observed at a
// different frequency in the same magnetic field; the ratio below is γ(13C)/γ(1H).
const OBSERVE_FREQUENCY_RATIO: Readonly<Record<string, number>> = {
  "1H": 1,
  "13C": 0.25144953
};

/** Convert a proton-rated instrument frequency into the actual frequency of the observed nucleus. */
export function observeFrequencyMHz(nucleus: string, protonFrequencyMHz: number): number {
  return protonFrequencyMHz * (OBSERVE_FREQUENCY_RATIO[nucleus] ?? 1);
}

function formatFrequencyMHz(value: number): string {
  return value.toFixed(6).replace(/\.?(?:0+)$/, "");
}

/**
 * Serialize a predicted spectrum to a JCAMP-DX 5.01 **peak table** (one entry per resonance:
 * `ppm, relative-intensity`, ppm-descending). This is the interchange format NMR packages import; a
 * peak table is the honest representation of predicted shifts (the software renders/simulates it).
 */
export function spectrumToJcampDx(
  spectrum: PluginLinkedFigureSpectrum,
  options: {
    title?: string;
    /** Proton-rated instrument field (for example, a "300 MHz" spectrometer). */
    protonFrequencyMHz?: number;
    /** Backward-compatible alias; interpreted as the proton-rated field. */
    freqMHz?: number;
    comparisonMode?: SpectrumComparisonMode;
  } = {}
): string {
  const protonFrequencyMHz = options.protonFrequencyMHz ?? options.freqMHz ?? 400;
  const observeMHz = observeFrequencyMHz(spectrum.nucleus, protonFrequencyMHz);
  const requestedComparisonMode = options.comparisonMode ?? "primary";
  const comparisonMode: SpectrumComparisonMode =
    requestedComparisonMode === "both" && spectrum.peaks.some((peak) => peak.alternativePpm !== undefined)
      ? "both"
      : "primary";
  const comparison = spectrum.comparison;
  const peaks = spectrumPeaksForMode(spectrum.peaks, comparisonMode).sort((a, b) => b.ppm - a.ppm);
  const lines = [
    `##TITLE=${options.title ?? "Predicted NMR spectrum"}`,
    "##JCAMP-DX=5.01",
    "##DATA TYPE=NMR PEAK TABLE",
    "##DATA CLASS=PEAK TABLE",
    "##ORIGIN=ChemDraft NMR predictor",
    // JCAMP-DX 5.01 OWNER names the legal data owner, not the generating software. The report
    // supplies no ownership; UNKNOWN avoids inventing a holder or asserting PUBLIC DOMAIN.
    "##OWNER=UNKNOWN",
    `##.OBSERVE FREQUENCY=${formatFrequencyMHz(observeMHz)}`,
    `##.OBSERVE NUCLEUS=${jcampNucleus(spectrum.nucleus)}`,
    `##$CHEMDRAFT PROTON FREQUENCY=${formatFrequencyMHz(protonFrequencyMHz)}`,
    `##$CHEMDRAFT COMPARISON MODE=${comparisonMode === "primary" ? comparison?.primaryLabel.toUpperCase() ?? "PRIMARY" : "BOTH"}`,
    ...(comparison ? [
      `##$CHEMDRAFT PRIMARY METHOD=${comparison.primaryLabel}`,
      `##$CHEMDRAFT ALTERNATIVE METHOD=${comparison.alternativeLabel}`
    ] : []),
    "##$CHEMDRAFT INTENSITY SEMANTICS=Predicted equivalent-nuclei count; not experimental integration",
    "##XUNITS=PPM",
    "##YUNITS=ARBITRARY UNITS",
    `##NPOINTS=${peaks.length}`,
    "##PEAK TABLE=(XY..XY)",
    ...peaks.map((peak) => `${peak.ppm.toFixed(4)}, ${Math.max(0, peak.intensity).toFixed(3)}`),
    "##END="
  ];
  return `${lines.map(jcampAscii).join("\n")}\n`;
}

function spectrumNote(
  alternativeLabel: string,
  hasVisibleAlternative: boolean,
  primaryLabel: string | undefined,
  hasEstimated: boolean
): string {
  return `Height = predicted equivalent nuclei (not experimental integration)${
    hasEstimated ? " · grey dashed = rule-estimated" : ""
  }${
    hasVisibleAlternative ? ` · dashed orange = ${alternativeLabel}` : ""
  }${
    primaryLabel
      ? hasVisibleAlternative
        ? ` · methods = ${primaryLabel} + ${alternativeLabel}`
        : ` · method = ${primaryLabel} only`
      : ""
  }`;
}

/**
 * Turn the live spectrum `<svg>` into a standalone, paste-ready SVG document string: clone it, inject
 * an inline `<style>` with fixed colors (the app's CSS variables don't travel), and add the XML/xmlns
 * header. The result opens in a browser or vector editor unchanged.
 */
export function standaloneSpectrumSvg(
  svg: SVGSVGElement,
  alternativeLabel = "alternative",
  primaryLabel?: string
): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttributeNS("http://www.w3.org/2000/xmlns/", "xmlns", "http://www.w3.org/2000/svg");
  clone.removeAttribute("role");
  const viewBox = clone.getAttribute("viewBox")?.split(/\s+/) ?? ["0", "0", "680", "240"];
  clone.setAttribute("width", viewBox[2] ?? "680");
  clone.setAttribute("height", viewBox[3] ?? "240");
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("width", "100%");
  rect.setAttribute("height", "100%");
  rect.setAttribute("fill", "#ffffff");
  const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = STANDALONE_SPECTRUM_STYLE;
  const hasVisibleAlternative = clone.querySelector(".lf-curve.is-alternative") !== null;
  const hasEstimated = clone.querySelector(".lf-curve.is-estimated") !== null;
  if (primaryLabel) {
    clone.setAttribute("data-comparison-mode", hasVisibleAlternative ? "both" : "primary");
    clone.setAttribute("data-primary-method", primaryLabel);
    clone.setAttribute("data-alternative-method", alternativeLabel);
  }
  let note = clone.querySelector<SVGTextElement>(".lf-spectrum-note");
  if (!note) {
    note = document.createElementNS("http://www.w3.org/2000/svg", "text");
    note.setAttribute("class", "lf-spectrum-note");
    note.setAttribute("x", "18");
    note.setAttribute("y", "11");
    clone.appendChild(note);
  }
  note.textContent = spectrumNote(alternativeLabel, hasVisibleAlternative, primaryLabel, hasEstimated);
  clone.insertBefore(rect, clone.firstChild);
  clone.insertBefore(style, clone.firstChild);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
}

/** Rasterize a self-contained SVG string to a PNG blob via an offscreen canvas (works in the webview
 *  and the browser). Returns null where canvas/Image is unavailable (e.g. jsdom). */
export async function svgToPngBlob(
  svgMarkup: string,
  scale = 3,
  width?: number,
  height?: number
): Promise<Blob | null> {
  if (typeof document === "undefined" || typeof Image === "undefined") {
    return null;
  }
  try {
    svgMarkup = sanitizeSpectrumSvg(svgMarkup);
  } catch {
    return null;
  }
  const size = spectrumSvgSize(svgMarkup);
  width ??= size.width;
  height ??= size.height;
  if (![scale, width, height].every((value) => Number.isFinite(value) && value > 0)) return null;
  if (Math.max(width * scale, height * scale) > 16384 || width * height * scale * scale > 64 * 1024 * 1024) return null;
  const svgBlob = new Blob([svgMarkup], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("SVG image failed to load"));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const png = pngWithPhysicalDensity(bytes, scale * 96);
    return isPng(png) ? new Blob([new Uint8Array(png)], { type: "image/png" }) : null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Copy images only. Keep browser write() in the click call stack for WebKit user activation. */
export function copySpectrumToClipboard(
  svgMarkup: string,
  rasterize: (markup: string) => Promise<Blob | null> = svgToPngBlob
): Promise<"image" | "none"> {
  try {
    svgMarkup = sanitizeSpectrumSvg(svgMarkup);
  } catch {
    return Promise.resolve("none");
  }
  if (isDesktopRuntime()) {
    return (async () => {
      try {
        const png = await rasterize(svgMarkup);
        if (!png) return "none";
        const bytes = new Uint8Array(await png.arrayBuffer());
        if (!isPng(bytes)) return "none";
        if (isPluginPanelWindowRoute()) {
          return await requestCopySpectrumFromMain(bytesToBase64(bytes), svgMarkup) ? "image" : "none";
        }
        const result = await writeClipboardItems(spectrumClipboardItems(bytes, svgMarkup));
        return result.ok ? "image" : "none";
      } catch {
        return "none";
      }
    })();
  }
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard && typeof clipboard.write === "function" && typeof ClipboardItem !== "undefined") {
    try {
      // WebKit requires clipboard.write() to run in the original click call stack. Supply the
      // asynchronous rasterization as a ClipboardItem promise rather than awaiting it first.
      const png = rasterize(svgMarkup).then(async (blob) => {
        if (!blob) throw new Error("PNG rasterization is unavailable");
        if (!isPng(new Uint8Array(await blob.arrayBuffer()))) throw new Error("Invalid spectrum PNG.");
        return blob;
      });
      // Some browsers reject write() before consuming the item promises.
      void png.catch(() => undefined);
      const contents: Record<string, Blob | Promise<Blob>> = { "image/png": png };
      if (typeof ClipboardItem.supports === "function" && ClipboardItem.supports("image/svg+xml")) {
        contents["image/svg+xml"] = new Blob([svgMarkup], { type: "image/svg+xml" });
      }
      const item = new ClipboardItem(contents);
      return clipboard.write([item]).then(
        () => "image" as const,
        () => "none" as const
      );
    } catch {
      return Promise.resolve("none");
    }
  }
  return Promise.resolve("none");
}

function spectrumClipboardItems(png: Uint8Array, svg?: string): ClipboardWriteItem[] {
  return [
    { type: "image/png", bytes: png, required: true },
    ...(svg === undefined ? [] : [
      { type: "public.svg-image", text: svg, required: false },
      { type: "image/svg+xml", text: svg, required: false }
    ])
  ];
}

/** Trigger a client-side (browser) download of `text` as `filename`. */
export function downloadTextFile(filename: string, text: string, mimeType: string): void {
  if (mimeType === "image/svg+xml") text = sanitizeSpectrumSvg(text);
  downloadBlob(filename, new Blob([text], { type: mimeType }));
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * Save `text` to a file the user chooses. Under Tauri a blob `<a download>` is a no-op (the webview
 * ignores it), so on the desktop we use the native save dialog + `writeTextFile`; on the web we fall
 * back to the blob download. Returns an explicit saved/cancelled/failed result for honest UI status.
 */
export type SaveTextFileResult = "saved" | "cancelled" | "failed";

export interface SaveTextFileOptions {
  title: string;
  formatLabel: string;
  extensions: readonly string[];
  mimeType: string;
}

export type SpectrumSaveFormat = "jcamp" | "svg" | "png" | "pdf";

const spectrumSaveFormats: Record<SpectrumSaveFormat, SaveTextFileOptions> = {
  jcamp: { title: "Export spectrum (JCAMP-DX)", formatLabel: "JCAMP-DX", extensions: ["jdx", "dx"], mimeType: "chemical/x-jcamp-dx" },
  svg: { title: "Export spectrum as SVG", formatLabel: "SVG", extensions: ["svg"], mimeType: "image/svg+xml" },
  png: { title: "Export spectrum as PNG", formatLabel: "PNG", extensions: ["png"], mimeType: "image/png" },
  pdf: { title: "Export spectrum as PDF", formatLabel: "PDF", extensions: ["pdf"], mimeType: "application/pdf" }
};

function saveFormat(options: SaveTextFileOptions): SpectrumSaveFormat | undefined {
  return (Object.keys(spectrumSaveFormats) as SpectrumSaveFormat[]).find((key) => spectrumSaveFormats[key].mimeType === options.mimeType);
}

function spectrumSaveTarget(filename: unknown, format: unknown) {
  if (typeof filename !== "string" || filename.length > 200) return;
  filename = filename.normalize("NFC").replace(/\p{Default_Ignorable_Code_Point}/gu, "");
  if (typeof format !== "string" || !Object.hasOwn(spectrumSaveFormats, format) ||
      typeof filename !== "string" || !filename.length || filename.length > 200 ||
      /[\\/\x00-\x1f\x7f<>:"|?*]/.test(filename) || /[. ]$/.test(filename) ||
      /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(filename)) return;
  const key = format as SpectrumSaveFormat;
  const options = spectrumSaveFormats[key];
  const stem = filename.replace(/\.[^.]*$/, "");
  if (!stem || stem === "." || stem === "..") return;
  return { filename: `${stem}.${options.extensions[0]}`, format: key, options };
}

export async function saveTextFile(
  filename: string,
  text: string,
  options: SaveTextFileOptions
): Promise<SaveTextFileResult> {
  const target = spectrumSaveTarget(filename, saveFormat(options));
  if (!target || (target.format !== "jcamp" && target.format !== "svg") ||
      boundedUtf8Size(text, MAX_SPECTRUM_TRANSFER_BYTES) === undefined) return "failed";
  try {
    if (target.format === "svg") text = sanitizeSpectrumSvg(text);
  } catch {
    return "failed";
  }
  // A detached report window has no dialog or filesystem permission, by design. The main window
  // shows the save dialog and writes the file for it (`saveTextFile` analysis-window action).
  if (isDesktopRuntime() && isPluginPanelWindowRoute()) {
    return requestSaveTextFileFromMain(target.filename, text, target.format);
  }
  return saveTextFileHere(target.filename, text, target.options);
}

/** Save from THIS window with its own permissions. The main window uses it to serve report windows. */
export async function saveTextFileHere(
  filename: string,
  text: string,
  options: SaveTextFileOptions
): Promise<SaveTextFileResult> {
  const target = spectrumSaveTarget(filename, saveFormat(options));
  if (!target || (target.format !== "jcamp" && target.format !== "svg") ||
      boundedUtf8Size(text, MAX_SPECTRUM_TRANSFER_BYTES) === undefined) return "failed";
  try {
    if (target.format === "svg") text = sanitizeSpectrumSvg(text);
  } catch {
    return "failed";
  }
  filename = target.filename;
  options = target.options;
  if (isDesktopRuntime()) {
    try {
      const { save } = await import("../nativeFileDialog");
      const path = await save({
        title: options.title,
        defaultPath: filename,
        filters: [{ name: options.formatLabel, extensions: [...options.extensions] }]
      });
      if (!path) {
        return "cancelled";
      }
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(path, text);
      return "saved";
    } catch {
      // A browser download is a no-op in Tauri. Report the native failure to the caller instead of
      // pretending the file was saved through an ineffective fallback.
      return "failed";
    }
  }
  downloadTextFile(filename, text, options.mimeType);
  return "saved";
}

export const MAX_SPECTRUM_TRANSFER_BYTES = 20 * 1024 * 1024;

/** Match UTF-8 replacement of unpaired surrogates without allocating an encoded copy. */
function boundedUtf8Size(value: unknown, limit: number): number | undefined {
  if (typeof value !== "string" || value.length > limit) return;
  let size = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) size += 1;
    else if (code < 0x800) size += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length &&
        value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      size += 4;
      index += 1;
    } else size += 3;
    if (size > limit) return;
  }
  return size;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (bytes.length > MAX_SPECTRUM_TRANSFER_BYTES) throw new Error("Spectrum file exceeds 20 MB.");
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}

function boundedBase64Size(value: unknown): number | undefined {
  // Bound the encoded string before regex matching, atob, or allocating the decoded buffer.
  if (typeof value !== "string" || !value.length || value.length > Math.ceil(MAX_SPECTRUM_TRANSFER_BYTES / 3) * 4) return;
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return;
  const size = value.length / 4 * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
  return size <= MAX_SPECTRUM_TRANSFER_BYTES ? size : undefined;
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 45 || bytes.length > MAX_SPECTRUM_TRANSFER_BYTES ||
      ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const seen = new Set<string>();
  let hasData = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return false;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!["IHDR", "IDAT", "IEND", "pHYs", "sRGB", "eXIf", "gAMA", "cHRM", "iCCP"].includes(type) ||
        (offset === 8 && type !== "IHDR") || (type !== "IDAT" && seen.has(type))) return false;
    let crc = 0xffffffff;
    for (let index = offset + 4; index < end - 4; index += 1) {
      crc ^= bytes[index];
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    if (((crc ^ 0xffffffff) >>> 0) !== view.getUint32(end - 4)) return false;
    if (type === "IHDR") {
      if (offset !== 8 || length !== 13) return false;
      const width = view.getUint32(offset + 8);
      const height = view.getUint32(offset + 12);
      if (!width || !height || Math.max(width, height) > 16384 || width * height > 64 * 1024 * 1024 ||
          bytes[offset + 16] !== 8 || ![2, 6].includes(bytes[offset + 17]) ||
          bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] !== 0) return false;
    } else if (type === "pHYs") {
      if (seen.has("IDAT") || length !== 9 || bytes[offset + 16] !== 1) return false;
      const x = view.getUint32(offset + 8);
      const y = view.getUint32(offset + 12);
      if (Math.min(x, y) < 1000 || Math.max(x, y) > 1000000) return false;
    } else if (type === "sRGB") {
      if (seen.has("IDAT") || length !== 1 || bytes[offset + 8] > 3) return false;
    } else if (type === "eXIf") {
      if (seen.has("IDAT") || !length || length > 65536) return false;
    } else if (type === "gAMA") {
      if (seen.has("IDAT") || length !== 4) return false;
    } else if (type === "cHRM") {
      if (seen.has("IDAT") || length !== 32) return false;
    } else if (type === "iCCP") {
      if (seen.has("IDAT") || length < 4 || length > 1024 * 1024) return false;
    } else if (type === "IDAT") {
      hasData ||= length > 0;
    } else if (type === "IEND") return length === 0 && hasData && end === bytes.length;
    seen.add(type);
    offset = end;
  }
  return false;
}

export interface SpectrumWindowActionDependencies {
  writeClipboard: (items: readonly ClipboardWriteItem[]) => Promise<ClipboardWriteResult>;
  saveBinary: typeof saveBinaryFileHere;
  saveText: typeof saveTextFileHere;
  pdf: typeof spectrumToPdf;
  respondCopy: (requestId: string, ok: boolean) => Promise<void>;
  respondSave: (requestId: string, result: SaveTextFileResult) => Promise<void>;
}

/** Document-window boundary. Never decode or perform a privileged operation before validation. */
export async function handleSpectrumWindowAction(
  payload: unknown,
  dependencies: SpectrumWindowActionDependencies = {
    writeClipboard: writeClipboardItems,
    saveBinary: saveBinaryFileHere,
    saveText: saveTextFileHere,
    pdf: spectrumToPdf,
    respondCopy: respondToCopyMolecularInspector,
    respondSave: respondToSaveTextFile
  }
): Promise<void> {
  if (typeof payload !== "object" || payload === null) return;
  const action = payload as Record<string, unknown>;
  if (typeof action.requestId !== "string" || !action.requestId.length || action.requestId.length > 200) return;
  const requestId = action.requestId;
  if (action.kind === "copySpectrum") {
    let ok = false;
    try {
      const pngSize = boundedBase64Size(action.pngBase64);
      const svg = action.svg;
      if (pngSize === undefined || (svg !== undefined &&
          (typeof svg !== "string" || !svg.length || svg.length > MAX_SPECTRUM_TRANSFER_BYTES))) {
        throw new Error("Invalid spectrum clipboard payload.");
      }
      const svgSize = svg === undefined ? 0 : boundedUtf8Size(svg, Math.floor((MAX_SPECTRUM_TRANSFER_BYTES - pngSize) / 2));
      if (svgSize === undefined) throw new Error("Spectrum clipboard exceeds 20 MB.");
      if (svg !== undefined) sanitizeSpectrumSvg(svg as string);
      const png = decodeBase64(action.pngBase64 as string);
      if (!isPng(png)) throw new Error("Invalid spectrum PNG.");
      const result = await dependencies.writeClipboard(spectrumClipboardItems(png, svg as string | undefined));
      ok = result.ok && result.written.includes("image/png");
    } catch {
      ok = false;
    }
    await dependencies.respondCopy(requestId, ok);
  } else if (action.kind === "saveBinaryFile" || action.kind === "saveTextFile") {
    let result: SaveTextFileResult = "failed";
    try {
      const target = spectrumSaveTarget(action.filename, action.format);
      if (!target) throw new Error("Invalid spectrum save target.");
      if (action.kind === "saveTextFile") {
        if ((target.format !== "jcamp" && target.format !== "svg" && target.format !== "pdf") ||
            boundedUtf8Size(action.text, MAX_SPECTRUM_TRANSFER_BYTES) === undefined) {
          throw new Error("Invalid spectrum text payload.");
        }
        const text = target.format === "jcamp" ? action.text as string : sanitizeSpectrumSvg(action.text as string);
        result = target.format === "pdf"
          ? await dependencies.saveBinary(target.filename, await dependencies.pdf(text), target.options)
          : await dependencies.saveText(target.filename, text, target.options);
      } else {
        if (target.format !== "png" || boundedBase64Size(action.bytesBase64) === undefined) {
          throw new Error("Invalid spectrum binary payload.");
        }
        const bytes = decodeBase64(action.bytesBase64 as string);
        if (!isPng(bytes)) {
          throw new Error("Spectrum file does not match its format.");
        }
        result = await dependencies.saveBinary(target.filename, bytes, target.options);
      }
    } catch {
      result = "failed";
    }
    await dependencies.respondSave(requestId, result);
  }
}

export async function saveBinaryFile(
  filename: string,
  bytes: Uint8Array,
  options: SaveTextFileOptions
): Promise<SaveTextFileResult> {
  try {
    const target = spectrumSaveTarget(filename, saveFormat(options));
    if (!target || (target.format !== "png" && target.format !== "pdf") || bytes.length > MAX_SPECTRUM_TRANSFER_BYTES) return "failed";
    if (target.format === "png" && !isPng(bytes)) return "failed";
    if (isDesktopRuntime() && isPluginPanelWindowRoute()) {
      if (target.format === "pdf") return "failed";
      return await requestSaveBinaryFileFromMain(target.filename, bytesToBase64(bytes), target.format);
    }
    return await saveBinaryFileHere(target.filename, bytes, target.options);
  } catch {
    return "failed";
  }
}

/** Only the document window calls this on desktop. Detached panels use the bounded action above. */
export async function saveBinaryFileHere(
  filename: string,
  bytes: Uint8Array,
  options: SaveTextFileOptions
): Promise<SaveTextFileResult> {
  const target = spectrumSaveTarget(filename, saveFormat(options));
  if (!target || (target.format !== "png" && target.format !== "pdf") || bytes.length > MAX_SPECTRUM_TRANSFER_BYTES) return "failed";
  if (isDesktopRuntime() && isPluginPanelWindowRoute()) return "failed";
  if (target.format === "png" && !isPng(bytes)) return "failed";
  filename = target.filename;
  options = target.options;
  if (isDesktopRuntime()) {
    try {
      const { save } = await import("../nativeFileDialog");
      const path = await save({
        title: options.title,
        defaultPath: filename,
        filters: [{ name: options.formatLabel, extensions: [...options.extensions] }]
      });
      if (!path) return "cancelled";
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      await writeFile(path, bytes);
      return "saved";
    } catch {
      return "failed";
    }
  }
  downloadBlob(filename, new Blob([new Uint8Array(bytes)], { type: options.mimeType }));
  return "saved";
}

function spectrumSvgSize(svgMarkup: string): { width: number; height: number } {
  const svg = new DOMParser().parseFromString(svgMarkup, "image/svg+xml").documentElement;
  const viewBox = svg.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  const dimension = (name: string, fallback: number) => {
    const value = svg.getAttribute(name);
    const parsed = value && /^\d+(?:\.\d+)?(?:px)?$/.test(value) ? Number.parseFloat(value) : fallback;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return { width: dimension("width", viewBox?.[2] ?? 680), height: dimension("height", viewBox?.[3] ?? 240) };
}

export type SpectrumFigureFormat = "png" | "svg" | "pdf";

export interface SpectrumFigureExportDependencies {
  rasterize: (markup: string) => Promise<Blob | null>;
  pdf: (markup: string) => Promise<Uint8Array>;
  saveText: typeof saveTextFile;
  saveBinary: typeof saveBinaryFile;
}

/** Requires export-engine's shared SVG entry point; keep jsPDF/svg2pdf out of startup. */
export async function spectrumToPdf(svgMarkup: string): Promise<Uint8Array> {
  svgMarkup = sanitizeSpectrumSvg(svgMarkup);
  const { exportSvgToPdf } = await import("@chemdraft/export-engine/pdf");
  const { width, height } = spectrumSvgSize(svgMarkup);
  return (await exportSvgToPdf(svgMarkup, { outputWidth: width, outputHeight: height })).bytes;
}

/** The controls pass the standalone SVG so every picture format contains the displayed figure. */
export async function exportSpectrumFigure(
  format: SpectrumFigureFormat,
  svgMarkup: string,
  nucleus: string,
  dependencies: SpectrumFigureExportDependencies = {
    rasterize: svgToPngBlob, pdf: spectrumToPdf, saveText: saveTextFile, saveBinary: saveBinaryFile
  }
): Promise<SaveTextFileResult> {
  const labels = { png: "PNG", svg: "SVG", pdf: "PDF" };
  const mimeTypes = { png: "image/png", svg: "image/svg+xml", pdf: "application/pdf" };
  const options: SaveTextFileOptions = {
    title: `Export spectrum as ${labels[format]}`,
    formatLabel: labels[format],
    extensions: [format],
    mimeType: mimeTypes[format]
  };
  const filename = `predicted-${nucleus.replace(/[^A-Za-z0-9-]/g, "") || "spectrum"}-nmr.${format}`;
  try {
    svgMarkup = sanitizeSpectrumSvg(svgMarkup);
    if (format === "svg") return await dependencies.saveText(filename, svgMarkup, options);
    if (format === "pdf") {
      if (isDesktopRuntime() && isPluginPanelWindowRoute()) {
        return await requestSaveTextFileFromMain(filename, svgMarkup, "pdf");
      }
      return await dependencies.saveBinary(filename, await dependencies.pdf(svgMarkup), options);
    }
    const png = await dependencies.rasterize(svgMarkup);
    if (!png) return "failed";
    return await dependencies.saveBinary(filename, new Uint8Array(await png.arrayBuffer()), options);
  } catch {
    return "failed";
  }
}
