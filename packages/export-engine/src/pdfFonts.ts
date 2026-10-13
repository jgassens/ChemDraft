import type { jsPDF } from "jspdf";

const family = "ChemDraftDejaVuSans";
type Face = "normal" | "bold" | "italic" | "bolditalic";

// Keep the losslessly encoded font files in separate chunks. Neither importing the
// export engine nor exporting an ASCII PDF loads font data (browser or Node).
const loadFace = {
  normal: () => import("./fonts/DejaVuSans"),
  bold: () => import("./fonts/DejaVuSans-Bold"),
  italic: () => import("./fonts/DejaVuSans-Oblique"),
  bolditalic: () => import("./fonts/DejaVuSans-BoldOblique")
};

/** Substitute whole text elements so mixed ASCII/Unicode spans use consistent metrics. */
export async function preparePdfFonts(svg: Element, pdf: jsPDF): Promise<() => void> {
  const runs = new Map<Face, string[]>();
  for (const text of svg.querySelectorAll("text")) {
    if (!/[^\x00-\x7f]/u.test(text.textContent ?? "")) continue;

    for (const element of [text, ...text.querySelectorAll("tspan")]) {
      const weight = inheritedAttribute(element, "font-weight") ?? "400";
      const style = inheritedAttribute(element, "font-style") ?? "normal";
      const bold = weight === "bold" || Number(weight) >= 600;
      const italic = style === "italic" || style === "oblique";
      const face: Face = bold ? (italic ? "bolditalic" : "bold") : (italic ? "italic" : "normal");
      element.setAttribute("font-family", family);
      element.setAttribute("font-weight", bold ? "700" : "400");
      element.setAttribute("font-style", italic ? "italic" : "normal");
      const strings = runs.get(face) ?? [];
      // Only direct text belongs to this face; descendants can have another style.
      strings.push(...Array.from(element.childNodes)
        .filter((node) => node.nodeType === 3)
        .map((node) => node.textContent ?? ""));
      runs.set(face, strings);
    }
  }

  const browserFonts: FontFace[] = [];
  const fontSet = globalThis.document?.fonts;
  const release = () => { for (const font of browserFonts) fontSet?.delete(font); };
  try {
    for (const [face, strings] of runs) {
      const { default: data } = await loadFace[face]();
      const filename = `${family}-${face}.ttf`;
      pdf.addFileToVFS(filename, data);
      // Identity-H activates jsPDF's TrueType subset writer and ToUnicode CMap.
      pdf.addFont(filename, family, face, "Identity-H");
      pdf.setFont(family, face);
      const font = pdf.getFont();
      const metadata = font.metadata as { characterToGlyph?: (code: number) => number };
      if (!metadata.characterToGlyph) {
        throw new Error(`Cannot export PDF: embedded font ${face} could not be loaded.`);
      }
      for (const character of strings.join("")) {
        const code = character.codePointAt(0)!;
        if (code > 0xffff || (code > 32 && !metadata.characterToGlyph(code))) {
          throw new Error(`Cannot export PDF: embedded font ${face} does not support U+${code.toString(16).toUpperCase().padStart(4, "0")}.`);
        }
      }

      // svg2pdf measures spans with browser SVG/canvas APIs. Supply the same font
      // to those APIs during export; the headless DOM has no FontFace API.
      if (typeof globalThis.FontFace === "function" && fontSet) {
        const binary = atob(data);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        const browserFont = new FontFace(family, bytes.buffer, {
          weight: face.includes("bold") ? "700" : "400",
          style: face.includes("italic") ? "italic" : "normal"
        });
        await browserFont.load();
        fontSet.add(browserFont);
        browserFonts.push(browserFont);
      }
    }
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

function inheritedAttribute(element: Element, name: string): string | null {
  for (let current: Element | null = element; current; current = current.parentElement) {
    const value = current.getAttribute(name);
    if (value !== null) return value;
  }
  return null;
}
