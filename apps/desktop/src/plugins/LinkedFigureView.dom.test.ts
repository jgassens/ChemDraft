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

  it("resolves a doublet into two distinct lines at a normal zoom (linewidth < coupling)", () => {
    const doublet: PluginLinkedFigureSpectrum = {
      nucleus: "1H",
      domain: { min: 0, max: 3 },
      reversed: true,
      peaks: [{ id: "d", ppm: 1, intensity: 1, label: "1.00", atomIndices: [0], couplings: [{ jHz: 7, partnerCount: 1 }] }]
    };
    mount(createElement(LinkedFigureView, { spectrum: doublet }));
    const path = container!.querySelector<SVGPathElement>(".lf-curve")!.getAttribute("d") ?? "";
    const ys = [...path.matchAll(/[ML][\d.]+\s+([\d.]+)/g)].map((match) => Number(match[1]));
    // A spectrum peak is a local *minimum* in y (y grows downward). A resolved doublet has two of them.
    const peakCount = ys.filter((y, i) => i > 0 && i < ys.length - 1 && y < ys[i - 1] && y < ys[i + 1]).length;
    expect(peakCount).toBeGreaterThanOrEqual(2);
  });

  it("shows the reference solvent and a field selector whose choice retunes the multiplet rendering", () => {
    const coupled: PluginLinkedFigureSpectrum = {
      nucleus: "1H",
      domain: { min: 0, max: 3 },
      reversed: true,
      solvent: "CDCl₃ (predominant reference solvent; mixed corpus)",
      peaks: [{ id: "d", ppm: 1.5, intensity: 1, label: "1.50", atomIndices: [0], couplings: [{ jHz: 7, partnerCount: 1 }] }]
    };
    mount(createElement(LinkedFigureView, { spectrum: coupled }));
    expect(container!.textContent).toContain("Solvent: CDCl₃");

    const select = container!.querySelector<HTMLSelectElement>(".lf-select")!;
    const values = [...select.options].map((option) => option.value);
    expect(values[0]).toBe("300");
    expect(values.at(-1)).toBe("1000");

    // J is fixed in Hz, so a higher field tightens the doublet on the ppm axis → the curve changes.
    const before = container!.querySelector(".lf-curve")!.getAttribute("d");
    act(() => {
      select.value = "1000";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container!.querySelector(".lf-curve")!.getAttribute("d")).not.toBe(before);
  });

  it("cross-check: replaces a disagreeing peak with the increment by default, and shows both on toggle", () => {
    const spec: PluginLinkedFigureSpectrum = {
      nucleus: "1H",
      domain: { min: 0, max: 8 },
      reversed: true,
      peaks: [{ id: "cc", ppm: 2.0, intensity: 1, label: "2.00", atomIndices: [0], confidence: "low", alternativePpm: 2.9 }]
    };
    mount(createElement(LinkedFigureView, { spectrum: spec }));
    // Default = "Prefer increment": a single peak, drawn as the increment variant.
    expect(container!.querySelectorAll("[data-variant]")).toHaveLength(1);
    expect(container!.querySelector('[data-variant="increment"]')).not.toBeNull();

    const uncertain = [...container!.querySelectorAll<HTMLSelectElement>(".lf-select")].find((select) =>
      [...select.options].some((option) => option.value === "both")
    )!;
    act(() => {
      uncertain.value = "both";
      uncertain.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const variants = [...container!.querySelectorAll("[data-variant]")].map((node) => node.getAttribute("data-variant"));
    expect(variants).toContain("primary");
    expect(variants).toContain("increment");
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

  it("offers Copy, Export (JCAMP-DX), and Full size actions in the toolbar", () => {
    mount(createElement(LinkedFigureView, { spectrum }));
    const labels = [...container!.querySelectorAll(".lf-btn")].map((button) => button.textContent);
    expect(labels).toContain("Copy");
    expect(labels).toContain("Export");
    expect(labels).toContain("Full size");
  });

  it("opens an enlarged spectrum modal from Full size, and closes it", () => {
    mount(createElement(LinkedFigureView, { spectrum, structure }));
    expect(document.querySelector(".lf-modal")).toBeNull();

    const fullSize = [...container!.querySelectorAll<HTMLButtonElement>(".lf-btn")].find((b) => b.textContent === "Full size")!;
    act(() => {
      fullSize.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const modal = document.querySelector(".lf-modal");
    expect(modal).not.toBeNull();
    // The modal hosts a second, full-size figure (no nested "Full size" button — no recursion).
    expect(modal!.querySelector(".lf-root.is-fullscreen")).not.toBeNull();
    expect([...modal!.querySelectorAll(".lf-btn")].map((b) => b.textContent)).not.toContain("Full size");

    const close = modal!.querySelector<HTMLButtonElement>(".lf-modal-close")!;
    act(() => {
      close.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.querySelector(".lf-modal")).toBeNull();
  });

  it("shrinks shift labels for a crowded structure but keeps them full-size for a sparse one", () => {
    const shiftAll = (count: number): PluginLinkedFigureSpectrum => ({
      nucleus: "13C",
      domain: { min: 0, max: 200 },
      reversed: true,
      peaks: [{ id: "p", ppm: 128, intensity: 1, label: "128.0", atomIndices: Array.from({ length: count }, (_, i) => i) }]
    });
    const chain = (count: number): PluginLinkedFigureStructure => ({
      atoms: Array.from({ length: count }, (_, i) => ({ index: i, x: i, y: 0, element: "C" })),
      bonds: Array.from({ length: count - 1 }, (_, i) => ({ from: i, to: i + 1, order: 1 }))
    });
    const fontOf = (count: number): number => {
      mount(createElement(LinkedFigureView, { spectrum: shiftAll(count), structure: chain(count) }));
      return parseFloat(container!.querySelector<SVGTextElement>(".lf-shift-label")!.style.fontSize);
    };

    expect(fontOf(2)).toBeGreaterThan(12); // sparse → near the full 14px
    act(() => root!.unmount());
    expect(fontOf(24)).toBeLessThan(9); // crowded → shrunk so numbers don't overlap
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
