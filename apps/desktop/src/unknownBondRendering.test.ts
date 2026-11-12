// @vitest-environment jsdom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { Resvg } from "@resvg/resvg-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { exportDocumentToSvg } from "@chemdraft/export-engine";
import { exportDocumentToPdf } from "@chemdraft/export-engine/pdf";
import { MainWindow } from "./MainWindow";

afterEach(() => vi.restoreAllMocks());

describe("unknown bond canvas/export parity", () => {
  it("keeps the same dotted geometry and stroke in the canvas, SVG and vector PDF", async () => {
    const document = createEmptyDocument();
    const molecule: MoleculeObject = {
      id: "m", type: "molecule", x: 0, y: 0, width: 100, height: 100, rotation: 0,
      style: { bondColor: "#123456", bondIndicatorShowQuery: false },
      structureFormat: "smiles", structure: "", superatoms: [], rGroups: [],
      atoms: [
        { id: "a", element: "C", x: 30, y: 30, formalCharge: 0 },
        { id: "b", element: "C", x: 52, y: 30, formalCharge: 0 }
      ],
      bonds: [{ id: "ab", fromAtomId: "a", toAtomId: "b", order: "unknown" }]
    };
    document.pages[0]!.objects = [molecule];
    const canvas = new JSDOM(renderToStaticMarkup(createElement(MainWindow, {
      initialDocument: document, initialPaletteMode: "hidden", nativePalette: true
    })));
    const exported = new JSDOM(exportDocumentToSvg(document).contents, { contentType: "image/svg+xml" });
    try {
      const selector = 'line[data-bond-id="ab"][data-bond-order="unknown"]';
      const attributes = (dom: JSDOM) => [...dom.window.document.querySelectorAll(selector)].map(element =>
        Object.fromEntries([...element.attributes].filter(attribute => attribute.name !== "class")
          .map(attribute => [attribute.name, attribute.value])));
      const canvasInk = attributes(canvas);
      expect(canvasInk).toHaveLength(1);
      expect(canvasInk).toEqual(attributes(exported));
      expect(canvasInk[0]).toMatchObject({ "stroke-linecap": "round", "stroke-dasharray": "0 5", stroke: "#123456" });

      // At normal zoom the exported ink really has several separate dots, not a solid line.
      const raster = new Resvg(exportDocumentToSvg(document, { outputWidth: 816, outputHeight: 1056 }).contents).render();
      const pixels = raster.pixels;
      let runs = 0, wasInk = false;
      for (let x = 28; x <= 54; x++) {
        const offset = (30 * raster.width + x) * 4;
        const isInk = pixels[offset]! < 200;
        if (isInk && !wasInk) runs++;
        wasInk = isInk;
      }
      expect(runs).toBeGreaterThanOrEqual(4);

      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
      const pdf = await exportDocumentToPdf(document, { compress: false, includePageGuides: false });
      const contents = Buffer.from(pdf.bytes).toString("latin1");
      const dashPatterns = [...contents.matchAll(/\[([\d. ]+)\]\s+[\d.]+ d/g)]
        .map(match => match[1]!.trim().split(/\s+/).map(Number));
      // Verify real PDF drawing operators, including zero-length dashes and round caps.
      expect(dashPatterns).toContainEqual([0, 5]);
      expect(contents).toMatch(/\b1 J\b/);
      expect(contents).not.toContain("/Subtype /Image");
      expect(pdf.warnings).toEqual([]);
    } finally {
      canvas.window.close();
      exported.window.close();
    }
  });
});
