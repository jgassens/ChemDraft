// @vitest-environment jsdom

import { createHash } from "node:crypto";
import type { PluginLinkedFigureSpectrum, PluginLinkedFigureStructure } from "@chemdraft/plugin-api";
import {
  annotationLabelBoxesOverlap,
  estimateAnnotationTextWidth,
  type AnnotationLabelBox
} from "@chemdraft/layout-engine";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LinkedFigureView,
  SCREEN_CAPTION_FONT_PX,
  SCREEN_PEAK_LABEL_FONT_PX,
  SCREEN_TICK_FONT_PX
} from "./LinkedFigureView";
import { copySpectrumToClipboard, exportSpectrumFigure } from "./spectrumExport";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../window-manager/tauriEvents", () => ({ listenCurrentWindowEvent: vi.fn(async () => () => undefined) }));
vi.mock("./spectrumExport", async (importOriginal) => ({
  ...await importOriginal<typeof import("./spectrumExport")>(),
  copySpectrumToClipboard: vi.fn(), exportSpectrumFigure: vi.fn(), saveTextFile: vi.fn()
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

beforeEach(() => {
  vi.mocked(copySpectrumToClipboard).mockResolvedValue("none");
  vi.mocked(exportSpectrumFigure).mockResolvedValue("saved");
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function mount(element: ReturnType<typeof createElement>): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(element));
}

function button(label: string): HTMLButtonElement {
  return [...container!.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent === label || candidate.getAttribute("aria-label") === label)!;
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const protonSpectrum: PluginLinkedFigureSpectrum = {
  nucleus: "1H",
  domain: { min: 0, max: 12 },
  reversed: true,
  solvent: "CDCl3",
  peaks: [
    { id: "h1", ppm: 2.15, intensity: 6, label: "2.15 (s, 6H)", atomIndices: [0, 1], confidence: "high" },
    { id: "h2", ppm: 7.26, intensity: 5, label: "7.26 (m, 5H)", atomIndices: [2], confidence: "medium",
      couplings: [{ jHz: 7.5, partnerCount: 2 }] },
    { id: "h3", ppm: 3.71, intensity: 2, label: "3.71 (t, 2H)", atomIndices: [3], estimated: true,
      couplings: [{ jHz: 6.8, partnerCount: 2 }] },
    { id: "h4", ppm: 1.25, intensity: 3, label: "1.25 (d, 3H)", atomIndices: [4], confidence: "low",
      couplings: [{ jHz: 7, partnerCount: 1 }] }
  ]
};

const carbonSpectrum: PluginLinkedFigureSpectrum = {
  nucleus: "13C",
  domain: { min: 0, max: 220 },
  reversed: true,
  comparison: { primaryLabel: "HOSE", alternativeLabel: "nmrdb", alternativeMarker: "†" },
  peaks: [
    { id: "c1", ppm: 22.7, intensity: 2, label: "22.7 (2C)", atomIndices: [0, 1], alternativePpm: 23.4 },
    { id: "c2", ppm: 128.4, intensity: 1, label: "128.4", atomIndices: [2], alternativePpm: 129.0 },
    { id: "c3", ppm: 206.1, intensity: 1, label: "206.1", atomIndices: [3] },
    { id: "c4", ppm: 61.3, intensity: 1, label: "61.3", atomIndices: [4], estimated: true }
  ]
};

const structure: PluginLinkedFigureStructure = {
  atoms: [
    { index: 0, x: 0, y: 0, element: "C" },
    { index: 1, x: 1, y: 0, element: "C" },
    { index: 2, x: 1.5, y: 0.87, element: "C" },
    { index: 3, x: 2.5, y: 0.87, element: "O" },
    { index: 4, x: 0.5, y: 0.87, element: "C" }
  ],
  bonds: [
    { from: 0, to: 1, order: 1 },
    { from: 1, to: 2, order: 1 },
    { from: 2, to: 3, order: 2 },
    { from: 1, to: 4, order: 1 }
  ]
};

/** Each scenario's Copy and SVG export payloads, exercising zoom, hover and comparison state. */
async function exportPayloads(spectrum: PluginLinkedFigureSpectrum, comparison: boolean): Promise<string[]> {
  mount(createElement(LinkedFigureView, {
    spectrum, structure, defaultComparisonMode: comparison ? "both" : "primary"
  }));
  const payloads: string[] = [];
  const capture = async (): Promise<void> => {
    click(button("Copy"));
    payloads.push(vi.mocked(copySpectrumToClipboard).mock.calls.at(-1)![0]);
    click(container!.querySelector('button[aria-haspopup="menu"]')!);
    click(button("SVG"));
    await act(async () => {
      await Promise.resolve();
    });
    payloads.push(vi.mocked(exportSpectrumFigure).mock.calls.at(-1)![1]);
  };
  await capture();
  click(button("Zoom in"));
  act(() => {
    container!.querySelector(".lf-peak")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
  await capture();
  return payloads;
}

/**
 * SHA-256 of each scenario's four payloads joined by PAYLOAD_SEPARATOR, captured from the
 * pre-change component (build 11.27.18.05-opus), whose live SVG always used the 680×240 figure.
 * String lengths (UTF-16 code units) are listed so a mismatch is easy to localise.
 */
const PAYLOAD_SEPARATOR = "\n<!-- next payload -->\n";
const scenarios = [
  {
    name: "proton", spectrum: protonSpectrum, comparison: false,
    sha256: "b0d6f1ada2b82e93583d5f4abf38de97998404abb4a8c94972bfe6593ef67a24", lengths: [30483, 30483, 54574, 54574]
  },
  {
    name: "carbon-both", spectrum: carbonSpectrum, comparison: true,
    sha256: "64a3ee1c2ef2e26ffd834444723f2c518d647f25650bc074f81353d5c0a70690", lengths: [31610, 31610, 55143, 55143]
  }
] as const;

/** Make every `.lf-spectrum` report `width` CSS px and capture any ResizeObserver it creates. */
function layoutSpectrumAt(width: number): { resize: (next: number) => void } {
  let current = width;
  const callbacks: ResizeObserverCallback[] = [];
  const original = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (!this.classList.contains("lf-spectrum")) return original.call(this);
    return { left: 0, top: 0, right: current, bottom: 0, width: current, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) {
      callbacks.push(callback);
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  return {
    resize: (next: number) => {
      current = next;
      act(() => {
        for (const callback of callbacks) callback([], {} as ResizeObserver);
      });
    }
  };
}

function svg(): SVGSVGElement {
  return container!.querySelector<SVGSVGElement>(".lf-spectrum")!;
}

/** CSS pixels per viewBox unit for a figure laid out `width` CSS px wide. */
function cssPerUnit(width: number): number {
  return width / Number(svg().getAttribute("viewBox")!.split(" ")[2]);
}

function cssFontSize(node: Element, width: number): number {
  return parseFloat((node as SVGTextElement).style.fontSize) * cssPerUnit(width);
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

function viewBoxSize(): { width: number; height: number } {
  const [, , width, height] = svg().getAttribute("viewBox")!.split(" ").map(Number);
  return { width, height };
}

/** Text sits inside the SVG, tick numbers clear each other, peak labels clear each other and the axis. */
function expectReadableLayout(): void {
  const { width, height } = viewBoxSize();
  const ticks = [...svg().querySelectorAll<SVGTextElement>(".lf-tick-label")].map(textBox);
  const peaks = [...svg().querySelectorAll<SVGTextElement>(".lf-peak-label")].map(textBox);
  const caption = textBox(svg().querySelector<SVGTextElement>(".lf-axis-caption")!);
  const axisY = Number(svg().querySelector(".lf-axis")!.getAttribute("y1"));
  for (const box of [...ticks, ...peaks, caption]) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(height);
  }
  for (const [index, box] of ticks.entries()) {
    expect(annotationLabelBoxesOverlap(box, caption)).toBe(false);
    for (const other of ticks.slice(index + 1)) expect(annotationLabelBoxesOverlap(box, other)).toBe(false);
  }
  for (const [index, box] of peaks.entries()) {
    expect(box.y + box.height).toBeLessThanOrEqual(axisY);
    for (const other of peaks.slice(index + 1)) expect(annotationLabelBoxesOverlap(box, other)).toBe(false);
  }
  const note = svg().querySelector<SVGTextElement>(".lf-spectrum-note")!;
  const noteFont = parseFloat(note.style.fontSize);
  const lines = note.querySelectorAll("tspan").length > 0 ? [...note.querySelectorAll("tspan")] : [note];
  for (const line of lines) {
    expect(estimateAnnotationTextWidth(line.textContent!.trim(), noteFont)).toBeLessThanOrEqual(width);
    expect(Number(line.getAttribute("y") ?? note.getAttribute("y"))).toBeLessThanOrEqual(Math.min(...peaks.map((box) => box.y)));
  }
}

describe("LinkedFigureView export payloads", () => {
  it.each(scenarios)("keeps the $name Copy and SVG export byte-identical to the 680×240 figure", async ({ spectrum, comparison, sha256, lengths }) => {
    const payloads = await exportPayloads(spectrum, comparison);
    expect(payloads.map((payload) => payload.length)).toEqual(lengths);
    expect(createHash("sha256").update(payloads.join(PAYLOAD_SEPARATOR)).digest("hex")).toBe(sha256);
  });

  it.each(scenarios)("exports the same $name bytes from a narrow 300 px panel", async ({ spectrum, comparison, sha256 }) => {
    layoutSpectrumAt(300);
    const payloads = await exportPayloads(spectrum, comparison);
    expect(createHash("sha256").update(payloads.join(PAYLOAD_SEPARATOR)).digest("hex")).toBe(sha256);
    // The panel itself is back on the screen layout once the export has been read.
    expect(svg().getAttribute("viewBox")).not.toBe("0 0 680 240");
    expect(cssFontSize(svg().querySelector(".lf-tick-label")!, 300)).toBeCloseTo(SCREEN_TICK_FONT_PX, 5);
  });
});

describe("LinkedFigureView on-screen text size", () => {
  it.each([250, 300, 400, 680, 1400])("draws tick numbers, peak labels and captions at a readable CSS size at %s px", (width) => {
    layoutSpectrumAt(width);
    mount(createElement(LinkedFigureView, { spectrum: protonSpectrum, structure }));
    const ticks = svg().querySelectorAll(".lf-tick-label");
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    for (const tick of ticks) expect(cssFontSize(tick, width)).toBeCloseTo(SCREEN_TICK_FONT_PX, 5);
    const peaks = svg().querySelectorAll(".lf-peak-label");
    expect(peaks.length).toBeGreaterThan(0);
    for (const peak of peaks) expect(cssFontSize(peak, width)).toBeCloseTo(SCREEN_PEAK_LABEL_FONT_PX, 5);
    expect(cssFontSize(svg().querySelector(".lf-axis-caption")!, width)).toBeCloseTo(SCREEN_CAPTION_FONT_PX, 5);
    expect(cssFontSize(svg().querySelector(".lf-spectrum-note")!, width)).toBeCloseTo(SCREEN_CAPTION_FONT_PX, 5);
    expectReadableLayout();
  });

  it("shows every 13C peak label, including '22.7 (2C)', without collisions in a 300 px panel", () => {
    layoutSpectrumAt(300);
    mount(createElement(LinkedFigureView, { spectrum: carbonSpectrum, structure, defaultComparisonMode: "both" }));
    const labels = [...svg().querySelectorAll(".lf-peak-label")].map((node) => node.textContent);
    expect(labels).toContain("22.7 (2C)");
    expect(labels).toHaveLength(6);
    expectReadableLayout();
  });

  it("thins ticks when narrow and restores them when the panel widens", () => {
    const layout = layoutSpectrumAt(250);
    mount(createElement(LinkedFigureView, { spectrum: carbonSpectrum }));
    const narrow = svg().querySelectorAll(".lf-tick-label").length;
    expectReadableLayout();
    layout.resize(1200);
    const wide = svg().querySelectorAll(".lf-tick-label").length;
    expect(wide).toBeGreaterThan(narrow);
    for (const tick of svg().querySelectorAll(".lf-tick-label")) expect(cssFontSize(tick, 1200)).toBeCloseTo(SCREEN_TICK_FONT_PX, 5);
    expectReadableLayout();
  });

  it("keeps labels separate and inside the figure through zoom and pan in a narrow panel", () => {
    layoutSpectrumAt(280);
    const crowded: PluginLinkedFigureSpectrum = {
      nucleus: "1H", domain: { min: 0, max: 8 },
      peaks: [7.30, 7.28, 7.25, 3.71, 2.61, 2.15, 1.25, 1.21].map((ppm, index) => ({
        id: `p${index}`, ppm, intensity: 1 + (index % 3), label: `${ppm.toFixed(2)} (m, ${index + 1}H)`, atomIndices: [index % 5]
      }))
    };
    mount(createElement(LinkedFigureView, { spectrum: crowded, structure }));
    for (let zoom = 0; zoom < 12; zoom += 1) {
      expectReadableLayout();
      act(() => svg().dispatchEvent(new WheelEvent("wheel", { deltaY: -100, clientX: 280 * 0.1, bubbles: true, cancelable: true })));
    }
    act(() => svg().dispatchEvent(new WheelEvent("wheel", { deltaX: 40, bubbles: true, cancelable: true })));
    expectReadableLayout();
  });

  it("zooms around the cursor and links peaks to atoms on the screen layout", () => {
    layoutSpectrumAt(300);
    mount(createElement(LinkedFigureView, { spectrum: protonSpectrum, structure }));
    const before = [...svg().querySelectorAll(".lf-tick-label")].map((node) => Number(node.textContent));
    // Zoom in over the 2.15 ppm singlet: it must stay in view while the window narrows.
    const singlet = svg().querySelector<SVGTextElement>('[data-peak-id="h1"] .lf-peak-label')!;
    const unitsX = Number(singlet.getAttribute("x"));
    for (let step = 0; step < 6; step += 1) {
      act(() => svg().dispatchEvent(new WheelEvent("wheel", { deltaY: -200, clientX: unitsX * cssPerUnit(300), bubbles: true, cancelable: true })));
    }
    const after = [...svg().querySelectorAll(".lf-tick-label")].map((node) => Number(node.textContent));
    expect(Math.max(...after) - Math.min(...after)).toBeLessThan(Math.max(...before) - Math.min(...before));
    expect(svg().querySelector('[data-peak-id="h1"] .lf-peak-label')).not.toBeNull();
    act(() => {
      svg().querySelector('[data-peak-id="h1"]')!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(container!.querySelector('[data-atom-index="0"]')!.classList.contains("is-active")).toBe(true);
    expect(svg().querySelector(".lf-curve.is-active")).not.toBeNull();
  });

  it("keeps the publication layout where nothing has been laid out (no width)", () => {
    mount(createElement(LinkedFigureView, { spectrum: protonSpectrum }));
    expect(svg().getAttribute("viewBox")).toBe("0 0 680 240");
    expect(svg().querySelector<SVGTextElement>(".lf-tick-label")!.style.fontSize).toBe("11px");
    expect(svg().querySelector<SVGTextElement>(".lf-peak-label")!.style.fontSize).toBe("13px");
  });
});
