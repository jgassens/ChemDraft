// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEmptyDocument, type BracketObject } from "@chemdraft/chem-core";
import { bracketLabelPlan } from "@chemdraft/layout-engine";
import { exportDocumentToSvg } from "./svg";
import { exportDocumentToPdf } from "./pdf";
import { extractPdfPositionedTextRuns } from "./pdf.testUtils";

let previousBBox: PropertyDescriptor | undefined;
beforeEach(() => {
  previousBBox = Object.getOwnPropertyDescriptor(SVGElement.prototype, "getBBox");
  Object.defineProperty(SVGElement.prototype, "getBBox", { configurable: true,
    value: () => ({ x: 0, y: 0, width: 80, height: 16 }) });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  if (previousBBox) Object.defineProperty(SVGElement.prototype, "getBBox", previousBBox);
  else Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  vi.restoreAllMocks();
});

it.each(["n", "m"])("exports the shared repeat label %s at the same SVG/PDF position and size", async label => {
  const document = createEmptyDocument();
  const closing: BracketObject = { id: "close", type: "bracket", bracketKind: "round", side: "close", pairId: "open",
    repeatUnit: true, label, x: 244, y: 120, width: 16, height: 64, rotation: 0, style: {}, containedObjectIds: [] };
  document.pages[0].objects = [{ ...closing, id: "open", x: 100, side: "open", label: undefined }, closing];
  const plan = bracketLabelPlan(closing)!;
  const svg = exportDocumentToSvg(document);
  const xml = new DOMParser().parseFromString(svg.contents, "image/svg+xml");
  const text = xml.querySelector("text")!;
  expect(xml.querySelectorAll("text")).toHaveLength(1);
  expect(text.textContent).toBe(label);
  expect(Number(text.getAttribute("x"))).toBe(plan.x);
  expect(Number(text.getAttribute("y"))).toBe(plan.y);
  expect(Number(text.getAttribute("font-size"))).toBeCloseTo(plan.fontSize, 10);
  expect(svg.warnings).toEqual([]);
  const pdf = await exportDocumentToPdf(document, { domParser: new DOMParser(), compress: false });
  const runs = extractPdfPositionedTextRuns(pdf.bytes);
  expect(runs).toHaveLength(1);
  expect(runs[0].text).toBe(label);
  expect(runs[0].x).toBeCloseTo((closing.x + plan.x) * 0.75, 5);
  expect(runs[0].y).toBeCloseTo((document.pages[0].height - closing.y - plan.y) * 0.75, 5);
  expect(runs[0].fontSize).toBeCloseTo(plan.fontSize * 0.75, 5);
  expect(pdf.warnings).toEqual([]);
});
