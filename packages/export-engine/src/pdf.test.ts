import {
  applyPatch,
  createEmptyDocument,
  createPageLayout,
  type UnknownCompatibilityObject
} from "@chemdraft/chem-core";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { exportDocumentToPdf } from "./pdf";

const timestamp = "2026-05-29T00:00:00.000Z";

describe("exportDocumentToPdf", () => {
  it("exports the active page as PDF bytes through the SVG renderer", async () => {
    const document = createEmptyDocument({ title: "PDF Export", now: timestamp });
    const result = await withPdfDom((domParser) => exportDocumentToPdf(document, { domParser }));

    expect(result.format).toBe("pdf");
    expect(result.kind).toBe("binary");
    expect(result.mimeType).toBe("application/pdf");
    expect(result.extension).toBe("pdf");
    expect(new TextDecoder().decode(result.bytes.slice(0, 5))).toBe("%PDF-");
    expect(result.bytes.length).toBeGreaterThan(1000);
    expect(result.warnings).toEqual([]);
  });

  it("accepts the PDF compression option", async () => {
    const document = createEmptyDocument({ title: "Uncompressed PDF Export", now: timestamp });
    const result = await withPdfDom((domParser) => exportDocumentToPdf(document, { domParser, compress: false }));

    expect(result.format).toBe("pdf");
    expect(new TextDecoder().decode(result.bytes.slice(0, 5))).toBe("%PDF-");
  });

  it("uses the ChemDraft page dimensions for the PDF media box", async () => {
    const document = applyPatch(
      createEmptyDocument({ title: "A4 PDF Export", now: timestamp }),
      {
        op: "updatePageLayout",
        pageId: "page_001",
        layout: createPageLayout("a4")
      },
      { now: timestamp }
    );
    const result = await withPdfDom((domParser) => exportDocumentToPdf(document, { domParser }));
    const pdfText = new TextDecoder("latin1").decode(result.bytes);

    expect(pdfText).toMatch(/\/MediaBox \[0 0 595\.275590551181\d* 841\.889763779527\d*\]/);
  });

  it("propagates SVG fallback warnings into the PDF export result", async () => {
    const unknownObject = {
      id: "unknown_pdf_001",
      type: "unknown-compatibility-object",
      x: 96,
      y: 144,
      width: 128,
      height: 48,
      rotation: 0,
      style: {},
      sourceFormat: "synthetic",
      sourceObjectType: "unsupported-shape",
      warning: "Synthetic unsupported object for PDF warning coverage."
    } satisfies UnknownCompatibilityObject;
    const document = applyPatch(
      createEmptyDocument({ title: "PDF Warning Propagation", now: timestamp }),
      { op: "addObject", pageId: "page_001", object: unknownObject },
      { now: timestamp }
    );
    const result = await withPdfDom((domParser) => exportDocumentToPdf(document, { domParser }));

    expect(new TextDecoder().decode(result.bytes.slice(0, 5))).toBe("%PDF-");
    expect(result.warnings).toEqual([
      {
        code: "export.svg.object_fallback",
        message: 'SVG export used a labeled fallback for object type "unknown-compatibility-object".',
        severity: "warning",
        objectId: "unknown_pdf_001"
      }
    ]);
  });
});

async function withPdfDom<T>(callback: (domParser: DOMParser) => Promise<T>): Promise<T> {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true
  });
  const writableGlobal = globalThis as typeof globalThis & Record<string, unknown>;
  const globalKeys = [
    "window",
    "document",
    "DOMParser",
    "Node",
    "Element",
    "SVGElement",
    "HTMLElement",
    "XMLSerializer",
    "getComputedStyle",
    "navigator"
  ] as const;
  const previousDescriptors = new Map<string, PropertyDescriptor | undefined>(
    globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(writableGlobal, key)])
  );
  const previousGetBBox = Object.getOwnPropertyDescriptor(dom.window.SVGElement.prototype, "getBBox");
  const previousGetContext = Object.getOwnPropertyDescriptor(dom.window.HTMLCanvasElement.prototype, "getContext");

  defineTestGlobal(writableGlobal, "window", dom.window);
  defineTestGlobal(writableGlobal, "document", dom.window.document);
  defineTestGlobal(writableGlobal, "DOMParser", dom.window.DOMParser);
  defineTestGlobal(writableGlobal, "Node", dom.window.Node);
  defineTestGlobal(writableGlobal, "Element", dom.window.Element);
  defineTestGlobal(writableGlobal, "SVGElement", dom.window.SVGElement);
  defineTestGlobal(writableGlobal, "HTMLElement", dom.window.HTMLElement);
  defineTestGlobal(writableGlobal, "XMLSerializer", dom.window.XMLSerializer);
  defineTestGlobal(writableGlobal, "getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
  defineTestGlobal(writableGlobal, "navigator", dom.window.navigator);
  Object.defineProperty(dom.window.SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 80, height: 16 })
  });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => null
  });

  try {
    return await callback(new dom.window.DOMParser());
  } finally {
    if (previousGetContext) {
      Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", previousGetContext);
    } else {
      Reflect.deleteProperty(dom.window.HTMLCanvasElement.prototype, "getContext");
    }
    if (previousGetBBox) {
      Object.defineProperty(dom.window.SVGElement.prototype, "getBBox", previousGetBBox);
    } else {
      Reflect.deleteProperty(dom.window.SVGElement.prototype, "getBBox");
    }
    for (const [key, descriptor] of previousDescriptors) {
      if (!descriptor) {
        Reflect.deleteProperty(writableGlobal, key);
      } else {
        Object.defineProperty(writableGlobal, key, descriptor);
      }
    }
  }
}

function defineTestGlobal(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    writable: true,
    value
  });
}
