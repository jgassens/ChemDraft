// @vitest-environment jsdom

import type { PluginLinkedFigureSpectrum, PluginLinkedFigureStructure } from "@chemdraft/plugin-api";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { LinkedFigureView } from "./LinkedFigureView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = undefined;
  container = undefined;
});

function mount(element: ReturnType<typeof createElement>): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
}

// Re-render into the SAME root so the component reconciles in place (as it does when a new prediction
// replaces the previous report at the same section index) rather than remounting fresh.
function rerender(element: ReturnType<typeof createElement>): void {
  act(() => {
    root!.render(element);
  });
}

// React synthesises onMouseEnter from a bubbling `mouseover` at the delegation root.
function hover(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
}

function isActive(selector: string): boolean {
  return container!.querySelector(selector)!.classList.contains("is-active");
}

const spectrum: PluginLinkedFigureSpectrum = {
  nucleus: "1H",
  domain: { min: 0, max: 8 },
  reversed: true,
  peaks: [
    { id: "p1", ppm: 7.3, intensity: 2, label: "7.30", atomIndices: [0, 1] },
    { id: "p2", ppm: 2.4, intensity: 3, label: "2.40", atomIndices: [2] }
  ]
};

const structure: PluginLinkedFigureStructure = {
  atoms: [
    { index: 0, x: 0, y: 0, element: "C" },
    { index: 1, x: 1, y: 0, element: "C" },
    { index: 2, x: 0.5, y: 1, element: "O" }
  ],
  bonds: [
    { from: 0, to: 1, order: 1 },
    { from: 1, to: 2, order: 2 }
  ]
};

describe("LinkedFigureView", () => {
  it("renders a stick per peak, an annotated structure, and a shift next to each atom", () => {
    mount(createElement(LinkedFigureView, { spectrum, structure }));

    expect(container!.querySelectorAll(".lf-peak").length).toBe(2);
    expect(container!.querySelector(".lf-spectrum")).not.toBeNull();
    expect(container!.querySelector(".lf-structure")).not.toBeNull();
    expect(container!.querySelectorAll(".lf-atom").length).toBe(3);

    const shiftLabels = [...container!.querySelectorAll(".lf-shift-label")].map((node) => node.textContent);
    expect(shiftLabels).toContain("7.30");
    expect(shiftLabels).toContain("2.40");
    // Heteroatoms are labelled; carbons are implicit vertices.
    expect([...container!.querySelectorAll(".lf-atom-label")].map((node) => node.textContent)).toEqual(["O"]);
  });

  it("highlights a peak's atoms when the peak is hovered", () => {
    mount(createElement(LinkedFigureView, { spectrum, structure }));

    hover(container!.querySelector('[data-peak-id="p1"]')!);
    expect(isActive('[data-peak-id="p1"]')).toBe(true);
    expect(isActive('[data-atom-index="0"]')).toBe(true);
    expect(isActive('[data-atom-index="1"]')).toBe(true);
    expect(isActive('[data-atom-index="2"]')).toBe(false);
  });

  it("highlights an atom's peak when the atom is hovered", () => {
    mount(createElement(LinkedFigureView, { spectrum, structure }));

    hover(container!.querySelector('[data-atom-index="2"]')!);
    expect(isActive('[data-atom-index="2"]')).toBe(true);
    expect(isActive('[data-peak-id="p2"]')).toBe(true);
    expect(isActive('[data-peak-id="p1"]')).toBe(false);
  });

  it("renders the spectrum alone when the backend supplies no structure geometry", () => {
    mount(createElement(LinkedFigureView, { spectrum }));

    expect(container!.querySelector(".lf-spectrum")).not.toBeNull();
    expect(container!.querySelector(".lf-structure")).toBeNull();
    expect(container!.querySelectorAll(".lf-peak").length).toBe(2);
  });

  it("draws a continuous spectrum curve and resolves a coupled peak to 3 first-order lines", () => {
    const coupled: PluginLinkedFigureSpectrum = {
      nucleus: "1H",
      domain: { min: 0, max: 8 },
      reversed: true,
      peaks: [{ id: "t", ppm: 3.5, intensity: 1, label: "3.50", atomIndices: [0], couplings: [{ jHz: 7, partnerCount: 2 }] }]
    };
    mount(createElement(LinkedFigureView, { spectrum: coupled }));
    // The spectrum is now a single Lorentzian trace, not raw sticks; the triplet's line count is retained.
    const curve = container!.querySelector<SVGPathElement>(".lf-curve");
    expect(curve).not.toBeNull();
    expect((curve!.getAttribute("d") ?? "").length).toBeGreaterThan(50); // a real, multi-point path
    expect(container!.querySelector('[data-peak-id="t"]')!.getAttribute("data-line-count")).toBe("3");
  });

  it("marks a rule-estimated peak with a muted italic label (never reads as measured)", () => {
    const estimatedSpectrum: PluginLinkedFigureSpectrum = {
      nucleus: "1H",
      domain: { min: 0, max: 12 },
      reversed: true,
      peaks: [{ id: "e", ppm: 9.7, intensity: 1, label: "9.70", atomIndices: [0], estimated: true }]
    };
    mount(createElement(LinkedFigureView, { spectrum: estimatedSpectrum }));
    expect(container!.querySelector('[data-peak-id="e"] .lf-peak-label.is-estimated')).not.toBeNull();
  });

  it("mutes a matched-but-low-confidence peak (is-low-confidence), but not a confident one", () => {
    const mixed: PluginLinkedFigureSpectrum = {
      nucleus: "1H",
      domain: { min: 0, max: 10 },
      reversed: true,
      peaks: [
        { id: "lo", ppm: 3.1, intensity: 1, label: "3.10", atomIndices: [0], confidence: "low" },
        { id: "hi", ppm: 7.3, intensity: 1, label: "7.30", atomIndices: [1], confidence: "high" }
      ]
    };
    mount(createElement(LinkedFigureView, { spectrum: mixed }));
    expect(container!.querySelector('[data-peak-id="lo"]')!.classList.contains("is-low-confidence")).toBe(true);
    expect(container!.querySelector('[data-peak-id="hi"]')!.classList.contains("is-low-confidence")).toBe(false);
  });

  it("offers Copy SVG and Export (JCAMP-DX) actions in the toolbar", () => {
    mount(createElement(LinkedFigureView, { spectrum }));
    const labels = [...container!.querySelectorAll(".lf-btn")].map((button) => button.textContent);
    expect(labels).toContain("Copy SVG");
    expect(labels).toContain("Export");
  });

  it("colors structure shift labels by estimation quality (ChemDraw-style) and shows the legend", () => {
    const qualitySpectrum: PluginLinkedFigureSpectrum = {
      nucleus: "1H",
      domain: { min: 0, max: 8 },
      reversed: true,
      peaks: [
        { id: "a", ppm: 7.3, intensity: 1, label: "7.30", atomIndices: [0], confidence: "high" },
        { id: "b", ppm: 2.4, intensity: 1, label: "2.40", atomIndices: [1], estimated: true }
      ]
    };
    mount(createElement(LinkedFigureView, { spectrum: qualitySpectrum, structure }));
    expect(container!.querySelector('[data-atom-index="0"] .lf-shift-label.is-good')).not.toBeNull();
    expect(container!.querySelector('[data-atom-index="1"] .lf-shift-label.is-rough')).not.toBeNull();
    expect(container!.querySelector(".lf-legend")).not.toBeNull();
  });

  // Regression guard for the update flicker: when a new prediction with a wider ppm domain replaces the
  // previous one in place, the viewport must adopt the new domain in the same render — so a peak that
  // only fits the new domain is drawn immediately, never dropped for a frame under the old window.
  it("adopts a new structure's ppm domain on in-place update (no stale viewport)", () => {
    mount(createElement(LinkedFigureView, { spectrum })); // domain 0–8
    expect(container!.querySelector('[data-peak-id="hi"]')).toBeNull();

    const wider: PluginLinkedFigureSpectrum = {
      nucleus: "1H",
      domain: { min: 0, max: 12 },
      reversed: true,
      peaks: [{ id: "hi", ppm: 11, intensity: 1, label: "11.00", atomIndices: [0] }] // only in-window for 0–12
    };
    rerender(createElement(LinkedFigureView, { spectrum: wider }));

    // The high-ppm peak is present (it would be culled if the viewport were still the old 0–8 window),
    // and the axis now extends past the old domain.
    expect(container!.querySelector('[data-peak-id="hi"]')).not.toBeNull();
    const tickValues = [...container!.querySelectorAll(".lf-tick-label")].map((node) => Number(node.textContent));
    expect(Math.max(...tickValues)).toBeGreaterThan(8);
  });
});
