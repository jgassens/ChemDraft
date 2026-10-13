import { jsPDF } from "jspdf";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unicodeCmap } from "./pdf.testUtils";
import { preparePdfFonts } from "./pdfFonts";

const fonts = {
  regular: () => import("./fonts/DejaVuSans"),
  bold: () => import("./fonts/DejaVuSans-Bold"),
  oblique: () => import("./fonts/DejaVuSans-Oblique"),
  boldOblique: () => import("./fonts/DejaVuSans-BoldOblique")
};

afterEach(() => vi.unstubAllGlobals());

describe("vendored PDF font cmap coverage", () => {
  it.each(Object.entries(fonts))("covers chemistry text in the %s face", async (_name, load) => {
    const { default: data } = await load();
    const cmap = unicodeCmap(Buffer.from(data, "base64"));
    const codes = [
      ...Array.from({ length: 95 }, (_, i) => i + 32), // Printable ASCII.
      ...Array.from({ length: 0x3ce - 0x391 + 1 }, (_, i) => i + 0x391).filter((code) => code !== 0x3a2),
      ...Array.from({ length: 48 }, (_, i) => i + 0x2070)
        .filter((code) => ![0x2072, 0x2073, 0x208f, 0x209d, 0x209e, 0x209f].includes(code)), // Unassigned.
      ...Array.from("μµ→←↔⇌⇋Δ±×°−∞≠≤≥•⊕⊖", (character) => character.codePointAt(0)!)
    ];
    for (const code of codes) expect(cmap.get(code), `U+${code.toString(16)}`).toBeGreaterThan(0);
  });
});

describe("PDF font loading", () => {
  it("does not register embedded or browser fonts for ASCII text", async () => {
    const dom = new JSDOM('<svg xmlns="http://www.w3.org/2000/svg"><text>H2O</text></svg>', { contentType: "image/svg+xml" });
    const pdf = new jsPDF();
    const addFont = vi.spyOn(pdf, "addFont");
    const release = await preparePdfFonts(dom.window.document.documentElement, pdf);
    expect(addFont).not.toHaveBeenCalled();
    expect(dom.window.document.querySelector("text")!.hasAttribute("font-family")).toBe(false);
    release();
    dom.window.close();
  });

  it.each([false, true])("releases temporary browser fonts when loading fails=%s", async (fail) => {
    const added = new Set<unknown>();
    const registrations: { family: string; byteLength: number; descriptors: FontFaceDescriptors }[] = [];
    vi.stubGlobal("document", { fonts: added });
    vi.stubGlobal("FontFace", class {
      constructor(family: string, data: ArrayBuffer, descriptors: FontFaceDescriptors) {
        registrations.push({ family, byteLength: data.byteLength, descriptors });
      }
      async load() {
        if (fail && registrations.length === 2) throw new Error("Synthetic font load failure");
        return this;
      }
    });
    const dom = new JSDOM('<svg xmlns="http://www.w3.org/2000/svg"><text>μ<tspan font-weight="700" font-style="italic">₆⁻</tspan></text></svg>', { contentType: "image/svg+xml" });
    const prepare = preparePdfFonts(dom.window.document.documentElement, new jsPDF());
    if (fail) await expect(prepare).rejects.toThrow("Synthetic font load failure");
    else {
      const release = await prepare;
      expect(added.size).toBe(2);
      release();
    }
    expect(added.size).toBe(0);
    expect(registrations.map((registration) => registration.descriptors)).toEqual([
      { weight: "400", style: "normal" }, { weight: "700", style: "italic" }
    ]);
    expect(registrations.map((registration) => registration.byteLength)).toEqual([756072, 641720]);
    dom.window.close();
  });
});
