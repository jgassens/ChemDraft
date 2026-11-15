// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { Resvg } from "@resvg/resvg-js";
import { createEmptyDocument, MoleculeObjectSchema } from "@chemdraft/chem-core";
import { planPageSvgRender } from "@chemdraft/layout-engine";
import { elementFragments } from "@chemdraft/layout-engine/testing";
import { exportDocumentToSvg } from "./svg";
import { exportDocumentToPdf } from "./pdf";

describe("wavy canvas/SVG/PDF/PNG parity", () => {
  it("exports the canvas cubic path verbatim to SVG, rasterises that ink, and retains every PDF curve", async () => {
    const doc = createEmptyDocument();
    const page = doc.pages[0]!;
    page.width = 120; page.height = 100;
    page.objects = [MoleculeObjectSchema.parse({
      id: "wave", type: "molecule", x: 0, y: 0, width: 120, height: 100,
      structureFormat: "smiles", structure: "CC",
      atoms: [{ id: "a", element: "C", x: 30, y: 50 }, { id: "b", element: "C", x: 90, y: 50 }],
      bonds: [{ id: "ab", fromAtomId: "a", toAtomId: "b", order: "single", display: { bondStyle: "wavy" } }]
    })];
    const canvas = planPageSvgRender(page).fragments.flatMap(elementFragments)
      .find(f => f.tag === "path" && f.attrs["data-bond-style"] === "wavy")!;
    const svg = exportDocumentToSvg(doc, { background: "transparent", outputWidth: 120, outputHeight: 100 });
    const parsed = new DOMParser().parseFromString(svg.contents, "image/svg+xml");
    expect(parsed.querySelector('path[data-bond-style="wavy"]')!.getAttribute("d")).toBe(canvas.attrs.d);
    const raster = new Resvg(svg.contents).render();
    // The native PNG path uses this same resvg SVG input. Compare complete RGBA ink with a
    // minimal SVG containing the canvas plan, independently of exporter grouping/metadata.
    const reference = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="100"><path d="${canvas.attrs.d}" fill="none" stroke="${canvas.attrs.stroke}" stroke-width="${canvas.attrs["stroke-width"]}" stroke-linecap="${canvas.attrs["stroke-linecap"]}"/></svg>`).render();
    expect(raster.pixels.equals(reference.pixels)).toBe(true);
    expect([...raster.asPng().slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    // No text in this carbon skeleton: the DOM supplies SVG paths directly to svg2pdf.
    const canvasContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    try {
      const result = await exportDocumentToPdf(doc, { domParser: new DOMParser(), compress: false });
      const pdf = Buffer.from(result.bytes).toString("latin1");
      expect((pdf.match(/ c\n/g) ?? []).length).toBe((String(canvas.attrs.d).match(/ C /g) ?? []).length);
      expect(result.warnings).toEqual([]);
    } finally { canvasContext.mockRestore(); }
    expect(svg.warnings).toEqual([]);
  });
});
