import { createRequire } from "node:module";

// Resolve the exporter's existing dependency, including its Node entry point. The CLI must
// measure with the same jsPDF build that renders the PDF, without adding another font engine.
const exporterRequire = createRequire(createRequire(import.meta.url).resolve("@chemdraft/export-engine/pdf"));
const svg2pdfRequire = createRequire(exporterRequire.resolve("svg2pdf.js"));
const fontFamilyParser = svg2pdfRequire("font-family-papandreou") as { parse(value: string): string[] };

interface PdfFont { fontStyle: string }
interface FontState { family: string; style: string; weight: string }

interface PdfMetrics {
  getFontList(): Record<string, string[]>;
  getFont(family?: string, style?: string): PdfFont;
  getStringUnitWidth(text: string, options: { font: PdfFont; fontSize: number; charSpace: number; doKerning: false }): number;
}

const fontAliases: Readonly<Record<string, string>> = {
  "sans-serif": "helvetica", verdana: "helvetica", arial: "helvetica",
  fixed: "courier", monospace: "courier", terminal: "courier",
  serif: "times", cursive: "times", fantasy: "times"
};

function ownAttribute(element: Element, name: string): string | undefined {
  return (element as SVGElement).style?.getPropertyValue(name) || element.getAttribute(name) || undefined;
}

function inheritedAttribute(element: Element | null, name: string): string | undefined {
  return element ? ownAttribute(element, name) || inheritedAttribute(element.parentElement, name) : undefined;
}

function fontSize(element: Element | null): number {
  if (!element) return 16;
  const value = (element as SVGElement).style?.getPropertyValue("font-size") || element.getAttribute("font-size");
  if (!value) return fontSize(element.parentElement);
  const size = parseFloat(value);
  if (!Number.isFinite(size)) return fontSize(element.parentElement);
  if (value.endsWith("em")) return size * fontSize(element.parentElement);
  if (value.endsWith("%")) return size / 100 * fontSize(element.parentElement);
  if (value.endsWith("pt")) return size * 96 / 72;
  return size;
}

/** Installed only while withPdfDom owns the serialized headless export. */
export function installPdfTextMetrics(prototype: SVGElement) {
  const { jsPDF } = exporterRequire("jspdf") as {
    jsPDF: { version: string; API: { events: [string, (this: PdfMetrics) => void][] } };
  };
  let pdf: PdfMetrics | undefined;
  // Capture the actual export instance so registered/embedded fonts, too, use their own
  // metrics. getStringUnitWidth accepts a font override without changing the rendering state.
  const listener: [string, (this: PdfMetrics) => void] = ["initialized", function () { pdf = this; }];
  jsPDF.API.events.push(listener);

  // svg2pdf 2.7.0 exports only svg2pdf, not its font helpers. Mirror
  // dist/svg2pdf.es.js:960–1006 (family/style resolution), 1673–1685 (parse order),
  // and 1786–1817 (applyAttributes). Reuse its actual family-list parser.
  // An alias wins even without the requested style; jsPDF supplies the fallback.
  const isJsPDF23 = jsPDF.version.split(".").slice(0, 2).join(".") === "2.3";
  function fontStyle(style: string, weight: string): string {
    // svg2pdf compares numeric CSS weights with loose equality.
    const numericWeight = Number(weight);
    if (isJsPDF23) {
      return numericWeight === 400 ? (style === "italic" ? "italic" : "normal")
        : numericWeight === 700 && style !== "italic" ? "bold" : style + weight;
    }
    return numericWeight === 400 || weight === "normal" ? (style === "italic" ? "italic" : "normal")
      : (numericWeight === 700 || weight === "bold") && style === "normal" ? "bold"
        : (numericWeight === 700 ? "bold" : weight) + style;
  }

  function applyFont(from: FontState, to: FontState, font: PdfFont): PdfFont {
    const styleChanged = to.style !== from.style || to.weight !== from.weight;
    if (to.family === from.family && !styleChanged) return font;
    return pdf!.getFont(fontAliases[to.family] ?? to.family,
      styleChanged ? fontStyle(to.style, to.weight) : font.fontStyle);
  }

  function elementFont(element: Element): { state: FontState; font: PdfFont } {
    const ancestors: Element[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) ancestors.unshift(node);
    let state: FontState = { family: "times", style: "normal", weight: "normal" };
    let font = pdf!.getFont(state.family, state.style);
    let textState = state;
    const available = pdf!.getFontList();
    for (const node of ancestors) {
      const nextStyle = ownAttribute(node, "font-style") ?? state.style;
      const nextWeight = ownAttribute(node, "font-weight") ?? state.weight;
      const requestedStyle = fontStyle(nextStyle, nextWeight);
      let nextFamily = state.family;
      const declaredFamily = ownAttribute(node, "font-family");
      if (declaredFamily) {
        nextFamily = fontFamilyParser.parse(declaredFamily).map((candidate) => {
          if (available[candidate]?.includes(requestedStyle)) return candidate;
          const lower = candidate.toLowerCase();
          return Object.hasOwn(fontAliases, lower) ? lower : undefined;
        }).find((candidate) => candidate !== undefined) ?? "times";
      }
      const next = { family: nextFamily, style: nextStyle, weight: nextWeight };
      // Nested tspans only accumulate SVG context during processTSpans. The
      // eventual draw compares their final context directly to the text's.
      if (node.localName !== "tspan") {
        font = applyFont(state, next, font);
        textState = next;
      }
      state = next;
    }
    if (element.localName === "tspan") font = applyFont(textState, state, font);
    return { state, font };
  }

  let enclosingText: { state: FontState; font: PdfFont } | undefined;
  const previousGetAttribute = Object.getOwnPropertyDescriptor(prototype, "getAttribute");
  const getAttribute = prototype.getAttribute;
  // TextNode.renderCore reads textLength at 2865, after RenderedNode.render
  // applies the enclosing <text> attributes at 1978–1979 and before ANY text
  // measurements. Capture both logical SVG attributes and the effective PDF
  // font here: unsupported CSS styles may already have fallen back in jsPDF.
  Object.defineProperty(prototype, "getAttribute", {
    configurable: true,
    value: function (this: SVGElement, name: string) {
      if (name === "textLength" && this.localName === "text" && pdf) {
        enclosingText = { state: elementFont(this).state, font: pdf.getFont() };
      }
      return getAttribute.call(this, name);
    }
  });

  function runFont(element: Element): PdfFont {
    const parent = element.parentElement;
    if (parent?.localName === "svg" && parent.parentElement === element.ownerDocument.body
      && parent.style.visibility === "hidden" && enclosingText) {
      // svgTextMeasure (4018–4027) carries svg2pdf's already-resolved run state,
      // including every ancestor tspan. Do NOT parse this family again: a
      // registered family name can itself contain a comma. TextChunk measures
      // at 2691/2706 before applying run attributes at 2752. That application
      // compares the flattened run state to the enclosing TEXT, not to each
      // ancestor tspan, so apply exactly one delta to the captured PDF font.
      return applyFont(enclosingText.state, {
        family: element.getAttribute("font-family")!,
        style: element.getAttribute("font-style")!,
        weight: element.getAttribute("font-weight")!
      }, enclosingText.font);
    }
    return elementFont(element).font;
  }

  function textWidth(element: Element): number {
    if (!pdf) throw new Error("Cannot measure PDF text before jsPDF is initialized.");
    const size = fontSize(element);
    const font = runFont(element);
    return Array.from(element.childNodes).reduce((width, node) => {
      if (node.nodeType === 3) {
        // pdf.text emits unkerned Tj; embedded TrueType widthOfString likewise
        // sums glyph advances without kerning. Match both paths.
        return width + pdf!.getStringUnitWidth(node.textContent ?? "", { font, fontSize: size, charSpace: 0, doKerning: false }) * size;
      }
      if (node.nodeType === 1 && (node as Element).localName === "tspan") {
        return width + textWidth(node as Element);
      }
      return width;
    }, 0);
  }

  return {
    textWidth,
    textBox(element: Element) {
      const width = textWidth(element);
      const size = fontSize(element);
      const anchor = inheritedAttribute(element, "text-anchor");
      const offset = anchor === "middle" ? width / 2 : anchor === "end" ? width : 0;
      return {
        x: parseFloat(element.getAttribute("x") || "0") - offset,
        y: parseFloat(element.getAttribute("y") || "0") - size,
        width,
        height: size
      };
    },
    restore() {
      if (previousGetAttribute) Object.defineProperty(prototype, "getAttribute", previousGetAttribute);
      else Reflect.deleteProperty(prototype, "getAttribute");
      const index = jsPDF.API.events.indexOf(listener);
      if (index >= 0) jsPDF.API.events.splice(index, 1);
    }
  };
}
