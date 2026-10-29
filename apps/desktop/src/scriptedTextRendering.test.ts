import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { exportDocumentToSvg } from "@chemdraft/export-engine";
import { scriptedTextDocument } from "../../../packages/export-engine/src/scriptedText.fixture";
import { MainWindow } from "./MainWindow";

describe("scripted text canvas/export parity", () => {
  it("passes absolute script font sizes and baselines unchanged through the canvas fragment renderer", () => {
    const document = scriptedTextDocument();
    const canvas = new JSDOM(renderToStaticMarkup(createElement(MainWindow, {
      initialDocument: document, initialPaletteMode: "hidden", nativePalette: true
    })));
    const exported = new JSDOM(exportDocumentToSvg(document).contents, { contentType: "image/svg+xml" });
    for (const object of document.pages[0].objects) {
      const attrs = (dom: JSDOM, selector: string) => [...dom.window.document.querySelectorAll(selector)].map(span => ({
        text: span.textContent, size: span.getAttribute("font-size"), y: span.getAttribute("y")
      }));
      const canvasSpans = attrs(canvas, `[data-page-svg-object-visual="${object.id}"] text tspan`);
      expect(canvasSpans.length).toBeGreaterThan(0);
      expect(canvasSpans).toEqual(attrs(exported, `text[data-object-id="${object.id}"] tspan`));
      expect(canvasSpans.every(span => span.y !== null)).toBe(true);
      expect(canvasSpans.filter(span => span.size !== null).every(span => /^\d+(\.\d+)?px$/.test(span.size!))).toBe(true);
      expect(canvasSpans.some(span => span.size === "14.4px" || span.size === "21.6px")).toBe(true);
    }
    expect(canvas.window.document.querySelector("text [baseline-shift], text [font-size$='%']")).toBeNull();
    canvas.window.close();
    exported.window.close();
  });
});
