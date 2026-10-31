// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginLinkedFigureSpectrum, PluginLinkedFigureStructure } from "@chemdraft/plugin-api";
import {
  annotationLabelBoxesOverlap,
  estimateAnnotationTextWidth,
  type AnnotationLabelBox
} from "@chemdraft/layout-engine";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSpectrumEnvelope, LinkedFigureView, restoreLinkedFigureWindowFrame, sampleStyledEnvelope } from "./LinkedFigureView";
import { exportSpectrumFigure, saveTextFile, standaloneSpectrumSvg } from "./spectrumExport";
import { installPluginPanelInputFocus } from "./pluginPanelInputFocus";

const nativePanel = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  notify: undefined as ((event: { payload: { enabled: boolean } }) => void) | undefined
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: nativePanel.invoke }));
vi.mock("../window-manager/tauriEvents", () => ({ listenCurrentWindowEvent: nativePanel.listen }));
vi.mock("./spectrumExport", async (importOriginal) => ({
  ...await importOriginal<typeof import("./spectrumExport")>(),
  copySpectrumToClipboard: vi.fn(), exportSpectrumFigure: vi.fn(), saveTextFile: vi.fn()
}));

beforeEach(() => {
  nativePanel.invoke.mockImplementation(async (_command: string, args: { enabled: boolean }) => ({ enabled: args.enabled }));
  nativePanel.listen.mockImplementation(async (_event: string, handler: typeof nativePanel.notify) => {
    nativePanel.notify = handler;
    return nativePanel.unlisten;
  });
  nativePanel.notify = undefined;
  vi.mocked(exportSpectrumFigure).mockResolvedValue("saved");
  vi.mocked(saveTextFile).mockResolvedValue("saved");
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = undefined;
  container = undefined;
  delete (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__;
  vi.clearAllMocks();
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

async function enlargeNativeFigure(): Promise<void> {
  await act(async () => {
    [...container!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Full size")!.click();
    await vi.waitFor(() => expect(nativePanel.invoke).toHaveBeenCalled(), { interval: 1 });
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

function textBox(node: SVGTextElement): AnnotationLabelBox {
  const fontSize = parseFloat(node.style.fontSize);
  const width = estimateAnnotationTextWidth(node.textContent ?? "", fontSize);
  const centered = node.getAttribute("text-anchor") === "middle";
  return {
    x: Number(node.getAttribute("x")) - (centered ? width / 2 : 0),
    y: Number(node.getAttribute("y")) - fontSize,
    width, height: fontSize * 1.25
  };
}

function expectSeparateLabels(selector: string): AnnotationLabelBox[] {
  const boxes = [...container!.querySelectorAll<SVGTextElement>(selector)].map(textBox);
  for (const [index, box] of boxes.entries()) {
    for (const other of boxes.slice(index + 1)) expect(annotationLabelBoxesOverlap(box, other)).toBe(false);
  }
  return boxes;
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
  it.each([8, 200])("preserves sampled heights, provenance and apex heights over a %s ppm range", (max) => {
    const lines = Array.from({ length: 320 }, (_, index) => ({
      ppm: [7.30, 7.30, 7.25, 2.61, 1.21][Math.floor(index / 32) % 5] / 8 * max + (index % 32 - 15.5) * 0.003,
      amp: (index % 5 + 1) / 5,
      peakId: `p${Math.floor(index / 32)}`,
      style: (["trusted", "estimated", "alternative"] as const)[index % 3]
    }));
    const halfWidth = max / 1288;
    const envelope = createSpectrumEnvelope(lines, halfWidth);
    const direct = (ppm: number) => {
      const result = { total: 0, byStyle: { trusted: 0, estimated: 0, alternative: 0 } };
      for (const line of lines) {
        const d = (ppm - line.ppm) / halfWidth;
        const height = line.amp * (0.3 / (1 + d * d) + 0.7 * Math.exp(-Math.LN2 * d * d));
        result.total += height;
        result.byStyle[line.style] += height;
      }
      return result;
    };
    const equalToRounding = (actual: number, expected: number): void => {
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Number.EPSILON * 32 * Math.max(1, expected));
    };
    for (const reversed of [true, false]) {
      const sample = sampleStyledEnvelope(lines, { min: 0, max }, reversed, halfWidth, 0.25);
      for (let index = 0; index < sample.xs.length; index += 1) {
        const fraction = (sample.xs[index] - 18) / 644;
        const expected = direct((reversed ? 1 - fraction : fraction) * max);
        equalToRounding(sample.totals[index], expected.total);
        for (const style of ["trusted", "estimated", "alternative"] as const) {
          equalToRounding(sample.byStyle[style][index], expected.byStyle[style]);
        }
      }
    }
    for (const line of lines) equalToRounding(envelope(line.ppm).total, direct(line.ppm).total);
    expect(envelope(0).total).toBeGreaterThan(0); // Lorentzian tails must never be cut off.
    const small = lines.slice(0, 32);
    expect(createSpectrumEnvelope(small, halfWidth)(small[0].ppm).total).toBe(
      small.reduce((sum, line) => {
        const d = (small[0].ppm - line.ppm) / halfWidth;
        return sum + line.amp * (0.3 * (1 / (1 + d * d)) + 0.7 * Math.exp(-Math.LN2 * d * d));
      }, 0)
    );
  });

  it("ignores non-finite report numbers before they can reach SVG geometry", () => {
    mount(createElement(LinkedFigureView, {
      defaultSpectrometerMHz: Infinity,
      spectrum: {
        ...spectrum, domain: { min: -Infinity, max: Infinity },
        peaks: [...spectrum.peaks,
          { id: "bad-ppm", ppm: Infinity, intensity: 1, atomIndices: [0] },
          { id: "bad-height", ppm: 3, intensity: Infinity, atomIndices: [0] },
          { id: "nan", ppm: NaN, intensity: 1, atomIndices: [0] },
          { id: "coupling", ppm: 4, alternativePpm: Infinity, intensity: 1, atomIndices: [0],
            couplings: [{ jHz: Infinity, partnerCount: 1 }, { jHz: NaN, partnerCount: 1 }] }]
      },
      structure: { atoms: [...structure.atoms, { index: 3, x: Infinity, y: NaN, element: "N" }],
        bonds: [...structure.bonds, { from: 0, to: 3, order: 1 }] }
    }));
    expect(container!.innerHTML).not.toMatch(/NaN|Infinity/);
    expect(container!.querySelectorAll(".lf-peak")).toHaveLength(3);
    expect(container!.querySelectorAll(".lf-atom")).toHaveLength(3);
    expect(container!.querySelector(".lf-spectrum")!.getAttribute("data-observe-frequency-mhz")).toBe("300");
    const valid = [{ ppm: 2, amp: 1, peakId: "a", style: "trusted" as const }];
    const dirty = [...valid, { ...valid[0], ppm: Infinity }, { ...valid[0], amp: NaN }];
    expect(createSpectrumEnvelope(dirty, 0.01)(2)).toEqual(createSpectrumEnvelope(valid, 0.01)(2));
    expect(createSpectrumEnvelope(dirty, 0.01)(NaN).total).toBe(0);
  });

  it("evaluates all 128,000 apexes even when hostile lines cluster inside one half-width", () => {
    const lines = Array.from({ length: 128000 }, (_, index) => ({
      ppm: 7 + index / 128000 * 0.0001, amp: 1, peakId: `p${index}`, style: "trusted" as const
    }));
    const start = performance.now();
    const envelope = createSpectrumEnvelope(lines, 0.01);
    let max = 0;
    for (const line of lines) max = Math.max(max, envelope(line.ppm).total);
    expect(performance.now() - start).toBeLessThan(2500);
    expect(max).toBeGreaterThan(127000);
    for (const ppm of [7, 7.00005, 7.0001, 6.9, 7.1]) {
      let expected = 0;
      for (const line of lines) {
        const d = (ppm - line.ppm) / 0.01;
        expected += 0.3 / (1 + d * d) + 0.7 * Math.exp(-Math.LN2 * d * d);
      }
      expect(envelope(ppm).total).toBeCloseTo(expected, 7);
    }
  });

  it("keeps normalized geometry finite when finite amplitudes would overflow their sum", () => {
    const large: PluginLinkedFigureSpectrum = {
      ...spectrum, peaks: spectrum.peaks.map((peak) => ({ ...peak, intensity: Number.MAX_VALUE }))
    };
    mount(createElement(LinkedFigureView, { spectrum: large }));
    expect(container!.innerHTML).not.toMatch(/NaN|Infinity/);
    const ys = pathYs(container!.querySelector(".lf-curve")!);
    expect(ys.some((y) => y < 100)).toBe(true);
    expect(container!.querySelectorAll(".lf-peak")).toHaveLength(2);
  });

  it("renders 4,000 peaks, 128,000 lines, 4,000 atoms and 8,000 bonds in a few seconds", () => {
    const hostile: PluginLinkedFigureSpectrum = {
      nucleus: "1H", domain: { min: 0, max: 10 },
      peaks: Array.from({ length: 4000 }, (_, index) => ({
        id: `p${index}`, ppm: 0.5 + index / 450, intensity: 1, atomIndices: [index],
        couplings: Array.from({ length: 5 }, (_, coupling) => ({ jHz: 1 + coupling, partnerCount: 1 }))
      }))
    };
    const start = performance.now();
    mount(createElement(LinkedFigureView, {
      spectrum: hostile,
      structure: {
        atoms: Array.from({ length: 4000 }, (_, index) => ({ index, x: index % 80, y: Math.floor(index / 80), element: "C" })),
        bonds: Array.from({ length: 8000 }, (_, index) => ({ from: index % 4000, to: (index + 1) % 4000, order: 1 }))
      }
    }));
    expect(performance.now() - start).toBeLessThan(4000);
    expect(container!.querySelectorAll(".lf-peak")).toHaveLength(4000);
    expect(container!.querySelectorAll('[data-line-count="32"]')).toHaveLength(4000);
    expect(container!.querySelectorAll(".lf-atom")).toHaveLength(4000);
    expect(container!.querySelectorAll(".lf-shift-label")).toHaveLength(4000);
    expect(container!.querySelectorAll(".lf-bond")).toHaveLength(8000);
  }, 8000);

  it.each([
    { nucleus: "13C", max: 200, shifts: [140.85, 137.56, 127.34, 126.89, 45.12, 45.01] },
    { nucleus: "1H", max: 8, shifts: [7.30, 7.30, 7.25, 2.61, 1.21] }
  ])("separates $nucleus peak labels and axis text through zoom and pan", ({ nucleus, max, shifts }) => {
    const spec: PluginLinkedFigureSpectrum = {
      nucleus, domain: { min: 0, max },
      peaks: shifts.map((ppm, index) => ({ id: `p${index}`, ppm, intensity: 1, label: ppm.toFixed(2), atomIndices: [index] }))
    };
    mount(createElement(LinkedFigureView, { spectrum: spec }));
    expect(container!.querySelectorAll(".lf-peak-label")).toHaveLength(shifts.length);
    const svg = container!.querySelector<SVGSVGElement>(".lf-spectrum")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ left: 0, width: 680 } as DOMRect);
    for (let zoom = 0; zoom < 15; zoom += 1) {
      for (const box of expectSeparateLabels(".lf-peak-label")) {
        expect(box.x).toBeGreaterThanOrEqual(18);
        expect(box.y).toBeGreaterThanOrEqual(18);
        expect(box.x + box.width).toBeLessThanOrEqual(662);
        expect(box.y + box.height).toBeLessThan(210);
      }
      const caption = textBox(container!.querySelector<SVGTextElement>(".lf-axis-caption")!);
      for (const tick of container!.querySelectorAll<SVGTextElement>(".lf-tick-label")) {
        expect(annotationLabelBoxesOverlap(caption, textBox(tick))).toBe(false);
      }
      act(() => svg.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, clientX: 680 * (1 - shifts[0] / max), bubbles: true, cancelable: true })));
    }
    act(() => svg.dispatchEvent(new WheelEvent("wheel", { deltaX: 50, bubbles: true, cancelable: true })));
    expectSeparateLabels(".lf-peak-label");
  });

  it("keeps the tallest labels on overflow, with hover, keyboard and atom links for every peak", () => {
    const dense: PluginLinkedFigureSpectrum = {
      nucleus: "1H", domain: { min: 0, max: 8 },
      peaks: Array.from({ length: 30 }, (_, index) => ({
        id: `dense${index}`, ppm: 4, intensity: index + 1, label: `4.00 (${index})`, atomIndices: [index % 3]
      }))
    };
    mount(createElement(LinkedFigureView, { spectrum: dense, structure }));
    expect(container!.querySelectorAll(".lf-peak")).toHaveLength(30);
    expect(container!.querySelectorAll(".lf-peak-label")).toHaveLength(10);
    expectSeparateLabels(".lf-peak-label");
    for (let index = 0; index < 30; index += 1) {
      const group = container!.querySelector(`[data-peak-id="dense${index}"]`)!;
      expect(group.querySelector(".lf-peak-label") !== null).toBe(index >= 20);
      expect(group.querySelector("title")!.textContent).toBe(`4.00 (${index}) ppm`);
      expect(group.getAttribute("tabindex")).toBe("0");
    }
    hover(container!.querySelector('[data-peak-id="dense0"]')!);
    expect(isActive('[data-atom-index="0"]')).toBe(true);
    hover(container!.querySelector('[data-atom-index="1"]')!);
    expect(isActive('[data-peak-id="dense1"]')).toBe(true);
    act(() => container!.querySelector<SVGGElement>('[data-peak-id="dense2"]')!.focus());
    expect(isActive('[data-atom-index="2"]')).toBe(true);
  });

  it("preserves leader lines, annotation sizes and the honesty note in the standalone clone", () => {
    mount(createElement(LinkedFigureView, { spectrum }));
    const svg = container!.querySelector<SVGSVGElement>(".lf-spectrum")!;
    const exported = new DOMParser().parseFromString(standaloneSpectrumSvg(svg), "text/html");
    expect(exported.querySelectorAll(".lf-label-leader")).toHaveLength(2);
    for (const line of exported.querySelectorAll(".lf-label-leader")) {
      expect(line.getAttribute("stroke")).toBe("#8a8f98");
      expect(line.getAttribute("stroke-width")).toBe("0.6");
    }
    expect(exported.querySelector<SVGTextElement>(".lf-peak-label")!.style.fontSize).toBe("13px");
    expect(exported.querySelector(".lf-spectrum-note")!.textContent).toBe(svg.querySelector(".lf-spectrum-note")!.textContent);
  });

  it("breaks equal-height overflow ties by ppm independently of report order", () => {
    const peaks = Array.from({ length: 15 }, (_, index) => ({
      id: `tie${index}`, ppm: 4 + index * 0.00001, intensity: 1, label: `peak ${index}`, atomIndices: [0]
    }));
    const spec: PluginLinkedFigureSpectrum = { nucleus: "1H", domain: { min: 0, max: 8 }, peaks: [...peaks].reverse() };
    mount(createElement(LinkedFigureView, { spectrum: spec }));
    const placements = (): Record<string, AnnotationLabelBox> => Object.fromEntries(
      [...container!.querySelectorAll<SVGTextElement>(".lf-peak-label")].map((node) => [node.textContent!, textBox(node)])
    );
    const before = placements();
    expect(Object.keys(before).sort()).toEqual(peaks.slice(0, 10).map((peak) => peak.label).sort());
    rerender(createElement(LinkedFigureView, { spectrum: { ...spec, peaks } }));
    expect(placements()).toEqual(before);
  });

  it("fits a crowded explicit-H structure and its shifts clear of atoms and other shifts", () => {
    const atoms = Array.from({ length: 32 }, (_, index) => ({
      index, x: Math.cos(index * Math.PI / 8) * (index < 16 ? 1 : 1.5),
      y: Math.sin(index * Math.PI / 8) * (index < 16 ? 1 : 1.5), element: index < 16 ? "C" : "H"
    }));
    const crowded: PluginLinkedFigureStructure = {
      atoms, bonds: atoms.slice(1).map((atom) => ({ from: atom.index - 1, to: atom.index, order: 1 }))
    };
    const spec: PluginLinkedFigureSpectrum = {
      ...spectrum, peaks: [{ id: "h", ppm: 7.3, intensity: 1, label: "7.30", atomIndices: atoms.map((atom) => atom.index) }]
    };
    mount(createElement(LinkedFigureView, { spectrum: spec, structure: crowded }));
    expect(container!.querySelectorAll(".lf-shift-label")).toHaveLength(atoms.length);
    const boxes = expectSeparateLabels(".lf-shift-label");
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(340);
      expect(box.y + box.height).toBeLessThanOrEqual(260);
      for (const atom of container!.querySelectorAll<SVGCircleElement>(".lf-atom > .lf-hit")) {
        const fontSize = parseFloat(container!.querySelector<SVGTextElement>(".lf-atom-label")!.style.fontSize);
        const radius = fontSize / 15 * 13;
        expect(annotationLabelBoxesOverlap(box, {
          x: Number(atom.getAttribute("cx")) - radius, y: Number(atom.getAttribute("cy")) - radius,
          width: radius * 2, height: radius * 2
        })).toBe(false);
      }
    }
    for (const line of container!.querySelectorAll(".lf-bond line")) {
      for (const attr of ["x1", "x2"]) expect(Number(line.getAttribute(attr))).toBeGreaterThanOrEqual(0);
      for (const attr of ["x1", "x2"]) expect(Number(line.getAttribute(attr))).toBeLessThanOrEqual(340);
      for (const attr of ["y1", "y2"]) expect(Number(line.getAttribute(attr))).toBeGreaterThanOrEqual(0);
      for (const attr of ["y1", "y2"]) expect(Number(line.getAttribute(attr))).toBeLessThanOrEqual(260);
    }
  });

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

  it("fills the web panel from Full size, and closes it", async () => {
    mount(createElement(LinkedFigureView, { spectrum, structure }));
    expect(document.querySelector(".lf-modal")).toBeNull();

    const fullSize = [...container!.querySelectorAll<HTMLButtonElement>(".lf-btn")].find((b) => b.textContent === "Full size")!;
    act(() => {
      fullSize.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const modal = document.querySelector(".lf-modal");
    expect(modal).not.toBeNull();
    // The same figure state fills the panel, with its exit button in the toolbar.
    expect(modal!.querySelector(".lf-root.is-fullscreen")).not.toBeNull();
    expect([...modal!.querySelectorAll(".lf-btn")].map((b) => b.textContent)).not.toContain("Full size");

    const close = modal!.querySelector<HTMLButtonElement>(".lf-modal-close")!;
    await act(async () => {
      close.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.querySelector(".lf-modal")).toBeNull();
  });

  it("claims Escape for Full size before any window-level handler sees it", async () => {
    // A report window's own Escape handler (registered earlier, bubbling) skips a defaultPrevented key.
    const outer = vi.fn((event: KeyboardEvent) => event.defaultPrevented);
    window.addEventListener("keydown", outer);
    try {
      mount(createElement(LinkedFigureView, { spectrum, structure }));
      const fullSize = [...container!.querySelectorAll<HTMLButtonElement>(".lf-btn")].find(
        (b) => b.textContent === "Full size"
      )!;
      act(() => {
        fullSize.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(document.querySelector(".lf-modal")).not.toBeNull();

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      });
      expect(document.querySelector(".lf-modal")).toBeNull();
      expect(outer.mock.results[0]?.value).toBe(true);

      // With the overlay gone, Escape is no longer claimed and reaches the window untouched.
      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      });
      expect(outer.mock.results[1]?.value).toBe(false);
    } finally {
      window.removeEventListener("keydown", outer);
    }
  });

  it.each(["button", "Escape", "panel close"])("uses the native full size command to enter and exit on %s", async (exit) => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    mount(createElement(LinkedFigureView, { spectrum, structure }));
    await enlargeNativeFigure();
    expect(nativePanel.invoke).toHaveBeenCalledWith("set_plugin_panel_full_size", {
      enabled: true, width: 2072, height: 700
    });
    expect(nativePanel.listen).toHaveBeenCalledWith("chemdraft://plugin-panel-full-size", expect.any(Function));
    expect(document.querySelectorAll(".lf-spectrum")).toHaveLength(1);
    await act(async () => {
      if (exit === "panel close") await restoreLinkedFigureWindowFrame();
      else if (exit === "Escape") window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
      else document.querySelector<HTMLButtonElement>(".lf-modal-close")!.click();
    });
    expect(nativePanel.invoke).toHaveBeenLastCalledWith("set_plugin_panel_full_size", {
      enabled: false, width: 0, height: 0
    });
    expect(document.querySelector(".lf-modal")).toBeNull();
  });

  it("uses the returned full size state", async () => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    nativePanel.invoke.mockResolvedValueOnce({ enabled: false });
    mount(createElement(LinkedFigureView, { spectrum }));
    await enlargeNativeFigure();
    expect(document.querySelector(".lf-modal")).toBeNull();
    expect(nativePanel.invoke).toHaveBeenCalledWith("set_plugin_panel_full_size", {
      enabled: true, width: 1392, height: 660
    });
  });

  it("does not expand an idle figure when another figure enlarges the native panel", async () => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    mount(createElement(LinkedFigureView, { spectrum }));
    await act(async () => nativePanel.notify!({ payload: { enabled: true } }));
    expect(document.querySelector(".lf-modal")).toBeNull();
    expect(nativePanel.invoke).not.toHaveBeenCalled();
  });

  it.each(["close", "hide", "quit"])("leaves full size and closes Export when native ends it on %s", async () => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    mount(createElement(LinkedFigureView, { spectrum }));
    await enlargeNativeFigure();
    click(document.querySelector('.lf-modal [aria-haspopup="menu"]')!);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    act(() => nativePanel.notify!({ payload: { enabled: false } }));
    expect(document.querySelector(".lf-modal")).toBeNull();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await act(async () => root!.unmount());
    root = undefined;
    expect(nativePanel.unlisten).toHaveBeenCalledTimes(1);
  });

  it("does not reopen full size when a command reply arrives after the native end event", async () => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    let finishResize!: (status: { enabled: boolean }) => void;
    nativePanel.invoke.mockImplementationOnce(() => new Promise((resolve) => { finishResize = resolve; }));
    mount(createElement(LinkedFigureView, { spectrum }));
    await enlargeNativeFigure();
    await act(async () => {
      nativePanel.notify!({ payload: { enabled: false } });
      finishResize({ enabled: true });
    });
    expect(document.querySelector(".lf-modal")).toBeNull();
  });

  it("finishes an in-flight enlargement before restoring for close", async () => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    let finishResize!: (status: { enabled: boolean }) => void;
    nativePanel.invoke.mockImplementationOnce(() => new Promise((resolve) => { finishResize = resolve; }));
    mount(createElement(LinkedFigureView, { spectrum }));
    await enlargeNativeFigure();
    let restored = false;
    const closing = restoreLinkedFigureWindowFrame().then(() => { restored = true; });
    await Promise.resolve();
    expect(restored).toBe(false);
    expect(nativePanel.invoke).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishResize({ enabled: true });
      await closing;
    });
    expect(nativePanel.invoke).toHaveBeenLastCalledWith("set_plugin_panel_full_size", {
      enabled: false, width: 0, height: 0
    });
  });

  it("fills the panel when native enlargement fails and allows exiting", async () => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    nativePanel.invoke.mockRejectedValueOnce(new Error("Enlargement unavailable"));
    mount(createElement(LinkedFigureView, { spectrum }));
    await enlargeNativeFigure();
    expect(document.querySelector(".lf-modal")!.textContent).toContain("The figure fills this panel");
    await act(async () => document.querySelector<HTMLButtonElement>(".lf-modal-close")!.click());
    expect(nativePanel.invoke).toHaveBeenLastCalledWith("set_plugin_panel_full_size", {
      enabled: false, width: 0, height: 0
    });
    expect(document.querySelector(".lf-modal")).toBeNull();
  });

  it("keeps full size open and reports a failed native restore so it can be retried", async () => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    mount(createElement(LinkedFigureView, { spectrum }));
    await enlargeNativeFigure();
    nativePanel.invoke.mockRejectedValueOnce(new Error("Restore unavailable"));
    await act(async () => document.querySelector<HTMLButtonElement>(".lf-modal-close")!.click());
    expect(document.querySelector(".lf-modal")!.textContent).toContain("Try leaving full size again");
    await act(async () => document.querySelector<HTMLButtonElement>(".lf-modal-close")!.click());
    expect(document.querySelector(".lf-modal")).toBeNull();
  });

  it("keeps zoom, field and wheel interaction when entering and leaving full size", async () => {
    mount(createElement(LinkedFigureView, { spectrum }));
    click(container!.querySelector('[aria-label="Zoom in"]')!);
    const before = tickSpan();
    const field = container!.querySelector<HTMLSelectElement>("select")!;
    act(() => {
      field.value = "600";
      field.dispatchEvent(new Event("change", { bubbles: true }));
    });
    click([...container!.querySelectorAll("button")].find((button) => button.textContent === "Full size")!);
    const svg = document.querySelector<SVGSVGElement>(".lf-modal .lf-spectrum")!;
    expect(svg.getAttribute("data-observe-frequency-mhz")).toBe("600");
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ left: 0, width: 680 } as DOMRect);
    act(() => svg.dispatchEvent(new WheelEvent("wheel", { deltaY: -1000, clientX: 340, bubbles: true, cancelable: true })));
    await act(async () => document.querySelector<HTMLButtonElement>(".lf-modal-close")!.click());
    expect(tickSpan()).toBeLessThan(before);
    expect(container!.querySelector<HTMLSelectElement>("select")!.value).toBe("600");
  });

  it.each(["jdx", "png", "svg", "pdf"] as const)("exports %s through the existing save path", async (format) => {
    mount(createElement(LinkedFigureView, { spectrum }));
    const owner = container!.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
    expect(owner.hasAttribute("aria-controls")).toBe(false);
    click(owner);
    const menu = document.getElementById(owner.getAttribute("aria-controls")!)!;
    expect(menu.dataset.pluginPanelInputMenu).toBe("true");
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(items.map((item) => item.textContent)).toEqual(["JCAMP-DX (.jdx)", "PNG", "SVG", "PDF"]);
    expect(document.activeElement).toBe(items[0]);
    await act(async () => items[["jdx", "png", "svg", "pdf"].indexOf(format)].click());
    if (format === "jdx") {
      expect(saveTextFile).toHaveBeenCalledWith("predicted-1H-nmr.jdx", expect.stringContaining("##JCAMP-DX="),
        expect.objectContaining({ extensions: ["jdx", "dx"] }));
      expect(exportSpectrumFigure).not.toHaveBeenCalled();
    } else {
      expect(exportSpectrumFigure).toHaveBeenCalledWith(format, expect.stringContaining('<svg'), "1H");
      expect(saveTextFile).not.toHaveBeenCalled();
    }
    expect(owner.textContent).toBe("Exported");
    expect(container!.querySelector('[role="status"]')!.textContent).toBe("Spectrum saved.");
    expect(document.activeElement).toBe(owner);
    expect(owner.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(menu.id)).toBeNull();
  });

  it.each(["jdx", "png", "svg", "pdf"] as const)("reports cancelled and failed %s exports", async (format) => {
    mount(createElement(LinkedFigureView, { spectrum }));
    const exporter = format === "jdx" ? vi.mocked(saveTextFile) : vi.mocked(exportSpectrumFigure);
    for (const outcome of ["cancelled", "failed"] as const) {
      exporter.mockResolvedValueOnce(outcome);
      click(container!.querySelector('[aria-haspopup="menu"]')!);
      const items = container!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
      await act(async () => items[["jdx", "png", "svg", "pdf"].indexOf(format)].click());
      expect(container!.querySelector('[role="status"]')!.textContent).toBe(outcome === "cancelled" ? "Export cancelled." : "Spectrum export failed.");
    }
  });

  it("disables export with a reason while saving and handles rejected saves", async () => {
    let rejectSave!: (reason: Error) => void;
    vi.mocked(exportSpectrumFigure).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject; }));
    mount(createElement(LinkedFigureView, { spectrum }));
    const owner = container!.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
    click(owner);
    click(container!.querySelectorAll('[role="menuitem"]')[1]);
    expect(owner.disabled).toBe(true);
    expect(owner.title).toBe("Saving the spectrum");
    await act(async () => rejectSave(new Error("Save failed")));
    expect(owner.disabled).toBe(false);
    expect(owner.textContent).toBe("Export failed");
  });

  it("closes the menu, then full size, then allows the panel to handle Escape", async () => {
    mount(createElement(LinkedFigureView, { spectrum }));
    click([...container!.querySelectorAll("button")].find((button) => button.textContent === "Full size")!);
    const owner = document.querySelector<HTMLButtonElement>('.lf-modal [aria-haspopup="menu"]')!;
    click(owner);
    const items = document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    act(() => items[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(items[1]);
    for (const prevented of [true, true, false]) {
      const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      await act(async () => window.dispatchEvent(escape));
      expect(escape.defaultPrevented).toBe(prevented);
    }
    expect(document.querySelector(".lf-modal")).toBeNull();
  });

  it.each([false, true])("holds and releases the Export menu's native focus lease (full size: %s)", async (fullSize) => {
    const requestFocus = vi.fn(async (editing: boolean) => editing);
    const stop = installPluginPanelInputFocus(document.body, requestFocus, "windows", async () => () => undefined);
    try {
      mount(createElement(LinkedFigureView, { spectrum }));
      if (fullSize) click([...container!.querySelectorAll("button")].find((button) => button.textContent === "Full size")!);
      for (const close of ["Escape", "outside", "toggle", "export"] as const) {
        requestFocus.mockClear();
        const owner = document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
        await act(async () => owner.click());
        expect(requestFocus).toHaveBeenCalledWith(true, expect.any(Number));
        const items = document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
        act(() => items[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
        expect(document.activeElement).toBe(items[1]);
        expect(requestFocus.mock.calls.map(([editing]) => editing)).toEqual([true]);
        await act(async () => {
          if (close === "Escape") items[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
          else if (close === "outside") document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
          else if (close === "toggle") owner.click();
          else items[1].click();
        });
        expect(document.querySelector('[role="menu"]')).toBeNull();
        expect(requestFocus.mock.calls.map(([editing]) => editing)).toEqual([true, false]);
      }
    } finally {
      stop();
    }
  });

  it("paints opaque backgrounds above every leader for coincident peaks and shelf structure labels, including SVG export", () => {
    const count = 10;
    const crowded: PluginLinkedFigureSpectrum = {
      nucleus: "13C", domain: { min: 0, max: 200 },
      peaks: Array.from({ length: count }, (_, index) => ({
        id: `p${index}`, ppm: 128, intensity: 1, label: "128.00 / 128.10 (alternative)", atomIndices: [index]
      }))
    };
    mount(createElement(LinkedFigureView, {
      spectrum: crowded,
      structure: {
        atoms: Array.from({ length: count }, (_, index) => ({ index, x: 0, y: 0, element: "C" })),
        bonds: []
      }
    }));
    const checkBackgrounds = (svg: Element, selector: string): void => {
      const leaders = [...svg.querySelectorAll(".lf-label-leader")];
      const labels = [...svg.querySelectorAll<SVGTextElement>(selector)];
      expect(leaders).toHaveLength(count);
      expect(labels).toHaveLength(count);
      expect(svg.querySelectorAll(".lf-label-background")).toHaveLength(count);
      for (const label of labels) {
        const background = label.previousElementSibling!;
        expect(background.classList.contains("lf-label-background")).toBe(true);
        expect(background.getAttribute("fill")).toBe("#fff");
        const box = textBox(label);
        for (const key of ["x", "y", "width", "height"] as const) {
          expect(Number(background.getAttribute(key))).toBeCloseTo(box[key]);
        }
        for (const leader of leaders) {
          expect(leader.compareDocumentPosition(background) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        }
      }
    };
    checkBackgrounds(container!.querySelector(".lf-spectrum")!, ".lf-peak-label");
    const structureSvg = container!.querySelector(".lf-structure")!;
    checkBackgrounds(structureSvg, ".lf-shift-label");
    // Overwide annotations force the fallback shelf; the last leader crosses a nearer label's box.
    const firstBox = textBox(structureSvg.querySelector<SVGTextElement>(".lf-shift-label")!);
    const lastLeader = [...structureSvg.querySelectorAll(".lf-label-leader")].at(-1)!;
    expect(Number(lastLeader.getAttribute("x1"))).toBeGreaterThan(firstBox.x);
    expect(Number(lastLeader.getAttribute("x1"))).toBeLessThan(firstBox.x + firstBox.width);
    expect(Number(lastLeader.getAttribute("y1"))).toBeLessThan(firstBox.y);
    expect(Number(lastLeader.getAttribute("y2"))).toBeGreaterThan(firstBox.y + firstBox.height);
    const svg = standaloneSpectrumSvg(container!.querySelector<SVGSVGElement>(".lf-spectrum")!);
    const exported = new DOMParser().parseFromString(svg, "text/html");
    checkBackgrounds(exported.querySelector("svg")!, ".lf-peak-label");
  });

  it.each([380, 508, 1200])("keeps the exit control in wrapping toolbar flow at %spx", (width) => {
    mount(createElement(LinkedFigureView, { spectrum, structure }));
    container!.style.width = `${width}px`;
    click([...container!.querySelectorAll("button")].find((button) => button.textContent === "Full size")!);
    const exit = document.querySelector<HTMLButtonElement>(".lf-modal-close")!;
    const toolbar = exit.closest(".lf-toolbar-actions")!;
    expect(toolbar.querySelector('[aria-haspopup="menu"]')).not.toBeNull();
    expect([...toolbar.querySelectorAll("button")].some((button) => button.textContent === "Copy")).toBe(true);
    // jsdom cannot measure layout; assert the rules that keep all controls in normal wrapping flow.
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../App.css"), "utf8");
    const rule = (selector: string) => css.slice(css.indexOf(`\n${selector} {`)).split("}")[0];
    expect(rule(".lf-toolbar")).toContain("flex-wrap: wrap;");
    expect(rule(".lf-toolbar-actions")).toContain("flex-wrap: wrap;");
    expect(rule(".lf-modal-close")).toContain("position: static;");
    expect(rule(".lf-modal")).toContain("inset: 0;");
    expect(rule(".lf-modal")).not.toMatch(/max-height|max-width|width:/);
    expect(rule(".plugin-report-section")).toContain("min-width: 0;");
    expect(rule(".plugin-report-section")).toContain("flex-shrink: 0;");
    expect(rule(".plugin-report-table-scroll")).toContain("overflow-x: auto;");
    expect(rule(".plugin-report-table-scroll")).toContain("max-width: 100%;");
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

  it("colors structure shift labels by estimation quality and shows the legend", () => {
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
