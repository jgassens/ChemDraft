import { createRequire } from "node:module";

// Resolve the exporter's existing dependency, including its Node entry point. The CLI must
// measure with the same jsPDF build that renders the PDF, without adding another font engine.
const exporterRequire = createRequire(createRequire(import.meta.url).resolve("@chemdraft/export-engine/pdf"));

interface PdfMetrics {
  getFontList(): Record<string, string[]>;
  getFont(family?: string, style?: string): unknown;
  getStringUnitWidth(text: string, options: { font: unknown; fontSize: number; charSpace: number }): number;
}

const fontAliases: Readonly<Record<string, string>> = {
  "sans-serif": "helvetica", verdana: "helvetica", arial: "helvetica",
  fixed: "courier", monospace: "courier", terminal: "courier",
  serif: "times", cursive: "times", fantasy: "times"
};

function inheritedAttribute(element: Element | null, name: string): string | undefined {
  if (!element) return undefined;
  const inline = (element as SVGElement).style?.getPropertyValue(name);
  return inline || element.getAttribute(name) || inheritedAttribute(element.parentElement, name);
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
export function installPdfTextMetrics() {
  const { jsPDF } = exporterRequire("jspdf") as {
    jsPDF: { API: { events: [string, (this: PdfMetrics) => void][] } };
  };
  let pdf: PdfMetrics | undefined;
  // Capture the actual export instance so registered/embedded fonts, too, use their own
  // metrics. getStringUnitWidth accepts a font override without changing the rendering state.
  const listener: [string, (this: PdfMetrics) => void] = ["initialized", function () { pdf = this; }];
  jsPDF.API.events.push(listener);

  function textWidth(element: Element): number {
    if (!pdf) throw new Error("Cannot measure PDF text before jsPDF is initialized.");
    const size = fontSize(element);
    const weight = inheritedAttribute(element, "font-weight") ?? "normal";
    const italic = inheritedAttribute(element, "font-style") === "italic";
    const bold = weight === "bold" || weight === "700";
    const style = (bold ? "bold" : "") + (italic ? "italic" : "") || "normal";
    const available = pdf.getFontList();
    const families = (inheritedAttribute(element, "font-family") ?? "times")
      .split(",").map((family) => family.trim().replace(/^['"]|['"]$/g, ""));
    let family = "times";
    for (const candidate of families) {
      if (available[candidate]?.includes(style)) { family = candidate; break; }
      const alias = fontAliases[candidate.toLowerCase()];
      if (alias) { family = alias; break; }
    }
    const font = pdf.getFont(family, style);
    return Array.from(element.childNodes).reduce((width, node) => {
      if (node.nodeType === 3) {
        return width + pdf!.getStringUnitWidth(node.textContent ?? "", { font, fontSize: size, charSpace: 0 }) * size;
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
      const index = jsPDF.API.events.indexOf(listener);
      if (index >= 0) jsPDF.API.events.splice(index, 1);
    }
  };
}
