import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type {
  PluginLinkedFigurePeak,
  PluginLinkedFigureSpectrum,
  PluginLinkedFigureStructure
} from "@chemdraft/plugin-api";

import {
  copySpectrumToClipboard,
  observeFrequencyMHz,
  saveTextFile,
  spectrumComparisonLabels,
  spectrumPeaksForMode,
  spectrumToJcampDx,
  standaloneSpectrumSvg,
  type DisplaySpectrumPeak,
  type SpectrumComparisonMode
} from "./spectrumExport";

/**
 * Core-owned interactive figure for the `linkedFigure` panel section (ADR-0015). The plugin ships
 * only data (peaks + chemistry-agnostic geometry); this component owns all rendering and interaction:
 * a zoom/pan spectrum and a 2D structure annotated with per-atom shifts, cross-highlighting on hover
 * (hover a peak → its atoms light up; hover an atom → its peak lights up). No plugin script runs.
 */
export interface LinkedFigureViewProps {
  spectrum: PluginLinkedFigureSpectrum;
  structure?: PluginLinkedFigureStructure;
  /** True when rendered inside the full-size modal — hides its own "Full size" button (no recursion). */
  fullScreen?: boolean;
  /** Initial rendering field (MHz); the modal passes the outer view's choice through. */
  defaultSpectrometerMHz?: number;
  /** Initial comparison display mode; the modal passes the outer view's choice through. */
  defaultComparisonMode?: SpectrumComparisonMode;
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

interface AtomShiftLabelPart {
  label: string;
  variant: "primary" | "alternative";
}

export function LinkedFigureView({
  spectrum,
  structure,
  fullScreen = false,
  defaultSpectrometerMHz = DEFAULT_SPECTROMETER_MHZ,
  defaultComparisonMode = "primary"
}: LinkedFigureViewProps) {
  const reversed = spectrum.reversed ?? true;
  const [protonFrequencyMHz, setProtonFrequencyMHz] = useState(defaultSpectrometerMHz);
  const [comparisonMode, setComparisonMode] = useState<SpectrumComparisonMode>(defaultComparisonMode);
  const hasAlternative = spectrum.peaks.some((peak) => peak.alternativePpm !== undefined);
  const supportsComparison = spectrum.comparison !== undefined || hasAlternative;
  const effectiveComparisonMode: SpectrumComparisonMode = hasAlternative ? comparisonMode : "primary";
  const comparison = spectrumComparisonLabels(spectrum);
  const alternativeSuffix = comparison.alternativeMarker ?? ` (${comparison.alternativeLabel})`;
  const effectiveDomain = useMemo(() => effectiveSpectrumDomain(spectrum), [spectrum]);
  const domainSpan = Math.max(1e-6, effectiveDomain.max - effectiveDomain.min);
  const observeMHz = observeFrequencyMHz(spectrum.nucleus, protonFrequencyMHz);
  const renderPeaks = useMemo(
    () => spectrumPeaksForMode(spectrum.peaks, effectiveComparisonMode),
    [spectrum.peaks, effectiveComparisonMode]
  );
  const spectrumIdentity = useMemo(() => spectrumViewportIdentity(spectrum), [spectrum]);

  const [view, setView] = useState(effectiveDomain);
  const [viewSpectrumIdentity, setViewSpectrumIdentity] = useState(spectrumIdentity);
  const [hoverPeakId, setHoverPeakId] = useState<string | null>(null);
  const [hoverAtomIndex, setHoverAtomIndex] = useState<number | null>(null);
  const spectrumRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<number | null>(null);
  const pendingPanPixelsRef = useRef(0);
  const panFrameRef = useRef<number | null>(null);

  // Reset for a genuinely different spectrum even when it happens to use the same domain. An
  // identical re-run has the same value fingerprint and intentionally preserves the user's zoom.
  // This render-time state adjustment prevents a one-frame flash through the previous viewport.
  if (viewSpectrumIdentity !== spectrumIdentity) {
    setViewSpectrumIdentity(spectrumIdentity);
    setView(effectiveDomain);
    const nextComparisonMode = hasAlternative ? defaultComparisonMode : "primary";
    if (comparisonMode !== nextComparisonMode) setComparisonMode(nextComparisonMode);
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
    const map = new Map<number, AtomShiftLabelPart[]>();
    for (const peak of renderPeaks) {
      const label = peak.variant === "alternative" ? `${peak.label}${alternativeSuffix}` : peak.label;
      for (const atom of peak.atomIndices) {
        const labels = map.get(atom) ?? [];
        labels.push({ label, variant: peak.variant });
        map.set(atom, labels);
      }
    }
    return map;
  }, [alternativeSuffix, renderPeaks]);

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
      const min = cursorPpm - rel * nextSpan;
      return clampWindow(min, min + nextSpan, effectiveDomain);
    });
  };

  const zoomByButton = (direction: "in" | "out"): void =>
    zoomAround(MARGIN.left + PLOT_W / 2, direction === "in" ? -120 : 120);

  // Pan the viewport by `dx` pixels (in SPECTRUM_W space); shared by drag and horizontal scroll.
  const panByPixels = (dx: number): void => {
    setView((prev) => {
      const span = prev.max - prev.min;
      const shift = (span / PLOT_W) * dx * (reversed ? 1 : -1);
      return clampWindow(prev.min + shift, prev.max + shift, effectiveDomain);
    });
  };

  // Pointer events can arrive substantially faster than a display refresh. Coalesce their pixel
  // deltas so the expensive envelope resampling happens no more than once per animation frame.
  const schedulePanByPixels = (dx: number): void => {
    pendingPanPixelsRef.current += dx;
    if (panFrameRef.current !== null) return;
    const applyPendingPan = (): void => {
      panFrameRef.current = null;
      const pending = pendingPanPixelsRef.current;
      pendingPanPixelsRef.current = 0;
      if (pending !== 0) panByPixels(pending);
    };
    if (typeof window.requestAnimationFrame === "function") {
      panFrameRef.current = window.requestAnimationFrame(applyPendingPan);
    } else {
      applyPendingPan();
    }
  };

  useEffect(
    () => () => {
      if (panFrameRef.current !== null && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(panFrameRef.current);
      }
    },
    []
  );

  useEffect(() => {
    const svg = spectrumRef.current;
    if (!svg) return undefined;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      // A two-finger horizontal swipe (deltaX dominant) pans left/right; vertical scroll/pinch zooms.
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        panByPixels((-event.deltaX / rect.width) * SPECTRUM_W);
      } else {
        zoomAround(((event.clientX - rect.left) / rect.width) * SPECTRUM_W, event.deltaY);
      }
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reversed, domainSpan, effectiveDomain.min, effectiveDomain.max]);

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>): void => {
    dragRef.current = event.clientX;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (dragRef.current === null) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const dx = ((event.clientX - dragRef.current) / rect.width) * SPECTRUM_W;
    dragRef.current = event.clientX;
    schedulePanByPixels(dx);
  };
  const endDrag = (): void => {
    dragRef.current = null;
  };

  const [copied, setCopied] = useState(false);
  const [exportStatus, setExportStatus] = useState<"saved" | "failed" | null>(null);
  const onCopy = (): void => {
    const svg = spectrumRef.current;
    if (!svg) return;
    // Prefer a PNG (pastes as an image into Word) with the SVG as text fallback for vector editors.
    void copySpectrumToClipboard(
      standaloneSpectrumSvg(
        svg,
        comparison.alternativeLabel,
        supportsComparison ? comparison.primaryLabel : undefined
      )
    ).then((result) => {
      if (result !== "none") {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      }
    });
  };
  const onExportJcamp = (): void => {
    const jdx = spectrumToJcampDx(spectrum, {
      title: `Predicted ${formatNucleus(spectrum.nucleus)} NMR`,
      protonFrequencyMHz,
      comparisonMode: effectiveComparisonMode
    });
    void saveTextFile(`predicted-${spectrum.nucleus}-nmr.jdx`, jdx, {
      title: "Export spectrum (JCAMP-DX)",
      formatLabel: "JCAMP-DX",
      extensions: ["jdx", "dx"],
      mimeType: "chemical/x-jcamp-dx"
    }).then((result) => {
      if (result === "cancelled") return;
      setExportStatus(result === "saved" ? "saved" : "failed");
      window.setTimeout(() => setExportStatus(null), 1800);
    });
  };

  const [showFull, setShowFull] = useState(false);
  useEffect(() => {
    if (!showFull) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setShowFull(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showFull]);

  const ticks = useMemo(() => axisTicks(view.min, view.max), [view.min, view.max]);
  const zoomed = view.max - view.min < domainSpan - 1e-6;

  const layout = useMemo(() => (structure ? layoutStructure(structure) : undefined), [structure]);

  // ---- realistic (summed pseudo-Voigt) spectrum -----------------------------------------------
  const ppmPerPx = (view.max - view.min) / PLOT_W;
  const halfWidthPpm = Math.max(LINE_HALF_WIDTH_HZ / observeMHz, MIN_HALF_WIDTH_PX * ppmPerPx);
  // Oversample finely enough that a peak this sharp is caught (≈3 samples across its half-width), but no
  // finer than 1px so zoomed-in views stay cheap.
  const sampleStep = Math.max(0.25, Math.min(1, halfWidthPpm / ppmPerPx / 3));
  const renderPeakLayouts = useMemo(
    () =>
      renderPeaks.map((peak) => ({
        peak,
        lines: multipletLines(peak, observeMHz)
      })),
    [renderPeaks, observeMHz]
  );
  const spectrumLines = useMemo(
    () =>
      renderPeakLayouts.flatMap(({ peak, lines }) =>
        lines.map((line) => ({
          ppm: line.ppm,
          amp: Math.max(0.001, peak.intensity) * line.rel,
          peakId: peak.sourceId,
          style: curveStyleForPeak(peak)
        }))
      ),
    [renderPeakLayouts]
  );
  const sampled = useMemo(
    () => sampleStyledEnvelope(spectrumLines, view, reversed, halfWidthPpm, sampleStep),
    [spectrumLines, view.min, view.max, reversed, halfWidthPpm, sampleStep]
  );
  const hasVisibleLine = spectrumLines.some((line) => line.ppm >= view.min && line.ppm <= view.max);
  const offscreenScaleReference = Math.max(1e-9, ...spectrumLines.map((line) => line.amp));
  const normalizationMax = hasVisibleLine ? sampled.max : offscreenScaleReference;
  const heightScale = (PLOT_H - SPECTRUM_TOP_PAD) / normalizationMax;
  const spectrumCurvePaths = useMemo(
    () => styledSpectrumPaths(sampled, heightScale),
    [sampled, heightScale]
  );
  const activeCurvePath = useMemo(() => {
    if (activePeakIds.size === 0) return "";
    const lines = spectrumLines.filter((line) => activePeakIds.has(line.peakId));
    const s = sampleEnvelope(lines, view, reversed, halfWidthPpm, sampleStep);
    return spectrumPathFrom(s.xs, s.totals, heightScale);
  }, [spectrumLines, activePeakIds, view.min, view.max, reversed, halfWidthPpm, sampleStep, heightScale]);
  // Label height comes from the true curve value at the peak's center ppm (independent of sampling).
  const heightAtPpm = (ppm: number): number => envelopeHeight(spectrumLines, ppm, halfWidthPpm) * heightScale;

  // Per-atom estimation quality (good/medium/rough) for coloring the structure's shift labels, the way
  // ChemDraw signals confidence — derived from the same tiers as the table (high→good, low/est→rough).
  const atomQuality = useMemo(() => {
    const map = new Map<number, "good" | "medium" | "rough">();
    for (const peak of spectrum.peaks) {
      const quality = peak.estimated
        ? "rough"
        : peak.confidence === "high"
          ? "good"
          : peak.confidence === "medium"
            ? "medium"
            : peak.confidence === "low"
              ? "rough"
              : undefined;
      if (!quality) continue;
      for (const atom of peak.atomIndices) map.set(atom, quality);
    }
    return map;
  }, [spectrum.peaks]);
  const hasQuality = atomQuality.size > 0;

  const figure = (
    <div className={`lf-root${fullScreen ? " is-fullscreen" : ""}`}>
      <div className="lf-toolbar">
        <span className="lf-axis-name">{formatNucleus(spectrum.nucleus)}</span>
        <div className="lf-toolbar-actions">
          <button type="button" className="lf-btn" aria-label="Zoom out" onClick={() => zoomByButton("out")}>
            −
          </button>
          <button type="button" className="lf-btn" aria-label="Zoom in" onClick={() => zoomByButton("in")}>
            +
          </button>
          <button
            type="button"
            className="lf-btn"
            disabled={!zoomed}
            onClick={() => setView(effectiveDomain)}
          >
            Reset
          </button>
          <span className="lf-toolbar-sep" aria-hidden="true" />
          <button
            type="button"
            className="lf-btn"
            onClick={onCopy}
            title="Copy the spectrum (image for Word/docs, SVG for vector editors)"
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            className="lf-btn"
            onClick={onExportJcamp}
            title="Download as JCAMP-DX (.jdx) — opens in MestReNova, TopSpin, ACD, …"
          >
            {exportStatus === "saved" ? "Exported" : exportStatus === "failed" ? "Export failed" : "Export"}
          </button>
          {!fullScreen ? (
            <button type="button" className="lf-btn" onClick={() => setShowFull(true)} title="Open an enlarged spectrum">
              Full size
            </button>
          ) : null}
        </div>
      </div>

      <div className="lf-meta">
        {spectrum.solvent ? <span>Solvent: {spectrum.solvent}</span> : null}
        <label className="lf-meta-field">
          Proton-rated field
          <select
            className="lf-select"
            value={protonFrequencyMHz}
            onChange={(event) => setProtonFrequencyMHz(Number(event.target.value))}
            title="Instrument field stated at the proton frequency; linewidth and J spacing use the actual observed-nucleus frequency"
          >
            {SPECTROMETER_FIELDS_MHZ.map((mhz) => (
              <option key={mhz} value={mhz}>
                {mhz} MHz ¹H
              </option>
            ))}
          </select>
        </label>
        <span className="lf-observe-frequency">
          Observe {formatNucleus(spectrum.nucleus)}: {formatObserveFrequency(observeMHz)} MHz
        </span>
        {supportsComparison ? (
          <label className="lf-meta-field">
            Shift comparison
            <select
              className="lf-select"
              value={effectiveComparisonMode}
              disabled={!hasAlternative}
              onChange={(event) => setComparisonMode(event.target.value as SpectrumComparisonMode)}
              title={
                hasAlternative
                  ? `Selected peaks have an applicable ${comparison.alternativeLabel} comparison. Prefer the ${comparison.primaryLabel} prediction, or show both.`
                  : `No chemically applicable ${comparison.alternativeLabel} values are available for this spectrum.`
              }
            >
              {hasAlternative ? (
                <>
                  <option value="primary">Prefer {comparison.primaryLabel}</option>
                  <option value="both">
                    Show both
                    {comparison.alternativeMarker
                      ? ` (${comparison.alternativeMarker} = ${comparison.alternativeLabel})`
                      : ` (${comparison.alternativeLabel})`}
                  </option>
                </>
              ) : (
                <option value="primary">
                  {comparison.primaryLabel} only — {comparison.alternativeLabel} not applicable
                </option>
              )}
            </select>
          </label>
        ) : null}
      </div>

      <div className="lf-figures">
        <svg
          ref={spectrumRef}
          className="lf-spectrum"
          viewBox={`0 0 ${SPECTRUM_W} ${SPECTRUM_H}`}
          data-observe-frequency-mhz={formatObserveFrequency(observeMHz)}
          role="img"
          aria-label={`Predicted ${formatNucleus(spectrum.nucleus)} spectrum; scroll to zoom, drag to pan`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerLeave={endDrag}
        >
          <line className="lf-axis" x1={MARGIN.left} y1={BASE_Y} x2={MARGIN.left + PLOT_W} y2={BASE_Y} />
          <text className="lf-spectrum-note" x={MARGIN.left} y={11}>
            Height = predicted equivalent nuclei (not experimental integration)
            {renderPeaks.some((peak) => peak.estimated) ? " · grey dashed = rule-estimated" : ""}
            {effectiveComparisonMode === "both" && hasAlternative
              ? ` · dashed orange = ${comparison.alternativeLabel}`
              : ""}
          </text>
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
          {/* Curve layers share one normalization but retain provenance styling. */}
          {spectrumCurvePaths.map(({ key, style, d }) => (
            <path key={key} className={curveClassName(style)} d={d} />
          ))}
          {activeCurvePath ? <path className="lf-curve is-active" d={activeCurvePath} /> : null}
          {renderPeakLayouts.map(({ peak, lines }) => {
            const centerX = xOf(peak.ppm);
            if (centerX < MARGIN.left - 1 || centerX > MARGIN.left + PLOT_W + 1) return null;
            const active = activePeakIds.has(peak.sourceId);
            // Confidence never restyles the spectrum trace; it reads from the structure labels and
            // table instead (user direction, ADR-0025). Rule estimates stay visually distinct.
            const peakClass = `lf-peak${active ? " is-active" : ""}${peak.estimated ? " is-estimated" : ""}`;
            const labelClass = `lf-peak-label${peak.estimated ? " is-estimated" : ""}${peak.variant === "alternative" ? " is-alternative" : ""}`;
            const xs = lines.map((line) => xOf(line.ppm));
            const minX = Math.min(centerX, ...xs);
            const maxX = Math.max(centerX, ...xs);
            const apexY = BASE_Y - Math.max(...lines.map((line) => heightAtPpm(line.ppm)));
            return (
              <g
                key={peak.key}
                className={peakClass}
                data-peak-id={peak.key}
                data-variant={peak.variant}
                data-line-count={lines.length}
                onMouseEnter={() => setHoverPeakId(peak.sourceId)}
                onMouseLeave={() => setHoverPeakId(null)}
              >
                <text className={labelClass} x={round(centerX)} y={round(apexY - 6)} textAnchor="middle">
                  {peak.variant === "alternative" ? `${peak.label}${alternativeSuffix}` : peak.label}
                </text>
                {/* Wider transparent hit area covering the whole multiplet, so it is easy to hover. */}
                <rect className="lf-hit" x={round(minX - 6)} y={MARGIN.top} width={round(maxX - minX + 12)} height={PLOT_H} />
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
                    <text
                      className={`lf-shift-label${atomQuality.has(atom.index) ? ` is-${atomQuality.get(atom.index)}` : ""}`}
                      x={atom.sx + 7}
                      y={atom.sy - 7}
                      style={{ fontSize: layout.labelFontSize }}
                      textAnchor="start"
                    >
                      {shift.map((part, index) => (
                        <tspan
                          key={`${part.variant}-${part.label}-${index}`}
                          className={part.variant === "alternative" ? "lf-shift-alternative" : undefined}
                        >
                          {index > 0 ? " / " : ""}
                          {part.label}
                        </tspan>
                      ))}
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

      {hasQuality ? (
        <div className="lf-legend" aria-hidden="true">
          <span>
            Shift label color = {spectrum.comparison ? comparison.primaryLabel : "prediction"} confidence:
          </span>
          <span className="lf-legend-item is-good">good</span>
          <span className="lf-legend-item is-medium">medium</span>
          <span className="lf-legend-item is-rough">rough</span>
        </div>
      ) : null}
    </div>
  );

  if (fullScreen || !showFull) {
    return figure;
  }

  // Enlarged spectrum in a modal, portalled to <body> so the draggable panel's transform can't offset
  // it. The modal hosts a fresh full-size figure (its own zoom/pan); Esc, the Close button, or a
  // backdrop click dismiss it.
  return (
    <>
      {figure}
      {createPortal(
        <div className="lf-modal-backdrop" role="presentation" onClick={() => setShowFull(false)}>
          <div className="lf-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="lf-btn lf-modal-close"
              onClick={() => setShowFull(false)}
              aria-label="Close full-size spectrum"
            >
              Close
            </button>
            <LinkedFigureView
              spectrum={spectrum}
              structure={structure}
              fullScreen
              defaultSpectrometerMHz={protonFrequencyMHz}
              defaultComparisonMode={effectiveComparisonMode}
            />
          </div>
        </div>,
        document.body
      )}
    </>
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
function layoutStructure(
  structure: PluginLinkedFigureStructure
): { atoms: LaidOutAtom[]; bonds: LaidOutBond[]; labelFontSize: number } {
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

  // Shrink the shift labels when the structure is crowded (many atoms → short laid-out bonds) so the
  // numbers don't overlap; a sparse structure keeps the full-size label.
  const bondLengths = structure.bonds
    .map((bond) => {
      const a = byIndex.get(bond.from);
      const b = byIndex.get(bond.to);
      return a && b ? Math.hypot(b.sx - a.sx, b.sy - a.sy) : 0;
    })
    .filter((length) => length > 0)
    .sort((left, right) => left - right);
  const medianBond = bondLengths.length ? bondLengths[Math.floor(bondLengths.length / 2)] : 40;
  const labelFontSize = Math.max(6.5, Math.min(14, medianBond * 0.34));

  return { atoms, bonds, labelFontSize };
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

/** Selectable rendering fields. J is field-independent in Hz; the field sets the ppm spacing (J/MHz). */
const SPECTROMETER_FIELDS_MHZ = [300, 400, 500, 600, 700, 800, 900, 1000] as const;
const DEFAULT_SPECTROMETER_MHZ = 300;
const MAX_MULTIPLET_LINES = 32;

// The trace is a summed line-profile envelope (not raw sticks) so it reads as an actual spectrum. The
// half-width must stay *narrower than a typical coupling* (7 Hz) or multiplets collapse into singlets:
// it is a physical ~0.9 Hz linewidth (ppm width = Hz / field) with only a small pixel floor, and the
// curve is oversampled (sub-pixel) so sharp peaks never fall between samples. The profile itself is a
// pseudo-Voigt — a Lorentzian core with a Gaussian-dominated base — because a pure Lorentzian's 1/(1+d²)
// tail leaves an identical wide flare at the base of every peak at this vertical scale.
const LINE_HALF_WIDTH_HZ = 0.9;
const MIN_HALF_WIDTH_PX = 0.5; // floor so a peak stays ≥ ~1px FWHM at full view without merging multiplets
const LORENTZIAN_FRACTION = 0.3; // pseudo-Voigt mix: 30% Lorentzian core, 70% Gaussian base
const SPECTRUM_TOP_PAD = 26; // headroom above the tallest peak for its label

type CurveStyle = "trusted" | "estimated" | "alternative";
const CURVE_STYLES: readonly CurveStyle[] = ["trusted", "estimated", "alternative"];

interface SpectrumLine {
  ppm: number;
  amp: number;
  peakId: string;
  style: CurveStyle;
}

function curveStyleForPeak(peak: DisplaySpectrumPeak): CurveStyle {
  if (peak.variant === "alternative") return "alternative";
  // Confidence deliberately does not restyle the trace (ADR-0025); only method provenance does.
  return peak.estimated ? "estimated" : "trusted";
}

function curveClassName(style: CurveStyle): string {
  if (style === "trusted") return "lf-curve";
  // Orange identifies the provider's alternative estimate and keeps it separate from the primary.
  if (style === "alternative") return "lf-curve is-alternative";
  return `lf-curve is-${style}`;
}

/** First-order multiplet line positions (ppm) + relative heights for a peak. Sub-pixel at full view;
 *  they spread apart as you zoom in. Falls back to a single line when the pattern is too dense. */

function multipletLines(
  peak: { ppm: number; couplings?: PluginLinkedFigurePeak["couplings"] },
  spectrometerMHz: number
): { ppm: number; rel: number }[] {
  const couplings = peak.couplings ?? [];
  const lineCount = couplings.reduce((n, coupling) => n * (coupling.partnerCount + 1), 1);
  if (couplings.length === 0 || lineCount > MAX_MULTIPLET_LINES) {
    return [{ ppm: peak.ppm, rel: 1 }];
  }
  let lines: { ppm: number; weight: number }[] = [{ ppm: peak.ppm, weight: 1 }];
  for (const coupling of couplings) {
    const offset = coupling.jHz / spectrometerMHz;
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

/** Pseudo-Voigt line profile (normalized to 1 at d=0, 0.5 at d=±1): Lorentzian core, Gaussian base. */
function lineShape(d: number): number {
  const lorentzian = 1 / (1 + d * d);
  const gaussian = Math.exp(-Math.LN2 * d * d);
  return LORENTZIAN_FRACTION * lorentzian + (1 - LORENTZIAN_FRACTION) * gaussian;
}

/** Evaluate the summed line-profile height (pre-scale) at a single ppm — used for peak-label placement. */
function envelopeHeight(lines: readonly { ppm: number; amp: number }[], ppm: number, halfWidthPpm: number): number {
  let total = 0;
  for (const line of lines) {
    total += line.amp * lineShape((ppm - line.ppm) / halfWidthPpm);
  }
  return total;
}

/** Sample the summed line-profile envelope of `lines` across the plot at `step` px (sub-pixel so sharp
 *  peaks never fall between samples). Returns the pre-scale heights + their max, so the caller can
 *  normalize the tallest visible peak to fill the plot. */
function sampleEnvelope(
  lines: readonly { ppm: number; amp: number }[],
  view: { min: number; max: number },
  reversed: boolean,
  halfWidthPpm: number,
  step: number
): { xs: number[]; totals: number[]; max: number } {
  const xs: number[] = [];
  const totals: number[] = [];
  let max = 1e-9;
  const span = view.max - view.min || 1;
  for (let x = MARGIN.left; x <= MARGIN.left + PLOT_W + step; x += step) {
    const frac = (x - MARGIN.left) / PLOT_W;
    const ppm = view.min + (reversed ? 1 - frac : frac) * span;
    const total = envelopeHeight(lines, ppm, halfWidthPpm);
    xs.push(x);
    totals.push(total);
    if (total > max) max = total;
  }
  return { xs, totals, max };
}

interface StyledEnvelopeSample {
  xs: number[];
  totals: number[];
  max: number;
  byStyle: Record<CurveStyle, number[]>;
}

/** Sample all provenance styles in one traversal. This avoids repeating the line-profile work once
 * per curve layer while allowing rule-estimated and alternative traces to retain distinct styling. */
function sampleStyledEnvelope(
  lines: readonly SpectrumLine[],
  view: { min: number; max: number },
  reversed: boolean,
  halfWidthPpm: number,
  step: number
): StyledEnvelopeSample {
  const xs: number[] = [];
  const totals: number[] = [];
  const byStyle: Record<CurveStyle, number[]> = {
    trusted: [],
    estimated: [],
    alternative: []
  };
  let max = 1e-9;
  const span = view.max - view.min || 1;
  for (let x = MARGIN.left; x <= MARGIN.left + PLOT_W + step; x += step) {
    const frac = (x - MARGIN.left) / PLOT_W;
    const ppm = view.min + (reversed ? 1 - frac : frac) * span;
    const styleTotals: Record<CurveStyle, number> = {
      trusted: 0,
      estimated: 0,
      alternative: 0
    };
    let total = 0;
    for (const line of lines) {
      const height = line.amp * lineShape((ppm - line.ppm) / halfWidthPpm);
      total += height;
      styleTotals[line.style] += height;
    }
    xs.push(x);
    totals.push(total);
    for (const style of CURVE_STYLES) byStyle[style].push(styleTotals[style]);
    if (total > max) max = total;
  }
  return { xs, totals, max, byStyle };
}

/** Keep the trace as the true summed envelope, but split it into contiguous provenance-styled
 * segments according to the dominant contribution at each sample. This mutes uncertain regions
 * without turning overlapping peaks into physically incorrect independent envelopes. */
function styledSpectrumPaths(
  sampled: StyledEnvelopeSample,
  heightScale: number
): { key: string; style: CurveStyle; d: string }[] {
  if (sampled.xs.length === 0) return [];
  const dominantStyleAt = (index: number): CurveStyle => {
    let dominant: CurveStyle = "trusted";
    let height = -1;
    for (const style of CURVE_STYLES) {
      if (sampled.byStyle[style][index] > height) {
        dominant = style;
        height = sampled.byStyle[style][index];
      }
    }
    return dominant;
  };

  const paths: { key: string; style: CurveStyle; d: string }[] = [];
  let style = dominantStyleAt(0);
  let start = 0;
  for (let index = 1; index < sampled.xs.length; index += 1) {
    const nextStyle = dominantStyleAt(index);
    if (nextStyle === style) continue;
    paths.push({
      key: `${style}-${paths.length}`,
      style,
      d: spectrumPathFrom(sampled.xs.slice(start, index + 1), sampled.totals.slice(start, index + 1), heightScale)
    });
    start = index;
    style = nextStyle;
  }
  paths.push({
    key: `${style}-${paths.length}`,
    style,
    d: spectrumPathFrom(sampled.xs.slice(start), sampled.totals.slice(start), heightScale)
  });
  return paths;
}

/** Build an SVG polyline `d` from sampled heights at a given value→pixel `scale`, along the baseline. */
function spectrumPathFrom(xs: readonly number[], totals: readonly number[], scale: number): string {
  let d = "";
  for (let i = 0; i < xs.length; i += 1) {
    d += `${i === 0 ? "M" : "L"}${round(xs[i])} ${round(BASE_Y - totals[i] * scale)}`;
  }
  return d;
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

function formatObserveFrequency(frequencyMHz: number): string {
  return Number.isInteger(frequencyMHz) ? String(frequencyMHz) : frequencyMHz.toFixed(2);
}

/** A schema-valid alternative can fall outside the plugin's suggested domain. Expand only the side
 * that needs it, with a small label-safe pad, so no selected peak is permanently culled. */
function effectiveSpectrumDomain(spectrum: PluginLinkedFigureSpectrum): { min: number; max: number } {
  const peakPpm = spectrum.peaks.flatMap((peak) =>
    peak.alternativePpm === undefined ? [peak.ppm] : [peak.ppm, peak.alternativePpm]
  );
  const rawMin = Math.min(spectrum.domain.min, ...peakPpm);
  const rawMax = Math.max(spectrum.domain.max, ...peakPpm);
  const span = Math.max(1e-6, rawMax - rawMin);
  const pad = Math.max(0.01, span * 0.025);
  return {
    min: rawMin < spectrum.domain.min ? rawMin - pad : spectrum.domain.min,
    max: rawMax > spectrum.domain.max ? rawMax + pad : spectrum.domain.max
  };
}

/** Value fingerprint used only for viewport continuity: identical reruns preserve zoom, while a new
 * prediction resets even if its nominal ppm bounds happen to match the previous one. */
function spectrumViewportIdentity(spectrum: PluginLinkedFigureSpectrum): string {
  return JSON.stringify([
    spectrum.nucleus,
    spectrum.domain.min,
    spectrum.domain.max,
    spectrum.reversed ?? true,
    spectrum.comparison,
    spectrum.peaks.map((peak) => [
      peak.id,
      peak.ppm,
      peak.alternativePpm,
      peak.intensity,
      peak.label,
      peak.atomIndices,
      peak.couplings,
      peak.confidence,
      peak.estimated
    ])
  ]);
}
