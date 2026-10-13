import { jsPDF } from "jspdf";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { glyphBounds, sfntName, unicodeCmap } from "./pdf.testUtils";
import { preparePdfFonts } from "./pdfFonts";

const fonts = {
  regular: () => import("./fonts/DejaVuSans"),
  bold: () => import("./fonts/DejaVuSans-Bold"),
  oblique: () => import("./fonts/DejaVuSans-Oblique"),
  boldOblique: () => import("./fonts/DejaVuSans-BoldOblique")
};

const primaryFonts = {
  regular: () => import("./fonts/NotoSans-Regular"),
  bold: () => import("./fonts/NotoSans-Bold"),
  italic: () => import("./fonts/NotoSans-Italic"),
  boldItalic: () => import("./fonts/NotoSans-BoldItalic")
};

afterEach(() => vi.unstubAllGlobals());

describe("vendored PDF font cmap coverage", () => {
  it.each(Object.entries(primaryFonts))("locks Noto's script digit placement in the %s face", async (_name, load) => {
    const { default: data } = await load();
    const bytes = Buffer.from(data, "base64");
    expect(sfntName(bytes, 5)).toMatch(/^Version 2\.015;/);
    for (const character of "₀₁₂₃₄₅₆₇₈₉") {
      const bounds = glyphBounds(bytes, character.codePointAt(0)!);
      expect(bounds.yMax, character).toBeLessThanOrEqual(0.35);
      expect(bounds.yMin, character).toBeLessThanOrEqual(-0.1);
    }
    for (const character of "⁰¹²³⁴⁵⁶⁷⁸⁹") {
      expect(glyphBounds(bytes, character.codePointAt(0)!).yMin, character).toBeGreaterThanOrEqual(0.35);
    }
    const cmap = unicodeCmap(bytes);
    for (const character of "μµ₊₋⁺⁻") expect(cmap.get(character.codePointAt(0)!)).toBeGreaterThan(0);
    for (const character of "→←↔⇌⇋∞≠≤≥⊕⊖") expect(cmap.has(character.codePointAt(0)!)).toBe(false);
  });
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
  it.each([
    ["μ₆⁻", ["ChemDraftNotoSans"]],
    ["⇌⊕", ["ChemDraftDejaVuSans"]],
    ["K ⇌ 10⁻³, SO₄²⁻ μmol H₂O", ["ChemDraftNotoSans", "ChemDraftDejaVuSans"]],
    ["μ⌀", ["ChemDraftNotoSans", "ChemDraftDejaVuSans"]] // Another cmap gap, beyond the chemistry list.
  ])("registers only used families for %s", async (text, families) => {
    const dom = new JSDOM(`<svg xmlns="http://www.w3.org/2000/svg"><text x="20" y="30" font-size="12" fill="red"><tspan dx="3" dy="4" font-weight="700" font-style="italic">${text}</tspan></text></svg>`, { contentType: "image/svg+xml" });
    const pdf = new jsPDF();
    const addFont = vi.spyOn(pdf, "addFont");
    const release = await preparePdfFonts(dom.window.document.documentElement, pdf);
    expect(addFont.mock.calls.map((call) => call[1])).toEqual(families);
    expect(addFont.mock.calls.every((call) => call[2] === "bolditalic")).toBe(true);
    const owner = dom.window.document.querySelector("text > tspan")!;
    expect(owner.getAttribute("dx")).toBe("3");
    expect(owner.getAttribute("dy")).toBe("4");
    const spans = Array.from(owner.children);
    expect(spans.map((span) => span.textContent).join("")).toBe(text);
    expect(spans.every((span) => span.getAttribute("font-weight") === "700" && span.getAttribute("font-style") === "italic")).toBe(true);
    expect(spans[0]!.hasAttribute("dx")).toBe(false);
    for (const span of spans.slice(1)) {
      expect(span.getAttribute("dx")).toBe("0");
      expect(span.getAttribute("dy")).toBe("0");
      expect(span.hasAttribute("x") || span.hasAttribute("y")).toBe(false);
    }
    release();
    dom.window.close();
  });
  it.each([
    ["\u0600", "Arabic script"], ["\u0750", "Arabic script"],
    ["\u08a0", "Arabic script"], ["\ufb50", "Arabic script"],
    ["\ufdf2", "Arabic script"], ["\ufe8e", "Arabic script"],
    ["\u05d0", "Right-to-left scripts"], ["\ufb1d", "Right-to-left scripts"],
    ["\u0710", "Right-to-left scripts"], ["\u0780", "Right-to-left scripts"],
    ["\u07ca", "Right-to-left scripts"], ["\u0840", "Right-to-left scripts"],
    ["\u200f", "Right-to-left scripts"]
  ])("refuses unsupported script character %s in a styled span", async (character, script) => {
    const dom = new JSDOM(`<svg><text>μ<tspan font-weight="700">${character}</tspan></text></svg>`);
    const pdf = new jsPDF();
    const addFont = vi.spyOn(pdf, "addFont");
    const code = character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
    await expect(preparePdfFonts(dom.window.document.documentElement, pdf))
      .rejects.toThrow(`${script} not supported in PDF export yet (U+${code})`);
    expect(addFont).not.toHaveBeenCalled();
    dom.window.close();
  });

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
    const dom = new JSDOM('<svg xmlns="http://www.w3.org/2000/svg"><text>μ⇌<tspan font-weight="700" font-style="italic">₆⁻</tspan></text></svg>', { contentType: "image/svg+xml" });
    const prepare = preparePdfFonts(dom.window.document.documentElement, new jsPDF());
    if (fail) await expect(prepare).rejects.toThrow("Synthetic font load failure");
    else {
      const release = await prepare;
      expect(added.size).toBe(3);
      release();
    }
    expect(added.size).toBe(0);
    expect(registrations.map((registration) => registration.descriptors)).toEqual([
      { weight: "400", style: "normal" }, { weight: "400", style: "normal" },
      { weight: "700", style: "italic" }
    ].slice(0, fail ? 2 : 3));
    expect(registrations.map((registration) => registration.family)).toEqual([
      "ChemDraftNotoSans", "ChemDraftDejaVuSans", "ChemDraftNotoSans"
    ].slice(0, fail ? 2 : 3));
    expect(registrations.map((registration) => registration.byteLength)).toEqual([825628, 756072, 853344].slice(0, fail ? 2 : 3));
    dom.window.close();
  });
});
