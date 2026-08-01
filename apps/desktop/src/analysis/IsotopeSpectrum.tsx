/**
 * A stick spectrum for a `ReportSpectrumSection` — the isotope envelope drawn the way a chemist reads
 * one, rather than as a column of numbers.
 *
 * Inline SVG with no charting dependency: a stick spectrum is a handful of lines and two axes, and the
 * app already refuses to take a library for something this size.
 *
 * **The caption is not decoration.** A stick spectrum looks exactly like a measured one, and nothing
 * else on screen would tell a reader this is a theoretical distribution with no instrument, adduct, or
 * fragmentation behind it. It renders under every plot.
 */
import { useMemo } from "react";

import type { ReportSpectrumSection } from "@chemdraft/analysis-core";
import { unit as unitDefinition } from "@chemdraft/analysis-core";

const WIDTH = 520;
const HEIGHT = 190;
const PADDING = { top: 10, right: 12, bottom: 30, left: 42 };
const PLOT_WIDTH = WIDTH - PADDING.left - PADDING.right;
const PLOT_HEIGHT = HEIGHT - PADDING.top - PADDING.bottom;

function unitSymbol(id: string): string {
  try {
    return unitDefinition(id as never).symbol;
  } catch {
    return "";
  }
}

export function IsotopeSpectrum({ section }: { section: ReportSpectrumSection }) {
  const decimals = section.positionDecimals ?? 5;

  const model = useMemo(() => {
    const peaks = section.positions.map((position, index) => ({
      position,
      intensity: section.intensities[index] ?? 0
    }));
    if (peaks.length === 0) return undefined;

    const minPosition = Math.min(...peaks.map((peak) => peak.position));
    const maxPosition = Math.max(...peaks.map((peak) => peak.position));
    // A single peak has no range; give it one so it lands mid-plot instead of dividing by zero.
    const span = maxPosition - minPosition || 2;
    const domainMin = minPosition - span * 0.08;
    const domainMax = maxPosition + span * 0.08;
    const maxIntensity = Math.max(...peaks.map((peak) => peak.intensity)) || 100;

    return {
      peaks,
      domainMin,
      domainMax,
      maxIntensity,
      x: (position: number) =>
        PADDING.left + ((position - domainMin) / (domainMax - domainMin)) * PLOT_WIDTH,
      y: (intensity: number) => PADDING.top + PLOT_HEIGHT - (intensity / maxIntensity) * PLOT_HEIGHT
    };
  }, [section.positions, section.intensities]);

  if (!model) return null;

  const positionLabel = unitSymbol(section.positionUnit);
  const intensityLabel = unitSymbol(section.intensityUnit);
  // Only the tallest few get labelled — labelling twenty sticks in 520px is unreadable, and the table
  // in the copied text carries every value anyway.
  const labelled = new Set(
    [...model.peaks]
      .sort((a, b) => b.intensity - a.intensity)
      .slice(0, 3)
      .map((peak) => peak.position)
  );

  return (
    <figure className="isotope-spectrum">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`${section.title}. ${model.peaks.length} peaks from ${model.peaks[0]!.position.toFixed(decimals)} to ${model.peaks[model.peaks.length - 1]!.position.toFixed(decimals)} ${positionLabel}.`}
      >
        {/* Intensity gridlines at 0/25/50/75/100% of the base peak. */}
        {[0, 25, 50, 75, 100].map((percent) => {
          const y = model.y((percent / 100) * model.maxIntensity);
          return (
            <g key={percent}>
              <line className="isotope-spectrum-grid" x1={PADDING.left} y1={y} x2={WIDTH - PADDING.right} y2={y} />
              <text className="isotope-spectrum-tick" x={PADDING.left - 6} y={y + 3} textAnchor="end">
                {percent}
              </text>
            </g>
          );
        })}

        <line
          className="isotope-spectrum-axis"
          x1={PADDING.left}
          y1={PADDING.top + PLOT_HEIGHT}
          x2={WIDTH - PADDING.right}
          y2={PADDING.top + PLOT_HEIGHT}
        />

        {model.peaks.map((peak) => (
          <line
            key={peak.position}
            className="isotope-spectrum-peak"
            x1={model.x(peak.position)}
            y1={PADDING.top + PLOT_HEIGHT}
            x2={model.x(peak.position)}
            y2={model.y(peak.intensity)}
          >
            <title>{`${peak.position.toFixed(decimals)} ${positionLabel} · ${peak.intensity.toFixed(2)} ${intensityLabel}`}</title>
          </line>
        ))}

        {model.peaks
          .filter((peak) => labelled.has(peak.position))
          .map((peak) => (
            <text
              key={`label-${peak.position}`}
              className="isotope-spectrum-peak-label"
              x={model.x(peak.position)}
              y={model.y(peak.intensity) - 4}
              textAnchor="middle"
            >
              {peak.position.toFixed(Math.min(decimals, 4))}
            </text>
          ))}

        {/* Axis ends rather than evenly spaced ticks: the domain is narrow and the exact endpoints are
            what a reader checks against a monoisotopic mass. */}
        <text className="isotope-spectrum-tick" x={PADDING.left} y={HEIGHT - 12} textAnchor="start">
          {model.domainMin.toFixed(2)}
        </text>
        <text className="isotope-spectrum-tick" x={WIDTH - PADDING.right} y={HEIGHT - 12} textAnchor="end">
          {model.domainMax.toFixed(2)}
        </text>
        <text className="isotope-spectrum-axis-label" x={WIDTH / 2} y={HEIGHT - 2} textAnchor="middle">
          {positionLabel}
        </text>
      </svg>
      {section.caption ? <figcaption>{section.caption}</figcaption> : null}
    </figure>
  );
}
