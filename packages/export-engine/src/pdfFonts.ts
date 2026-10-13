import type { jsPDF } from "jspdf";

type Face = "normal" | "bold" | "italic" | "bolditalic";
type Family = "ChemDraftNotoSans" | "ChemDraftDejaVuSans";

// jsPDF 4.2.1's arabic parser recognizes these ranges and substitutes shapes /
// ligatures before building ToUnicode. Disabling it would render unjoined letters.
const arabicText = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/u;
// Its bidi engine also reorders mixed LTR/RTL runs: Hebrew (including presentation
// forms), Syriac, Thaana, NKo, and the U+08xx scripts it classifies as RTL.
const rtlText = /[\u0590-\u05ff\u0700-\u074f\u0780-\u089f\ufb1d-\ufb4f\u200f]/u;

// jsPDF 4.2.1 preserves Latin-1 and maps these 27 additional Unicode characters
// to bytes in the standard fonts' declared WinAnsiEncoding (verified in PDF streams).
const needsEmbeddedFont = /[^\u0000-\u00ffŒœŠšŸŽžƒˆ˜–—‘’‚“”„†‡•…‰‹›€™]/u;

// Keep the losslessly encoded font files in separate chunks. Neither importing the
// export engine nor exporting a standard-font PDF loads font data (browser or Node).
const loadFace = {
  ChemDraftNotoSans: {
    normal: () => import("./fonts/NotoSans-Regular"),
    bold: () => import("./fonts/NotoSans-Bold"),
    italic: () => import("./fonts/NotoSans-Italic"),
    bolditalic: () => import("./fonts/NotoSans-BoldItalic")
  },
  ChemDraftDejaVuSans: {
    normal: () => import("./fonts/DejaVuSans"),
    bold: () => import("./fonts/DejaVuSans-Bold"),
    italic: () => import("./fonts/DejaVuSans-Oblique"),
    bolditalic: () => import("./fonts/DejaVuSans-BoldOblique")
  }
};

/** Keep standard-font elements; split embedded text runs by actual cmap coverage. */
export async function preparePdfFonts(svg: Element, pdf: jsPDF): Promise<() => void> {
  const fonts = new Map<string, {
    family: Family; face: Face; data: string; bytes: Uint8Array<ArrayBuffer>;
    covers: (code: number) => boolean; used: boolean;
  }>();
  const getFace = async (family: Family, face: Face) => {
    const key = `${family}-${face}`;
    let font = fonts.get(key);
    if (!font) {
      const { default: data } = await loadFace[family][face]();
      const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
      font = { family, face, data, bytes, covers: bmpCoverage(bytes), used: false };
      fonts.set(key, font);
    }
    return font;
  };
  for (const text of svg.querySelectorAll("text")) {
    const content = text.textContent ?? "";
    const unsupported = content.match(arabicText) ?? content.match(rtlText);
    if (unsupported) {
      const character = unsupported[0];
      const code = character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
      const script = arabicText.test(character) ? "Arabic script" : "Right-to-left scripts";
      throw new Error(`Cannot export PDF: ${script} not supported in PDF export yet (U+${code}); jsPDF shaping or reordering cannot preserve original Unicode.`);
    }
    // The same unconditional Arabic hook splits on the literal string "\\s+",
    // even in ASCII text. Refuse that sequence rather than silently replacing it.
    if (content.includes("\\s+")) {
      throw new Error("Cannot export PDF: U+005C in the literal sequence \\s+ is not supported; jsPDF text processing cannot preserve original Unicode.");
    }
    if (!needsEmbeddedFont.test(content)) continue;

    for (const element of [text, ...text.querySelectorAll("tspan")]) {
      const weight = inheritedAttribute(element, "font-weight") ?? "400";
      const style = inheritedAttribute(element, "font-style") ?? "normal";
      const bold = weight === "bold" || Number(weight) >= 600;
      const italic = style === "italic" || style === "oblique";
      const face: Face = bold ? (italic ? "bolditalic" : "bold") : (italic ? "italic" : "normal");
      // Only direct text belongs to this face; descendants can have another style.
      let firstSegment = true;
      for (const node of Array.from(element.childNodes).filter((child) => child.nodeType === 3)) {
        const content = node.textContent ?? "";
        if (!content) continue;
        const primary = await getFace("ChemDraftNotoSans", face);
        const segments: { family: Family; text: string }[] = [];
        for (const character of content) {
          const code = character.codePointAt(0)!;
          let font = primary;
          if (!primary.covers(code)) font = await getFace("ChemDraftDejaVuSans", face);
          if (!font.covers(code)) {
            throw new Error(`Cannot export PDF: embedded font ${face} does not support U+${code.toString(16).toUpperCase().padStart(4, "0")}.`);
          }
          font.used = true;
          const previous = segments.at(-1);
          if (previous?.family === font.family) previous.text += character;
          else segments.push({ family: font.family, text: character });
        }
        for (const segment of segments) {
          const span = svg.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "tspan");
          span.setAttribute("font-family", segment.family);
          span.setAttribute("font-weight", bold ? "700" : "400");
          span.setAttribute("font-style", italic ? "italic" : "normal");
          // Parent x/y, transforms, size, fill and anchor remain in place. svg2pdf
          // resolves ancestor dx/dy per span: apply those only to the first segment.
          if (!firstSegment) {
            span.setAttribute("dx", "0");
            span.setAttribute("dy", "0");
          }
          firstSegment = false;
          span.textContent = segment.text;
          element.insertBefore(span, node);
        }
        element.removeChild(node);
      }
    }
  }

  const browserFonts: FontFace[] = [];
  const fontSet = globalThis.document?.fonts;
  const release = () => { for (const font of browserFonts) fontSet?.delete(font); };
  try {
    for (const { family, face, data, bytes, used } of fonts.values()) {
      if (!used) continue;
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
      // svg2pdf measures spans with browser SVG/canvas APIs. Supply the same font
      // to those APIs during export; the headless DOM has no FontFace API.
      if (typeof globalThis.FontFace === "function" && fontSet) {
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

// Inspect the vendored TTF's Windows Unicode BMP cmap before registering it:
// a fallback-only run must not embed an unused primary face (or vice versa).
function bmpCoverage(bytes: Uint8Array): (code: number) => boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < view.getUint16(4); i++) {
    const record = 12 + i * 16;
    if (view.getUint32(record) !== 0x636d6170) continue; // cmap
    const cmap = view.getUint32(record + 8);
    for (let j = 0; j < view.getUint16(cmap + 2); j++) {
      const encoding = cmap + 4 + j * 8;
      if (view.getUint16(encoding) !== 3 || view.getUint16(encoding + 2) !== 1) continue;
      const table = cmap + view.getUint32(encoding + 4);
      if (view.getUint16(table) !== 4) continue;
      const count = view.getUint16(table + 6) / 2;
      const starts = table + 16 + count * 2;
      const deltas = starts + count * 2;
      const ranges = deltas + count * 2;
      return (code) => {
        if (code > 0xffff) return false;
        if (code <= 32) return true;
        for (let segment = 0; segment < count; segment++) {
          const end = view.getUint16(table + 14 + segment * 2);
          if (code > end) continue;
          const start = view.getUint16(starts + segment * 2);
          if (code < start) return false;
          const address = ranges + segment * 2;
          const range = view.getUint16(address);
          const glyph = range ? view.getUint16(address + range + 2 * (code - start)) : code;
          return (range && !glyph) ? false : ((glyph + view.getInt16(deltas + segment * 2)) & 0xffff) !== 0;
        }
        return false;
      };
    }
  }
  throw new Error("Cannot export PDF: embedded font has no Unicode BMP cmap.");
}

function inheritedAttribute(element: Element, name: string): string | null {
  for (let current: Element | null = element; current; current = current.parentElement) {
    const value = current.getAttribute(name);
    if (value !== null) return value;
  }
  return null;
}
