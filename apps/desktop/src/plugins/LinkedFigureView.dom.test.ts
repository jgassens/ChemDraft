// @vitest-environment jsdom

import type { PluginLinkedFigureSpectrum, PluginLinkedFigureStructure } from "@chemdraft/plugin-api";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

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

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function tickSpan(): number {
  const ticks = [...container!.querySelectorAll(".lf-tick-label")].map((node) => Number(node.textContent));
  return Math.max(...ticks) - Math.min(...ticks);
}

function pathYs(path: Element): number[] {
  return [...(path.getAttribute("d") ?? "").matchAll(/[ML][\d.]+\s+([\d.]+)/g)].map((match) => Number(match[1]));
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

  it("zooms in with + and back out with − (button directions are not inverted)", () => {
    mount(createElement(LinkedFigureView, { spectrum }));
    const initialSpan = tickSpan();
    click(container!.querySelector('[aria-label="Zoom in"]')!);
    expect(tickSpan()).toBeLessThan(initialSpan);
    expect([...container!.querySelectorAll<HTMLButtonElement>(".lf-btn")].find((button) => button.textContent === "Reset")!.disabled).toBe(
      false
    );

    click(container!.querySelector('[aria-label="Zoom out"]')!);
    expect(tickSpan()).toBe(initialSpan);
  });

  it("does not magnify distant line-shape tails when a zoomed viewport contains no peak", () => {
    const edgePeak: PluginLinkedFigureSpectrum = {
      nucleus: "1H",
      domain: { min: 0, max: 8 },
      reversed: true,
      peaks: [{ id: "edge", ppm: 0, intensity: 1, atomIndices: [0] }]
    };
    mount(createElement(LinkedFigureView, { spectrum: edgePeak }));
    const zoomIn = container!.querySelector('[aria-label="Zoom in"]')!;
    click(zoomIn);
    click(zoomIn);
    click(zoomIn); // centered zoom now excludes the 0 ppm line

    expect(container!.querySelector('[data-peak-id="edge"]')).toBeNull();
    const ys = pathYs(container!.querySelector(".lf-curve")!);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(2);
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

  it("cross-check: keeps the HOSE peak by default, and shows both on toggle", () => {
    const spec: PluginLinkedFigureSpectrum = {
      nucleus: "1H",
      domain: { min: 0, max: 8 },
      reversed: true,
      comparison: { primaryLabel: "HOSE", alternativeLabel: "increment", alternativeMarker: "ᵢ" },
      peaks: [{ id: "cc", ppm: 2.0, intensity: 1, label: "2.00", atomIndices: [0], confidence: "low", alternativePpm: 2.9 }]
    };
    mount(createElement(LinkedFigureView, { spectrum: spec, structure }));
    expect(container!.textContent).toContain("Shift comparison");
    // Default = "Prefer HOSE": a single primary peak and the HOSE structure annotation.
    expect(container!.querySelectorAll("[data-variant]")).toHaveLength(1);
    expect(container!.querySelector('[data-variant="primary"]')).not.toBeNull();
    // Confidence no longer restyles the trace (ADR-0025): the low-confidence peak draws plain.
    expect(container!.querySelector("path.lf-curve")).not.toBeNull();
    expect(container!.querySelector("path.lf-curve.is-low-confidence")).toBeNull();
    expect(container!.querySelector('[data-atom-index="0"] .lf-shift-label')!.textContent).toBe("2.00");
    expect(container!.querySelector(".lf-spectrum-note")!.textContent).not.toContain("orange");

    const uncertain = [...container!.querySelectorAll<HTMLSelectElement>(".lf-select")].find((select) =>
      [...select.options].some((option) => option.value === "both")
    )!;
    expect(uncertain.value).toBe("primary");
    expect(uncertain.selectedOptions[0].textContent).toBe("Prefer HOSE");
    act(() => {
      uncertain.value = "both";
      uncertain.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const variants = [...container!.querySelectorAll("[data-variant]")].map((node) => node.getAttribute("data-variant"));
    expect(variants).toContain("primary");
    expect(variants).toContain("alternative");
    expect(container!.querySelector("path.lf-curve.is-alternative")).not.toBeNull();
    expect(container!.querySelector('[data-atom-index="0"] .lf-shift-label')!.textContent).toBe("2.00 / 2.90ᵢ");
    expect(container!.querySelector('[data-atom-index="0"] .lf-shift-alternative')).not.toBeNull();
    expect(container!.querySelector(".lf-spectrum-note")!.textContent).toContain("dashed orange = increment");
    expect(container!.querySelector(".lf-legend")!.textContent).toContain("HOSE confidence");
  });

  it("keeps a declared comparison visible but disabled when no alternative value is applicable", () => {
    const hoseOnly: PluginLinkedFigureSpectrum = {
      ...spectrum,
      comparison: { primaryLabel: "HOSE", alternativeLabel: "increment", alternativeMarker: "ᵢ" }
    };
    mount(createElement(LinkedFigureView, { spectrum: hoseOnly }));

    expect(container!.textContent).toContain("Shift comparison");
    const comparisonSelect = [...container!.querySelectorAll<HTMLSelectElement>(".lf-select")].find((select) =>
      select.textContent.includes("HOSE only")
    )!;
    expect(comparisonSelect.disabled).toBe(true);
    expect(comparisonSelect.value).toBe("primary");
    expect(comparisonSelect.selectedOptions[0].textContent).toContain("HOSE only — increment not applicable");
    expect(container!.querySelector(".lf-spectrum-note")!.textContent).not.toContain("orange");
  });

  it("resets a stale show-both choice when a rerun loses comparisons and does not restore it later", () => {
    const comparable: PluginLinkedFigureSpectrum = {
      nucleus: "1H",
      domain: { min: 0, max: 8 },
      comparison: { primaryLabel: "HOSE", alternativeLabel: "increment", alternativeMarker: "ᵢ" },
      peaks: [{ id: "first", ppm: 2, alternativePpm: 2.9, intensity: 1, atomIndices: [0] }]
    };
    mount(createElement(LinkedFigureView, { spectrum: comparable }));
    const comparisonSelect = [...container!.querySelectorAll<HTMLSelectElement>(".lf-select")].find((select) =>
      [...select.options].some((option) => option.value === "both")
    )!;
    act(() => {
      comparisonSelect.value = "both";
      comparisonSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container!.querySelector('[data-variant="alternative"]')).not.toBeNull();

    rerender(
      createElement(LinkedFigureView, {
        spectrum: { ...comparable, peaks: [{ id: "second", ppm: 3, intensity: 1, atomIndices: [0] }] }
      })
    );
    const disabled = [...container!.querySelectorAll<HTMLSelectElement>(".lf-select")].find((select) => select.disabled)!;
    expect(disabled.value).toBe("primary");
    expect(container!.querySelector('[data-variant="alternative"]')).toBeNull();

    rerender(
      createElement(LinkedFigureView, {
        spectrum: {
          ...comparable,
          peaks: [{ id: "third", ppm: 4, alternativePpm: 4.2, intensity: 1, atomIndices: [0] }]
        }
      })
    );
    const restored = [...container!.querySelectorAll<HTMLSelectElement>(".lf-select")].find((select) =>
      [...select.options].some((option) => option.value === "both")
    )!;
    expect(restored.value).toBe("primary");
    expect(container!.querySelector('[data-variant="alternative"]')).toBeNull();
  });

  it("supports legacy alternative peaks that did not declare provider labels", () => {
    const legacy: PluginLinkedFigureSpectrum = {
      nucleus: "1H",
      domain: { min: 0, max: 8 },
      peaks: [{ id: "legacy", ppm: 2, alternativePpm: 2.2, intensity: 1, atomIndices: [0] }]
    };
    mount(createElement(LinkedFigureView, { spectrum: legacy }));
    expect(container!.textContent).toContain("Shift comparison");
    expect(container!.textContent).toContain("Prefer primary");
  });

  it("expands the plotting domain so an out-of-domain cross-check value remains visible", () => {
    const spec: PluginLinkedFigureSpectrum = {
      nucleus: "1H",
      domain: { min: 1.5, max: 4 },
      reversed: true,
      peaks: [{ id: "outside", ppm: 2.52, alternativePpm: 0.7, intensity: 1, atomIndices: [0], confidence: "low" }]
    };
    mount(createElement(LinkedFigureView, { spectrum: spec }));

    expect(container!.querySelector('[data-peak-id="outside"]')).not.toBeNull();
    const ticks = [...container!.querySelectorAll(".lf-tick-label")].map((node) => Number(node.textContent));
    expect(Math.min(...ticks)).toBeLessThan(1.5);
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
    expect(container!.querySelector("path.lf-curve.is-estimated")).not.toBeNull();
  });

  it("renders a low-confidence peak exactly like any other in the spectrum (confidence lives in structure labels/table)", () => {
    const mixed: PluginLinkedFigureSpectrum = {
      nucleus: "1H",
      domain: { min: 0, max: 10 },
      reversed: true,
      peaks: [
        { id: "lo", ppm: 3.1, intensity: 1, label: "3.10", atomIndices: [0], confidence: "low" },
        { id: "hi", ppm: 7.3, intensity: 1, label: "7.30", atomIndices: [1], confidence: "high" }
      ]
    };
    mount(createElement(LinkedFigureView, { spectrum: mixed, structure }));
    // ADR-0025: the spectrum trace and its labels are confidence-blind. Confidence still colors the
    // molecular shift labels (asserted below via the quality classes) and the table elsewhere.
    expect(container!.querySelector('[data-peak-id="lo"]')!.classList.contains("is-low-confidence")).toBe(false);
    expect(container!.querySelector('[data-peak-id="hi"]')!.classList.contains("is-low-confidence")).toBe(false);
    expect(container!.querySelector('[data-peak-id="lo"] .lf-peak-label')?.textContent).toBe("3.10");
    expect(container!.querySelector('[data-peak-id="hi"] .lf-peak-label')?.textContent).toBe("7.30");
    expect([...container!.querySelectorAll(".lf-shift-label")].map((node) => node.textContent)).toEqual(
      expect.arrayContaining(["3.10", "7.30"])
    );
    expect(container!.querySelector("path.lf-curve.is-low-confidence")).toBeNull();
    expect(container!.querySelector('[data-atom-index="0"] .lf-shift-label.is-rough')).not.toBeNull();
    expect(container!.querySelector('[data-atom-index="1"] .lf-shift-label.is-good')).not.toBeNull();
    expect(container!.querySelector(".lf-spectrum-note")!.textContent).not.toContain("lower confidence");
  });

  it("places a multiplet label above the true line apex rather than in the center valley", () => {
    const doublet: PluginLinkedFigureSpectrum = {
      nucleus: "1H",
      domain: { min: 0.9, max: 1.1 },
      reversed: true,
      peaks: [{ id: "d", ppm: 1, intensity: 1, atomIndices: [0], couplings: [{ jHz: 7, partnerCount: 1 }] }]
    };
    mount(createElement(LinkedFigureView, { spectrum: doublet }));
    const apexY = Math.min(...pathYs(container!.querySelector(".lf-curve")!));
    const labelY = Number(container!.querySelector('[data-peak-id="d"] .lf-peak-label')!.getAttribute("y"));
    expect(labelY).toBeLessThan(apexY);
  });

  it("offers Copy, Export (JCAMP-DX), and Full size actions in the toolbar", () => {
    mount(createElement(LinkedFigureView, { spectrum }));
    const labels = [...container!.querySelectorAll(".lf-btn")].map((button) => button.textContent);
    expect(labels).toContain("Copy");
    expect(labels).toContain("Export");
    expect(labels).toContain("Full size");
  });

  it("labels intensity honestly and shows the nucleus-specific observe frequency", () => {
    const carbon = { ...spectrum, nucleus: "13C" };
    mount(createElement(LinkedFigureView, { spectrum: carbon }));
    expect(container!.textContent).toContain("Proton-rated field");
    expect(container!.textContent).toContain("Observe ¹³C: 75.43 MHz");
    expect(container!.querySelector(".lf-spectrum")!.getAttribute("data-observe-frequency-mhz")).toBe("75.43");
    expect(container!.querySelector(".lf-spectrum-note")!.textContent).toContain(
      "predicted equivalent nuclei (not experimental integration)"
    );
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
    expect(container!.querySelector(".lf-legend")!.textContent).toContain("prediction confidence");
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

  it("preserves zoom for an identical rerun but resets for a different spectrum with the same domain", () => {
    mount(createElement(LinkedFigureView, { spectrum }));
    click(container!.querySelector('[aria-label="Zoom in"]')!);
    const zoomedSpan = tickSpan();
    const resetButton = (): HTMLButtonElement =>
      [...container!.querySelectorAll<HTMLButtonElement>(".lf-btn")].find((button) => button.textContent === "Reset")!;
    expect(resetButton().disabled).toBe(false);

    // A value-identical result object represents a rerun of the same prediction; keep the user's view.
    rerender(createElement(LinkedFigureView, { spectrum: structuredClone(spectrum) }));
    expect(tickSpan()).toBe(zoomedSpan);
    expect(resetButton().disabled).toBe(false);

    // Same bounds, different peak data: this is a new spectrum and must start from its full domain.
    const different: PluginLinkedFigureSpectrum = {
      ...spectrum,
      peaks: [{ id: "new", ppm: 4.1, intensity: 1, atomIndices: [0] }]
    };
    rerender(createElement(LinkedFigureView, { spectrum: different }));
    expect(resetButton().disabled).toBe(true);
    expect(tickSpan()).toBeGreaterThan(zoomedSpan);
  });

  it("coalesces rapid pointer-pan moves into one viewport update per animation frame", () => {
    const callbacks: FrameRequestCallback[] = [];
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const originalCancelAnimationFrame = window.cancelAnimationFrame;
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    Object.defineProperty(window, "requestAnimationFrame", { configurable: true, value: requestFrame });
    Object.defineProperty(window, "cancelAnimationFrame", { configurable: true, value: vi.fn() });

    try {
      mount(createElement(LinkedFigureView, { spectrum }));
      click(container!.querySelector('[aria-label="Zoom in"]')!); // leave room to pan
      const svg = container!.querySelector<SVGSVGElement>(".lf-spectrum")!;
      vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 680,
        bottom: 240,
        width: 680,
        height: 240,
        toJSON: () => ({})
      });
      act(() => {
        svg.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 100 }));
        svg.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 110 }));
        svg.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 125 }));
        svg.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 140 }));
      });
      expect(requestFrame).toHaveBeenCalledOnce();
      act(() => callbacks[0](0));
    } finally {
      Object.defineProperty(window, "requestAnimationFrame", {
        configurable: true,
        value: originalRequestAnimationFrame
      });
      Object.defineProperty(window, "cancelAnimationFrame", {
        configurable: true,
        value: originalCancelAnimationFrame
      });
    }
  });
});
