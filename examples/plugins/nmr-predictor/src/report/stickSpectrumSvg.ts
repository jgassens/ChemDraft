import type { NmrNucleus, NmrPredictionResult } from "../domain/contracts";

export interface StickSpectrumOptions {
  width?: number;
  height?: number;
}

/**
 * Render predicted resonances as a stick spectrum SVG *string*. It is fully self-contained (own white
 * plot background, explicit colors, no CSS variables or script) because the desktop renders panel SVGs
 * through an `<img>` data URL — an isolated context that neither inherits page theme nor executes
 * script. The ppm axis is reversed (high → low, left → right) per NMR convention; stick height scales
 * with the predicted equivalent-nuclei count. Synthetic fixture data, labeled as such.
 */
export function renderStickSpectrumSvg(result: NmrPredictionResult, options: StickSpectrumOptions = {}): string {
  const width = options.width ?? 640;
  const height = options.height ?? 220;
  const margin = { top: 18, right: 22, bottom: 34, left: 22 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const baseY = margin.top + plotHeight;

  const resonances = result.resonances;
  const nucleus: NmrNucleus = resonances[0]?.nucleus ?? "13C";
  const { min, max } = domain(nucleus, resonances.map((resonance) => resonance.deltaPpm));
  const span = max - min || 1;
  const x = (ppm: number): number => margin.left + ((max - ppm) / span) * plotWidth;

  const maxEquivalent = Math.max(1, ...resonances.map((resonance) => resonance.equivalentNuclei ?? 1));

  const sticks = resonances
    .map((resonance) => {
      const px = round(x(resonance.deltaPpm));
      const stickHeight = 18 + ((resonance.equivalentNuclei ?? 1) / maxEquivalent) * (plotHeight - 28);
      const topY = round(baseY - stickHeight);
      return (
        `<line x1="${px}" y1="${baseY}" x2="${px}" y2="${topY}" stroke="#2563eb" stroke-width="2" />` +
        `<text x="${px}" y="${round(topY - 4)}" font-size="10" text-anchor="middle" fill="#1e3a8a">${resonance.deltaPpm.toFixed(1)}</text>`
      );
    })
    .join("");

  const ticks = axisTicks(min, max)
    .map((tick) => {
      const px = round(x(tick));
      return (
        `<line x1="${px}" y1="${baseY}" x2="${px}" y2="${baseY + 4}" stroke="#334155" stroke-width="1" />` +
        `<text x="${px}" y="${baseY + 16}" font-size="10" text-anchor="middle" fill="#334155">${tick}</text>`
      );
    })
    .join("");

  const axisLabel = `${nucleus === "13C" ? "¹³C" : "¹H"} δ (ppm) — synthetic fixture`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" ` +
    `role="img" aria-label="Predicted ${nucleus === "13C" ? "carbon-13" : "proton"} stick spectrum">` +
    `<rect x="0" y="0" width="${width}" height="${height}" rx="8" fill="#ffffff" />` +
    `<line x1="${margin.left}" y1="${baseY}" x2="${margin.left + plotWidth}" y2="${baseY}" stroke="#334155" stroke-width="1.5" />` +
    ticks +
    sticks +
    `<text x="${round(width / 2)}" y="${height - 6}" font-size="11" text-anchor="middle" fill="#0f172a">${axisLabel}</text>` +
    `</svg>`
  );
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function domain(nucleus: NmrNucleus, shifts: readonly number[]): { min: number; max: number } {
  const defaults = nucleus === "13C" ? { min: 0, max: 220 } : { min: 0, max: 12 };
  if (shifts.length === 0) {
    return defaults;
  }
  return {
    min: Math.min(defaults.min, Math.floor(Math.min(...shifts) - 5)),
    max: Math.max(defaults.max, Math.ceil(Math.max(...shifts) + 5))
  };
}

function axisTicks(min: number, max: number): number[] {
  const step = niceStep((max - min) / 6);
  const ticks: number[] = [];
  for (let tick = Math.ceil(min / step) * step; tick <= max + 1e-9; tick += step) {
    ticks.push(Math.round(tick));
  }
  return ticks;
}

function niceStep(rough: number): number {
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(rough, 1))));
  return ([1, 2, 2.5, 5, 10].map((multiple) => multiple * magnitude).find((candidate) => candidate >= rough) ??
    10 * magnitude);
}
