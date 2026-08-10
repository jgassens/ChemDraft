// @vitest-environment jsdom

/**
 * The stick spectrum. What matters is that the picture is faithful to the numbers and does not
 * pretend to be a measurement.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { ReportSpectrumSection } from "@chemdraft/analysis-core";

import { IsotopeSpectrum } from "./IsotopeSpectrum";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Bromobenzene: a near-1:1 doublet, plus two small peaks that must still be drawn. */
const SECTION: ReportSpectrumSection = {
  kind: "spectrum",
  title: "Isotope envelope (4 peaks, 99.99% of the distribution)",
  positions: [155.95746, 156.96082, 157.95542, 158.95877],
  intensities: [100, 6.54, 97.28, 6.37],
  positionUnit: "dalton",
  intensityUnit: "relative-abundance",
  positionDecimals: 5,
  positionLabel: "Mass",
  intensityLabel: "Intensity",
  caption: "Theoretical isotope distribution — not a predicted mass spectrum."
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function render(section: ReportSpectrumSection): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<IsotopeSpectrum section={section} />);
  });
  return container;
}

const peaks = (view: HTMLDivElement) => [...view.querySelectorAll<SVGLineElement>(".isotope-spectrum-peak")];

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("IsotopeSpectrum", () => {
  it("draws one stick per peak", () => {
    expect(peaks(render(SECTION))).toHaveLength(4);
  });

  it("scales stick height to intensity, with the base peak tallest", () => {
    const view = render(SECTION);
    const height = (line: SVGLineElement) =>
      Number(line.getAttribute("y1")) - Number(line.getAttribute("y2"));

    const [base, mPlus1, mPlus2] = peaks(view);
    expect(height(base!)).toBeGreaterThan(height(mPlus2!));
    // 97.28 vs 100 is a small difference and must stay small — a plot that exaggerated it would
    // misrepresent the doublet that identifies bromine.
    expect(height(mPlus2!) / height(base!)).toBeCloseTo(0.9728, 2);
    expect(height(mPlus1!) / height(base!)).toBeCloseTo(0.0654, 2);
  });

  it("orders sticks left to right by mass", () => {
    const xs = peaks(render(SECTION)).map((line) => Number(line.getAttribute("x1")));
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });

  it("still draws a peak that is a fraction of a percent", () => {
    // 0.06% is invisible as a rectangle; the stroke's round cap is what keeps it on screen. A pattern
    // that silently dropped its small isotopologues would read as having fewer peaks than it has.
    const view = render({ ...SECTION, positions: [100, 101], intensities: [100, 0.06] });
    expect(peaks(view)).toHaveLength(2);
  });

  it("survives a single-peak distribution without dividing by a zero range", () => {
    const view = render({ ...SECTION, positions: [180.04226], intensities: [100] });
    const [only] = peaks(view);
    expect(only).toBeDefined();
    expect(Number.isFinite(Number(only!.getAttribute("x1")))).toBe(true);
  });

  it("renders nothing rather than an empty frame when there are no peaks", () => {
    const view = render({ ...SECTION, positions: [], intensities: [] });
    expect(view.querySelector("svg")).toBeNull();
  });

  it("says on the figure that it is not a measured spectrum", () => {
    // A stick plot is indistinguishable from a real one; nothing else on screen would say otherwise.
    const view = render(SECTION);
    expect(view.querySelector("figcaption")?.textContent).toMatch(/not a predicted mass spectrum/i);
  });

  it("labels the axis and exposes the peak values to assistive tech and hover", () => {
    const view = render(SECTION);
    expect(view.querySelector("svg")?.getAttribute("aria-label")).toMatch(/4 peaks/);
    expect(peaks(view)[0]?.querySelector("title")?.textContent).toContain("155.95746");
  });
});
