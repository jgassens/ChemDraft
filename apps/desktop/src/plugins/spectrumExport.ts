import type { PluginLinkedFigureSpectrum } from "@chemdraft/plugin-api";

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

/**
 * Serialize a predicted spectrum to a JCAMP-DX 5.01 **peak table** (one entry per resonance:
 * `ppm, relative-intensity`, ppm-descending). This is the interchange format NMR packages import; a
 * peak table is the honest representation of predicted shifts (the software renders/simulates it).
 */
export function spectrumToJcampDx(
  spectrum: PluginLinkedFigureSpectrum,
  options: { title?: string; freqMHz?: number } = {}
): string {
  const freqMHz = options.freqMHz ?? 400;
  const peaks = [...spectrum.peaks].sort((a, b) => b.ppm - a.ppm);
  const lines = [
    `##TITLE=${options.title ?? "Predicted NMR spectrum"}`,
    "##JCAMP-DX=5.01",
    "##DATA TYPE=NMR PEAK TABLE",
    "##DATA CLASS=PEAK TABLE",
    "##ORIGIN=ChemDraft NMR predictor",
    "##OWNER=",
    `##.OBSERVE FREQUENCY=${freqMHz}`,
    `##.OBSERVE NUCLEUS=${jcampNucleus(spectrum.nucleus)}`,
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
  ".lf-peak-label{fill:#2f7d6f;font:12px system-ui,sans-serif;text-anchor:middle}",
  ".lf-peak-label.is-estimated{fill:#8a8f98;font-style:italic}",
  ".lf-hit{fill:transparent;stroke:none}"
].join("");

/**
 * Turn the live spectrum `<svg>` into a standalone, paste-ready SVG document string: clone it, inject
 * an inline `<style>` with fixed colors (the app's CSS variables don't travel), and add the XML/xmlns
 * header. The result opens in a browser or vector editor unchanged.
 */
export function standaloneSpectrumSvg(svg: SVGSVGElement): string {
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
export async function copySpectrumToClipboard(svgMarkup: string): Promise<"image" | "svg" | "none"> {
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard && typeof clipboard.write === "function" && typeof ClipboardItem !== "undefined") {
    try {
      const png = await svgToPngBlob(svgMarkup);
      if (png) {
        await clipboard.write([
          new ClipboardItem({ "image/png": png, "text/plain": new Blob([svgMarkup], { type: "text/plain" }) })
        ]);
        return "image";
      }
    } catch {
      // Image clipboard unsupported/blocked — fall through to SVG text.
    }
  }
  if (clipboard && typeof clipboard.writeText === "function") {
    try {
      await clipboard.writeText(svgMarkup);
      return "svg";
    } catch {
      return "none";
    }
  }
  return "none";
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
 * back to the blob download. Returns false only if the desktop user cancels the dialog.
 */
export async function saveTextFile(
  filename: string,
  text: string,
  options: { title: string; formatLabel: string; extensions: readonly string[]; mimeType: string }
): Promise<boolean> {
  if (isDesktopRuntime()) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        title: options.title,
        defaultPath: filename,
        filters: [{ name: options.formatLabel, extensions: [...options.extensions] }]
      });
      if (!path) {
        return false; // user cancelled
      }
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(path, text);
      return true;
    } catch {
      // Native path unavailable (e.g. a Tauri preview without fs) — fall through to the browser download.
    }
  }
  downloadTextFile(filename, text, options.mimeType);
  return true;
}
