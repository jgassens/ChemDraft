import type { PluginLinkedFigureSpectrum } from "@chemdraft/plugin-api";

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

/** Trigger a client-side download of `text` as `filename` (a user-initiated save, e.g. Export). */
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
