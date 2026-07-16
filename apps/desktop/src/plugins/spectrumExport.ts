import type { PluginLinkedFigurePeak, PluginLinkedFigureSpectrum } from "@chemdraft/plugin-api";

import { isDesktopRuntime } from "../window-manager";

/**
 * Export helpers for the linked figure: a portable (self-contained) SVG string for copy-paste, and a
 * JCAMP-DX peak table that NMR software (MestReNova, TopSpin, ACD, …) opens directly. Kept out of the
 * React component so the JCAMP serialization is pure and unit-testable.
 */

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
  const comparison = spectrumComparisonLabels(spectrum);
  const peaks = spectrumPeaksForMode(spectrum.peaks, comparisonMode).sort((a, b) => b.ppm - a.ppm);
  const lines = [
    `##TITLE=${options.title ?? "Predicted NMR spectrum"}`,
    "##JCAMP-DX=5.01",
    "##DATA TYPE=NMR PEAK TABLE",
    "##DATA CLASS=PEAK TABLE",
    "##ORIGIN=ChemDraft NMR predictor",
    "##OWNER=",
    `##.OBSERVE FREQUENCY=${formatFrequencyMHz(observeMHz)}`,
    `##.OBSERVE NUCLEUS=${jcampNucleus(spectrum.nucleus)}`,
    `##$CHEMDRAFT PROTON FREQUENCY=${formatFrequencyMHz(protonFrequencyMHz)}`,
    `##$CHEMDRAFT COMPARISON MODE=${comparisonMode === "primary" ? comparison.primaryLabel.toUpperCase() : "BOTH"}`,
    `##$CHEMDRAFT PRIMARY METHOD=${comparison.primaryLabel}`,
    `##$CHEMDRAFT ALTERNATIVE METHOD=${comparison.alternativeLabel}`,
    "##$CHEMDRAFT INTENSITY SEMANTICS=Predicted equivalent-nuclei count; not experimental integration",
    "##XUNITS=PPM",
    "##YUNITS=ARBITRARY UNITS",
    `##NPOINTS=${peaks.length}`,
    "##PEAK TABLE=(XY..XY)",
    ...peaks.map((peak) => `${peak.ppm.toFixed(4)}, ${Math.max(0, peak.intensity).toFixed(3)}`),
    "##END="
  ];
  return `${lines.join("\n")}\n`;
}

// Fixed colors so the copied SVG renders correctly on its own (the app's CSS variables aren't present
// outside the app). Mirrors the in-app spectrum styling closely enough for a paste-ready figure.
const STANDALONE_SPECTRUM_STYLE = [
  ".lf-axis,.lf-tick{stroke:#8a8f98;stroke-width:1;fill:none}",
  ".lf-tick-label,.lf-axis-caption{fill:#5b6068;font:11px system-ui,sans-serif}",
  ".lf-curve{fill:none;stroke:#2f7d6f;stroke-width:1.25;stroke-linejoin:round}",
  ".lf-curve.is-active{stroke:#1f5a4f}",
  ".lf-curve.is-estimated{stroke:#8a8f98;opacity:.45;stroke-dasharray:2 2}",
  ".lf-curve.is-alternative{stroke:#b5651d;opacity:.72;stroke-dasharray:5 3}",
  ".lf-peak-label{fill:#2f7d6f;font:12px system-ui,sans-serif;text-anchor:middle}",
  ".lf-peak-label.is-estimated{fill:#8a8f98;font-style:italic}",
  ".lf-peak-label.is-alternative{fill:#b5651d;font-style:italic}",
  ".lf-spectrum-note{fill:#5b6068;font:9.5px system-ui,sans-serif}",
  ".lf-hit{fill:transparent;stroke:none}"
].join("");

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
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
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
export async function svgToPngBlob(svgMarkup: string, scale = 3, width = 680, height = 240): Promise<Blob | null> {
  if (typeof document === "undefined" || typeof Image === "undefined") {
    return null;
  }
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
    return await new Promise<Blob | null>((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Copy the spectrum to the clipboard in the richest form the target can use: a real **PNG** (so it
 * pastes as an image into Word/Slack/docs) plus the **SVG source** as text (so vector editors / text
 * fields get the scalable original). Falls back to SVG-text-only where `ClipboardItem` is unavailable.
 * Returns which form was written.
 */
export function copySpectrumToClipboard(
  svgMarkup: string,
  rasterize: (markup: string) => Promise<Blob | null> = svgToPngBlob
): Promise<"image" | "svg" | "none"> {
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard && typeof clipboard.write === "function" && typeof ClipboardItem !== "undefined") {
    try {
      // WebKit requires clipboard.write() to run in the original click call stack. Supply the
      // asynchronous rasterization as a ClipboardItem promise rather than awaiting it first.
      const png = rasterize(svgMarkup).then((blob) => {
        if (!blob) throw new Error("PNG rasterization is unavailable");
        return blob;
      });
      const item = new ClipboardItem({
        "image/png": png,
        "text/plain": Promise.resolve(new Blob([svgMarkup], { type: "text/plain" }))
      });
      return clipboard.write([item]).then(
        () => "image" as const,
        () => "none" as const
      );
    } catch {
      // A synchronous capability failure still leaves us inside the user gesture, so text is safe.
    }
  }
  if (clipboard && typeof clipboard.writeText === "function") {
    try {
      return clipboard.writeText(svgMarkup).then(
        () => "svg" as const,
        () => "none" as const
      );
    } catch {
      return Promise.resolve("none");
    }
  }
  return Promise.resolve("none");
}

/** Trigger a client-side (browser) download of `text` as `filename`. */
export function downloadTextFile(filename: string, text: string, mimeType: string): void {
  const blob = new Blob([text], { type: mimeType });
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

export async function saveTextFile(
  filename: string,
  text: string,
  options: { title: string; formatLabel: string; extensions: readonly string[]; mimeType: string }
): Promise<SaveTextFileResult> {
  if (isDesktopRuntime()) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
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
