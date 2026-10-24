import { GState, TilingPattern, type jsPDF } from "jspdf";

type SvgRenderer = (svg: Element, pdf: jsPDF, options: {
  width: number; height: number; loadExternalStyleSheets: boolean
}) => Promise<unknown>;

/** svg2pdf ignores paint servers on text. Render the composite halo paint into a page-sized
 * PDF tiling paint. A luminosity soft mask carries the stroked glyphs, since PDF consumers
 * do not consistently support patterned text strokes. Both paths go through
 * the same SVG transforms, clipping, opacity and gradient implementation.
 * Unfilled documents and explicit background overrides retain the existing converter path byte for byte. */
export async function preparePdfHaloPaint(
  svg: Element, pdf: jsPDF, render: SvgRenderer, width: number, height: number
): Promise<() => void> {
  const halos = [...svg.querySelectorAll("[data-label-halo-paint]")];
  if (!halos.length) return () => {};
  const markers = new Map<string, string>();
  const internal = pdf.internal as unknown as {
    pages: Record<number, string[]>; write(...parts: string[]): void; newObject(): number
  };
  const masks: { name: string; stream: string; font: ReturnType<jsPDF["getFont"]>; objectId?: number }[] = [];
  pdf.addGState("halo-masks", new GState({}));
  (pdf as unknown as { __private__: { setPdfVersion(version: string): void } }).__private__.setPdfVersion("1.4");
  pdf.internal.events.subscribe("putResources", () => {
    for (const mask of masks) {
      const formId = internal.newObject();
      const font = mask.font as typeof mask.font & { objectNumber: number };
      internal.write([`<< /Type /XObject /Subtype /Form /BBox [0 0 ${width} ${height}]`,
        "/Group << /S /Transparency /CS /DeviceGray >>",
        `/Resources << /Font << /${font.id} ${font.objectNumber} 0 R >> >>`,
        `/Length ${mask.stream.length} >>`, "stream", mask.stream, "endstream", "endobj"].join("\n"));
      mask.objectId = internal.newObject();
      internal.write(`<< /Type /ExtGState /SMask << /S /Luminosity /G ${formId} 0 R /BC [0] >> >>\nendobj`);
    }
  });
  pdf.internal.events.subscribe("putGStateDict", () => {
    for (const mask of masks) internal.write(`/${mask.name} ${mask.objectId} 0 R`);
  });
  let markerNumber = 0x800080;
  for (const halo of halos) {
    const source = halo.querySelector("text")!;
    const key = halo.getAttribute("data-label-halo-paint")!;
    const patternSvg = svg.cloneNode(true) as Element;
    const originalTexts = [...svg.querySelectorAll("text")];
    const text = patternSvg.querySelectorAll("text")[originalTexts.indexOf(source)]!;
    const keep = new Set<Element>();
    for (let node: Element | null = text; node; node = node.parentElement) keep.add(node);
    const prune = (node: Element) => {
      node.removeAttribute("opacity");
      for (const child of [...node.children]) {
        if (child.tagName === "defs") continue;
        if (keep.has(child)) prune(child); else child.remove();
      }
    };
    prune(patternSvg);
    // Sample the same composite SVG paint in the same transformed label space, covering the
    // whole page. Both the original glyph and this rectangle resolve the identical paint server.
    const rect = patternSvg.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "rect");
    const paintSource = [...svg.querySelectorAll("pattern")].find((paint) => paint.id === key)!;
    for (const name of ["x", "y", "width", "height"]) rect.setAttribute(name, paintSource.getAttribute(name)!);
    rect.setAttribute("fill", source.getAttribute("stroke")!);
    rect.setAttribute("stroke", "none");
    text.replaceWith(rect);
    const pattern = new TilingPattern([0, 0, width, height], width, height);
    pdf.advancedAPI();
    pdf.beginTilingPattern(pattern);
    // beginTilingPattern starts a fresh stream while keeping advanced mode. Supply the opening
    // state/coordinate transform that svg2pdf normally gets from advancedAPI on a fresh page.
    internal.write("q", `1 0 0 -1 0 ${height} cm`);
    await render(patternSvg, pdf, { width, height, loadExternalStyleSheets: false });
    const stream = internal.pages[pdf.getCurrentPageInfo().pageNumber]!;
    const end = stream.length;
    pdf.advancedAPI();
    stream.length = end; // Switch mode for endTilingPattern without adding another transform.
    pdf.endTilingPattern(`pdf-halo-composite:${key}`, pattern);
    pdf.compatAPI();
    const patternId = (pattern as typeof pattern & { id: string }).id;
    // Unique stroke colours identify only these text calls; they never reach the output.
    let marker: string, encodedMarker: string;
    do {
      marker = `#${(markerNumber++ % 0x1000000).toString(16).padStart(6, "0")}`;
      // jsPDF rounds RGB channels to two decimals when emitting stroke colours.
      encodedMarker = "#" + [1, 3, 5].map((offset) =>
        Math.floor(Number((parseInt(marker.slice(offset, offset + 2), 16) / 255).toFixed(2)) * 255)
          .toString(16).padStart(2, "0")).join("");
    } while (markers.has(encodedMarker));
    markers.set(encodedMarker, patternId);
    for (const text of halo.querySelectorAll('text')) text.setAttribute('stroke', marker);
  }
  const originalText = pdf.text;
  pdf.text = function (...args: Parameters<jsPDF['text']>) {
    const paint = args[3]?.renderingMode === "stroke" ? markers.get(pdf.getDrawColor().toLowerCase()) : undefined;
    const page = internal.pages[pdf.getCurrentPageInfo().pageNumber]!;
    const start = page.length;
    const result = originalText.apply(pdf, args);
    if (paint) {
      const text = page.splice(start).join("\n");
      const matrix = args[3]?.angle;
      const strokeScale = typeof matrix === "object" ? Math.hypot(matrix.a, matrix.b) : 1;
      const name = `ChemDraftHalo${masks.length}`;
      masks.push({ name, font: pdf.getFont(), stream: [
        "q", `1 0 0 -1 0 ${height} cm`, "1 G", `${pdf.getLineWidth() * strokeScale} w`, "1 J", "1 j", text, "Q"
      ].join("\n") });
      internal.write("q", `/${name} gs`, "/Pattern cs", `/${paint} scn`, `0 0 ${width} ${height} re`, "f", "Q");
    }
    return result;
  } as jsPDF['text'];
  return () => { pdf.text = originalText; };
}
