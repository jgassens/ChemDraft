import { jsPDF } from "jspdf";
import { JSDOM } from "jsdom";
import { afterEach, expect, it, vi } from "vitest";

const payloads = [
  "NotoSans-Regular", "NotoSans-Bold", "NotoSans-Italic", "NotoSans-BoldItalic",
  "DejaVuSans", "DejaVuSans-Bold", "DejaVuSans-Oblique", "DejaVuSans-BoldOblique"
];

afterEach(() => {
  for (const payload of payloads) vi.doUnmock(`./fonts/${payload}`);
  vi.resetModules();
});

it.each([
  ["normal", "400", "normal", "NotoSans-Regular", "DejaVuSans"],
  ["bold", "700", "normal", "NotoSans-Bold", "DejaVuSans-Bold"],
  ["italic", "400", "italic", "NotoSans-Italic", "DejaVuSans-Oblique"],
  ["bolditalic", "700", "italic", "NotoSans-BoldItalic", "DejaVuSans-BoldOblique"]
])("loads only payloads used by %s runs", async (_face, weight, style, noto, dejavu) => {
  for (const [text, expected] of [
    ["⇌⊕", [dejavu]], ["H₂O", [noto]], ["H2O + NaCl", []], ["H₂O⇌⊕", [noto, dejavu]]
  ] as const) {
    vi.resetModules();
    const loaded: string[] = [];
    for (const payload of payloads) {
      vi.doMock(`./fonts/${payload}`, async () => {
        loaded.push(payload);
        if (!(expected as readonly string[]).includes(payload)) throw new Error(`Loaded unused payload ${payload}`);
        return vi.importActual(`./fonts/${payload}`);
      });
    }
    const { preparePdfFonts } = await import("./pdfFonts");
    // Importing the helper alone must not evaluate any font payload.
    expect(loaded).toEqual([]);
    const dom = new JSDOM(`<svg xmlns="http://www.w3.org/2000/svg"><text font-weight="${weight}" font-style="${style}">${text}</text></svg>`, { contentType: "image/svg+xml" });
    try {
      const pdf = new jsPDF();
      const register = vi.spyOn(pdf, "addFont");
      const release = await preparePdfFonts(dom.window.document.documentElement, pdf);
      expect(loaded).toEqual(expected);
      expect(register).toHaveBeenCalledTimes(expected.length);
      release();
    } finally {
      dom.window.close();
    }
  }
}, 60_000);
