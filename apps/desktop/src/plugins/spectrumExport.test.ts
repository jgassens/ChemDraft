// @vitest-environment jsdom

import type { PluginLinkedFigureSpectrum } from "@chemdraft/plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  copySpectrumToClipboard,
  observeFrequencyMHz,
  saveTextFile,
  spectrumToJcampDx,
  standaloneSpectrumSvg
} from "./spectrumExport";

const nativeSave = vi.hoisted(() => vi.fn());
const nativeWriteTextFile = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: nativeSave }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: nativeWriteTextFile }));

const originalClipboardItem = globalThis.ClipboardItem;

afterEach(() => {
  nativeSave.mockReset();
  nativeWriteTextFile.mockReset();
  delete (globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  Reflect.deleteProperty(navigator, "clipboard");
  if (originalClipboardItem) {
    globalThis.ClipboardItem = originalClipboardItem;
  } else {
    Reflect.deleteProperty(globalThis, "ClipboardItem");
  }
});

const spectrum: PluginLinkedFigureSpectrum = {
  nucleus: "1H",
  domain: { min: 0, max: 8 },
  reversed: true,
  peaks: [
    { id: "a", ppm: 1.2, intensity: 3, atomIndices: [1] },
    { id: "b", ppm: 7.26, intensity: 5, atomIndices: [0] }
  ]
};

describe("spectrumToJcampDx", () => {
  it("emits a JCAMP-DX peak table with nucleus + frequency, peaks ppm-descending", () => {
    const jdx = spectrumToJcampDx(spectrum, { title: "Predicted 1H NMR", freqMHz: 400 });
    expect(jdx).toContain("##JCAMP-DX=5.01");
    expect(jdx).toContain("##DATA TYPE=NMR PEAK TABLE");
    expect(jdx).toContain("##.OBSERVE NUCLEUS=^1H");
    expect(jdx).toContain("##.OBSERVE FREQUENCY=400");
    expect(jdx).toContain("##PEAK TABLE=(XY..XY)");
    expect(jdx.trimEnd().endsWith("##END=")).toBe(true);

    const body = jdx.split("##PEAK TABLE=(XY..XY)\n")[1];
    expect(body.startsWith("7.2600, 5.000")).toBe(true); // highest ppm first
    expect(body).toContain("1.2000, 3.000");
  });

  it("maps ¹³C to the ^13C token", () => {
    expect(spectrumToJcampDx({ ...spectrum, nucleus: "13C" })).toContain("##.OBSERVE NUCLEUS=^13C");
  });

  it("exports the selected cross-check view instead of silently reverting to primary peaks", () => {
    const crossChecked: PluginLinkedFigureSpectrum = {
      ...spectrum,
      comparison: { primaryLabel: "HOSE", alternativeLabel: "increment", alternativeMarker: "ᵢ" },
      peaks: [{ id: "cc", ppm: 2, alternativePpm: 2.9, intensity: 1, atomIndices: [0] }]
    };

    const hose = spectrumToJcampDx(crossChecked, { comparisonMode: "primary" });
    expect(hose).toContain("2.0000, 1.000");
    expect(hose).not.toContain("2.9000, 1.000");
    expect(hose).toContain("##$CHEMDRAFT COMPARISON MODE=HOSE");
    expect(hose).toContain("##$CHEMDRAFT ALTERNATIVE METHOD=increment");
    expect(hose).toContain("##NPOINTS=1");

    const both = spectrumToJcampDx(crossChecked, { comparisonMode: "both" });
    expect(both).toContain("2.9000, 1.000");
    expect(both).toContain("2.0000, 1.000");
    expect(both).toContain("##NPOINTS=2");
  });

  it("normalizes a stale show-both export to the primary method when no alternatives exist", () => {
    const hoseOnly: PluginLinkedFigureSpectrum = {
      ...spectrum,
      comparison: { primaryLabel: "HOSE", alternativeLabel: "increment", alternativeMarker: "ᵢ" }
    };
    const jdx = spectrumToJcampDx(hoseOnly, { comparisonMode: "both" });
    expect(jdx).toContain("##$CHEMDRAFT COMPARISON MODE=HOSE");
    expect(jdx).toContain("##NPOINTS=2");
  });

  it("derives a 13C observe frequency from the proton-rated field and preserves intensity semantics", () => {
    const carbon = spectrumToJcampDx({ ...spectrum, nucleus: "13C" }, { protonFrequencyMHz: 300 });
    expect(observeFrequencyMHz("13C", 300)).toBeCloseTo(75.434859, 6);
    expect(carbon).toContain("##.OBSERVE FREQUENCY=75.434859");
    expect(carbon).toContain("##$CHEMDRAFT PROTON FREQUENCY=300");
    expect(carbon).toContain("Predicted equivalent-nuclei count; not experimental integration");
  });
});

describe("standaloneSpectrumSvg", () => {
  it("wraps the live svg into a self-contained, styled SVG document", () => {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg") as SVGSVGElement;
    svg.setAttribute("viewBox", "0 0 680 240");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("class", "lf-curve is-estimated");
    path.setAttribute("d", "M0 0 L10 10");
    svg.appendChild(path);
    const alternativePath = document.createElementNS(ns, "path");
    alternativePath.setAttribute("class", "lf-curve is-alternative");
    alternativePath.setAttribute("d", "M0 10 L10 0");
    svg.appendChild(alternativePath);

    const out = standaloneSpectrumSvg(svg, "increment", "HOSE");
    expect(out.startsWith("<?xml")).toBe(true);
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(out).toContain('width="680"');
    expect(out).toContain('height="240"');
    expect(out).toContain(".lf-curve{fill:none;stroke:#2f7d6f"); // inlined style travels with the copy
    expect(out).toContain(".lf-curve.is-estimated{stroke:#8a8f98");
    expect(out).toContain(".lf-curve.is-alternative{stroke:#b5651d");
    expect(out).toContain('class="lf-curve is-estimated"'); // original provenance class preserved
    expect(out).toContain('class="lf-curve is-alternative"');
    expect(out).toContain("Height = predicted equivalent nuclei (not experimental integration)");
    expect(out).toContain("grey dashed = rule-estimated");
    expect(out).toContain("dashed orange = increment");
    expect(out).toContain("methods = HOSE + increment");
    expect(out).toContain('data-comparison-mode="both"');
    expect(out).toContain('data-primary-method="HOSE"');
    expect(out).toContain("stroke-dasharray:5 3");
  });

  it("does not claim an orange comparison series when a copied SVG has only primary peaks", () => {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg") as SVGSVGElement;
    svg.setAttribute("viewBox", "0 0 680 240");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("class", "lf-curve");
    path.setAttribute("d", "M0 0 L10 10");
    svg.appendChild(path);

    const out = standaloneSpectrumSvg(svg, "increment", "HOSE");
    // A plain-primary spectrum makes no confidence or provenance claims it cannot show (ADR-0025).
    expect(out).not.toContain("lower confidence");
    expect(out).not.toContain("rule-estimated");
    expect(out).not.toContain("orange = increment");
    expect(out).toContain("method = HOSE only");
    expect(out).toContain('data-comparison-mode="primary"');
  });
});

describe("copySpectrumToClipboard", () => {
  it("initiates ClipboardItem.write synchronously while PNG rasterization remains promise-backed", async () => {
    type ClipboardPayload = Record<string, Blob | Promise<Blob>>;
    class TestClipboardItem {
      static latest: TestClipboardItem | undefined;
      readonly types = ["image/png", "text/plain"];
      readonly presentationStyle = "unspecified" as const;
      constructor(readonly payload: ClipboardPayload) {
        TestClipboardItem.latest = this;
      }
      async getType(type: string): Promise<Blob> {
        return await this.payload[type];
      }
    }
    globalThis.ClipboardItem = TestClipboardItem as unknown as typeof ClipboardItem;

    let resolvePng: ((blob: Blob | null) => void) | undefined;
    const rasterize = vi.fn(
      () =>
        new Promise<Blob | null>((resolve) => {
          resolvePng = resolve;
        })
    );
    const write = vi.fn((items: ClipboardItem[]) => items[0].getType("image/png").then(() => undefined));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write, writeText: vi.fn() }
    });

    const pending = copySpectrumToClipboard("<svg/>", rasterize);
    expect(rasterize).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce(); // called before resolvePng: user activation is still live
    expect(TestClipboardItem.latest?.payload["image/png"]).toBeInstanceOf(Promise);

    resolvePng?.(new Blob(["png"], { type: "image/png" }));
    await expect(pending).resolves.toBe("image");
  });
});

describe("saveTextFile", () => {
  it("reports a native write failure without falling through to a Tauri-inert browser download", async () => {
    (globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    nativeSave.mockResolvedValue("/tmp/predicted.jdx");
    nativeWriteTextFile.mockRejectedValue(new Error("disk full"));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click");

    await expect(
      saveTextFile("predicted.jdx", "data", {
        title: "Export",
        formatLabel: "JCAMP-DX",
        extensions: ["jdx"],
        mimeType: "chemical/x-jcamp-dx"
      })
    ).resolves.toBe("failed");
    expect(click).not.toHaveBeenCalled();
  });
});
