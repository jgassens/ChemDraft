import { useEffect, useMemo, useRef, useState } from "react";

import type {
  PluginLinkedFigurePeak,
  PluginLinkedFigureSpectrum,
  PluginLinkedFigureStructure
} from "@chemdraft/plugin-api";

/**
 * Core-owned interactive figure for the `linkedFigure` panel section (ADR-0015). The plugin ships
 * only data (peaks + chemistry-agnostic geometry); this component owns all rendering and interaction:
 * a zoom/pan spectrum and a 2D structure annotated with per-atom shifts, cross-highlighting on hover
 * (hover a peak → its atoms light up; hover an atom → its peak lights up). No plugin script runs.
 */
export interface LinkedFigureViewProps {
  spectrum: PluginLinkedFigureSpectrum;
  structure?: PluginLinkedFigureStructure;
}

const SPECTRUM_W = 680;
const SPECTRUM_H = 240;
const MARGIN = { top: 18, right: 18, bottom: 30, left: 18 };
const PLOT_W = SPECTRUM_W - MARGIN.left - MARGIN.right;
const PLOT_H = SPECTRUM_H - MARGIN.top - MARGIN.bottom;
const BASE_Y = MARGIN.top + PLOT_H;

const STRUCT_W = 340;
const STRUCT_H = 260;
const STRUCT_PAD = 34;

export function LinkedFigureView({ spectrum, structure }: LinkedFigureViewProps) {
  const reversed = spectrum.reversed ?? true;
  const domainSpan = Math.max(1e-6, spectrum.domain.max - spectrum.domain.min);

  const [view, setView] = useState({ min: spectrum.domain.min, max: spectrum.domain.max });
  const [viewDomain, setViewDomain] = useState({ min: spectrum.domain.min, max: spectrum.domain.max });
  const [hoverPeakId, setHoverPeakId] = useState<string | null>(null);
  const [hoverAtomIndex, setHoverAtomIndex] = useState<number | null>(null);
  const spectrumRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<number | null>(null);

  // Reset the viewport when a different structure is predicted (its ppm domain changes); a re-run of
  // the same structure keeps the current zoom. Done *during render* (not a post-paint effect): if we
  // waited for an effect, the new peaks would paint once through the previous structure's zoom window
  // first — a visible one-frame flash of the old layout before it snapped into place. Setting state
  // during render is React's supported way to adjust state from a changed prop; it re-renders before
  // committing to the screen, so nothing flickers.
  if (viewDomain.min !== spectrum.domain.min || viewDomain.max !== spectrum.domain.max) {
    setViewDomain({ min: spectrum.domain.min, max: spectrum.domain.max });
    setView({ min: spectrum.domain.min, max: spectrum.domain.max });
  }

  // Cross-highlight maps: which peaks reference each atom, and which shift labels an atom carries.
  const atomToPeakIds = useMemo(() => {
    const map = new Map<number, string[]>();
    for (const peak of spectrum.peaks) {
      for (const atom of peak.atomIndices) {
        const list = map.get(atom) ?? [];
        list.push(peak.id);
        map.set(atom, list);
      }
    }
    return map;
  }, [spectrum.peaks]);

  const atomShift = useMemo(() => {
    const map = new Map<number, string>();
    for (const peak of spectrum.peaks) {
      const label = peak.label ?? peak.ppm.toFixed(2);
      for (const atom of peak.atomIndices) {
        map.set(atom, label);
      }
    }
    return map;
  }, [spectrum.peaks]);

  const activePeakIds = useMemo(() => {
    const set = new Set<string>();
    if (hoverPeakId) set.add(hoverPeakId);
    if (hoverAtomIndex !== null) {
      for (const id of atomToPeakIds.get(hoverAtomIndex) ?? []) set.add(id);
    }
    return set;
  }, [hoverPeakId, hoverAtomIndex, atomToPeakIds]);

  const activeAtoms = useMemo(() => {
    const set = new Set<number>();
    if (hoverAtomIndex !== null) set.add(hoverAtomIndex);
    if (hoverPeakId) {
      const peak = spectrum.peaks.find((candidate) => candidate.id === hoverPeakId);
      for (const atom of peak?.atomIndices ?? []) set.add(atom);
    }
    return set;
  }, [hoverPeakId, hoverAtomIndex, spectrum.peaks]);

  const maxIntensity = Math.max(1, ...spectrum.peaks.map((peak) => peak.intensity));

  const xOf = (ppm: number): number => {
    const frac = (ppm - view.min) / (view.max - view.min || 1);
    return MARGIN.left + (reversed ? 1 - frac : frac) * PLOT_W;
  };

  // ---- zoom / pan (viewport is a ppm window; the SVG viewBox is fixed) ------------------------
  const zoomAround = (svgX: number, deltaY: number): void => {
    setView((prev) => {
      const span = prev.max - prev.min;
      const minSpan = Math.max(0.05, domainSpan / 800);
      const nextSpan = clamp(span * Math.exp(deltaY * 0.0015), minSpan, domainSpan);
      const t = clamp((svgX - MARGIN.left) / PLOT_W, 0, 1);
      const cursorPpm = prev.min + (reversed ? 1 - t : t) * span;
      const rel = (cursorPpm - prev.min) / (span || 1);
      let min = cursorPpm - rel * nextSpan;
      return clampWindow(min, min + nextSpan, spectrum.domain);
    });
  };

  const zoomByButton = (factor: number): void => zoomAround(MARGIN.left + PLOT_W / 2, factor > 1 ? 120 : -120);

  useEffect(() => {
    const svg = spectrumRef.current;
    if (!svg) return undefined;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      zoomAround(((event.clientX - rect.left) / rect.width) * SPECTRUM_W, event.deltaY);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reversed, domainSpan, spectrum.domain.min, spectrum.domain.max]);

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>): void => {
    dragRef.current = event.clientX;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (dragRef.current === null) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const dx = ((event.clientX - dragRef.current) / rect.width) * SPECTRUM_W;
    dragRef.current = event.clientX;
    setView((prev) => {
      const span = prev.max - prev.min;
      const shift = (span / PLOT_W) * dx * (reversed ? 1 : -1);
      return clampWindow(prev.min + shift, prev.max + shift, spectrum.domain);
    });
  };
  const endDrag = (): void => {
    dragRef.current = null;
  };

  const ticks = useMemo(() => axisTicks(view.min, view.max), [view.min, view.max]);
  const zoomed = view.max - view.min < domainSpan - 1e-6;

  const layout = useMemo(() => (structure ? layoutStructure(structure) : undefined), [structure]);

  return (
    <div className="lf-root">
      <div className="lf-toolbar">
        <span className="lf-axis-name">{formatNucleus(spectrum.nucleus)}</span>
        <div className="lf-toolbar-actions">
          <button type="button" className="lf-btn" aria-label="Zoom out" onClick={() => zoomByButton(0.5)}>
            −
          </button>
          <button type="button" className="lf-btn" aria-label="Zoom in" onClick={() => zoomByButton(2)}>
            +
          </button>
          <button
            type="button"
            className="lf-btn"
            disabled={!zoomed}
            onClick={() => setView({ min: spectrum.domain.min, max: spectrum.domain.max })}
          >
            Reset
          </button>
        </div>
      </div>

      <div className="lf-figures">
        <svg
          ref={spectrumRef}
          className="lf-spectrum"
          viewBox={`0 0 ${SPECTRUM_W} ${SPECTRUM_H}`}
          role="img"
          aria-label={`Predicted ${formatNucleus(spectrum.nucleus)} spectrum; scroll to zoom, drag to pan`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerLeave={endDrag}
        >
          <line className="lf-axis" x1={MARGIN.left} y1={BASE_Y} x2={MARGIN.left + PLOT_W} y2={BASE_Y} />
          {ticks.map((tick) => {
            const x = xOf(tick);
            if (x < MARGIN.left - 1 || x > MARGIN.left + PLOT_W + 1) return null;
            return (
              <g key={`t${tick}`}>
                <line className="lf-tick" x1={x} y1={BASE_Y} x2={x} y2={BASE_Y + 4} />
                <text className="lf-tick-label" x={x} y={BASE_Y + 16} textAnchor="middle">
                  {tick}
                </text>
              </g>
            );
          })}
          {spectrum.peaks.map((peak) => {
            const centerX = xOf(peak.ppm);
            if (centerX < MARGIN.left - 1 || centerX > MARGIN.left + PLOT_W + 1) return null;
            const fullHeight = 16 + (peak.intensity / maxIntensity) * (PLOT_H - 30);
            const active = activePeakIds.has(peak.id);
            const stickClass = peak.estimated ? "lf-stick is-estimated" : "lf-stick";
            // A matched-but-low-confidence peak (shallow HOSE sphere / sparse reference) is drawn muted,
            // so the spectrum communicates trust at a glance — distinct from the dashed estimate style.
            const peakClass = `lf-peak${active ? " is-active" : ""}${peak.confidence === "low" ? " is-low-confidence" : ""}`;
            // First-order multiplet lines; sub-pixel at full view, resolve as you zoom in.
            const lines = multipletLines(peak);
            const xs = lines.map((line) => xOf(line.ppm));
            const minX = Math.min(centerX, ...xs);
            const maxX = Math.max(centerX, ...xs);
            return (
              <g
                key={peak.id}
                className={peakClass}
                data-peak-id={peak.id}
                onMouseEnter={() => setHoverPeakId(peak.id)}
                onMouseLeave={() => setHoverPeakId(null)}
              >
                {lines.map((line, index) => (
                  <line
                    key={index}
                    className={stickClass}
                    x1={round(xOf(line.ppm))}
                    y1={BASE_Y}
                    x2={round(xOf(line.ppm))}
                    y2={round(BASE_Y - fullHeight * line.rel)}
                  />
                ))}
                <text className="lf-peak-label" x={round(centerX)} y={round(BASE_Y - fullHeight - 4)} textAnchor="middle">
                  {peak.label ?? peak.ppm.toFixed(2)}
                </text>
                {/* Wider transparent hit area covering the whole multiplet, so it is easy to hover. */}
                <rect className="lf-hit" x={minX - 6} y={MARGIN.top} width={maxX - minX + 12} height={PLOT_H} />
              </g>
            );
          })}
          <text className="lf-axis-caption" x={MARGIN.left + PLOT_W / 2} y={SPECTRUM_H - 4} textAnchor="middle">
            δ (ppm){reversed ? " · high → low" : ""}
          </text>
        </svg>

        {layout ? (
          <svg className="lf-structure" viewBox={`0 0 ${STRUCT_W} ${STRUCT_H}`} role="img" aria-label="Predicted structure with shifts">
            {layout.bonds.map((bond, index) => (
              <g className="lf-bond" key={`b${index}`}>
                {bond.lines.map((line, lineIndex) => (
                  <line key={lineIndex} x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} />
                ))}
              </g>
            ))}
            {layout.atoms.map((atom) => {
              const active = activeAtoms.has(atom.index);
              const shift = atomShift.get(atom.index);
              const isHetero = atom.element !== "C";
              return (
                <g
                  key={`a${atom.index}`}
                  className={active ? "lf-atom is-active" : "lf-atom"}
                  data-atom-index={atom.index}
                  onMouseEnter={() => setHoverAtomIndex(atom.index)}
                  onMouseLeave={() => setHoverAtomIndex(null)}
                >
                  {active ? <circle className="lf-atom-halo" cx={atom.sx} cy={atom.sy} r={12} /> : null}
                  {isHetero ? (
                    <>
                      <circle className="lf-atom-bg" cx={atom.sx} cy={atom.sy} r={8} />
                      <text className="lf-atom-label" x={atom.sx} y={atom.sy} textAnchor="middle" dominantBaseline="central">
                        {atom.element}
                      </text>
                    </>
                  ) : null}
                  {shift ? (
                    <text className="lf-shift-label" x={atom.sx + 7} y={atom.sy - 7} textAnchor="start">
                      {shift}
                    </text>
                  ) : null}
                  {/* Transparent hover target covering the vertex. */}
                  <circle className="lf-hit" cx={atom.sx} cy={atom.sy} r={13} />
                </g>
              );
            })}
          </svg>
        ) : null}
      </div>
    </div>
  );
}

interface LaidOutAtom {
  index: number;
  element: string;
  sx: number;
  sy: number;
}
interface LaidOutBond {
  lines: { x1: number; y1: number; x2: number; y2: number }[];
}

/** Fit the molecule's arbitrary 2D coordinates into the structure viewBox, preserving aspect ratio,
 *  and pre-compute bond line geometry (double/triple bonds as parallel offset lines). */
function layoutStructure(structure: PluginLinkedFigureStructure): { atoms: LaidOutAtom[]; bonds: LaidOutBond[] } {
  const xs = structure.atoms.map((atom) => atom.x);
  const ys = structure.atoms.map((atom) => atom.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const scale = Math.min((STRUCT_W - 2 * STRUCT_PAD) / spanX, (STRUCT_H - 2 * STRUCT_PAD) / spanY);
  const offsetX = (STRUCT_W - spanX * scale) / 2;
  const offsetY = (STRUCT_H - spanY * scale) / 2;
  const project = (x: number, y: number): { sx: number; sy: number } => ({
    sx: offsetX + (x - minX) * scale,
    sy: offsetY + (y - minY) * scale
  });

  const byIndex = new Map<number, { sx: number; sy: number }>();
  const atoms: LaidOutAtom[] = structure.atoms.map((atom) => {
    const point = project(atom.x, atom.y);
    byIndex.set(atom.index, point);
    return { index: atom.index, element: atom.element, sx: round(point.sx), sy: round(point.sy) };
  });

  const bonds: LaidOutBond[] = structure.bonds.flatMap((bond) => {
    const a = byIndex.get(bond.from);
    const b = byIndex.get(bond.to);
    if (!a || !b) return [];
    return [{ lines: parallelLines(a, b, bond.order) }];
  });

  return { atoms, bonds };
}

function parallelLines(
  a: { sx: number; sy: number },
  b: { sx: number; sy: number },
  order: number
): { x1: number; y1: number; x2: number; y2: number }[] {
  const dx = b.sx - a.sx;
  const dy = b.sy - a.sy;
  const length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length;
  const ny = dx / length;
  const gap = 3;
  const count = order >= 1 && order <= 3 ? order : 1;
  const offsets = count === 1 ? [0] : count === 2 ? [-gap / 2, gap / 2] : [-gap, 0, gap];
  return offsets.map((offset) => ({
    x1: round(a.sx + nx * offset),
    y1: round(a.sy + ny * offset),
    x2: round(b.sx + nx * offset),
    y2: round(b.sy + ny * offset)
  }));
}

const SPECTROMETER_MHZ = 400;
const MAX_MULTIPLET_LINES = 32;

/** First-order multiplet line positions (ppm) + relative heights for a peak. Sub-pixel at full view;
 *  they spread apart as you zoom in. Falls back to a single line when the pattern is too dense. */
function multipletLines(peak: PluginLinkedFigurePeak): { ppm: number; rel: number }[] {
  const couplings = peak.couplings ?? [];
  const lineCount = couplings.reduce((n, coupling) => n * (coupling.partnerCount + 1), 1);
  if (couplings.length === 0 || lineCount > MAX_MULTIPLET_LINES) {
    return [{ ppm: peak.ppm, rel: 1 }];
  }
  let lines: { ppm: number; weight: number }[] = [{ ppm: peak.ppm, weight: 1 }];
  for (const coupling of couplings) {
    const offset = coupling.jHz / SPECTROMETER_MHZ;
    const n = coupling.partnerCount;
    const next: { ppm: number; weight: number }[] = [];
    for (const line of lines) {
      for (let k = 0; k <= n; k += 1) {
        next.push({ ppm: line.ppm + (k - n / 2) * offset, weight: line.weight * binomial(n, k) });
      }
    }
    lines = next;
  }
  const maxWeight = Math.max(...lines.map((line) => line.weight));
  return lines.map((line) => ({ ppm: line.ppm, rel: line.weight / maxWeight }));
}

function binomial(n: number, k: number): number {
  let result = 1;
  for (let i = 0; i < k; i += 1) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}

function axisTicks(min: number, max: number): number[] {
  const step = niceStep((max - min) / 6);
  const ticks: number[] = [];
  for (let tick = Math.ceil(min / step) * step; tick <= max + 1e-9; tick += step) {
    ticks.push(Math.round(tick * 100) / 100);
  }
  return ticks;
}

function niceStep(rough: number): number {
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(rough, 1e-6))));
  return (
    [1, 2, 2.5, 5, 10].map((multiple) => multiple * magnitude).find((candidate) => candidate >= rough) ?? 10 * magnitude
  );
}

function clampWindow(min: number, max: number, domain: { min: number; max: number }): { min: number; max: number } {
  const span = max - min;
  if (min < domain.min) return { min: domain.min, max: domain.min + span };
  if (max > domain.max) return { min: domain.max - span, max: domain.max };
  return { min, max };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatNucleus(nucleus: string): string {
  if (nucleus === "13C") return "¹³C";
  if (nucleus === "1H") return "¹H";
  return nucleus;
}
