// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createCustomPageLayout, deserializeDocument, serializeDocument, MinimalPageSizePresetIds, findPageSizePreset } from "@chemdraft/chem-core";
import { exportDocumentToSvg } from "@chemdraft/export-engine";
import { createPhase4Document, setDocumentCustomPageSize, setDocumentPageSize, setDocumentPageOrientation } from "./documentWorkflow";
import { PrintPageGuideOverlay } from "./PrintPageGuideOverlay";

describe("printed page outlines", () => {
  it.each(MinimalPageSizePresetIds)("tiles %s at its physical paper size without growing the DOM for large art spaces", presetId => {
    const layout = { ...createCustomPageLayout(100000, 100000, "inch"), orientation: "portrait" as const, printGuides: { enabled: true, presetId } };
    const markup = renderToStaticMarkup(createElement(PrintPageGuideOverlay, { layout }));
    const dom = new DOMParser().parseFromString(markup, "image/svg+xml");
    const pattern = dom.querySelector("pattern")!;
    const paper = findPageSizePreset(presetId);
    expect(Number(pattern.getAttribute("width"))).toBeCloseTo(paper.widthPx, 5);
    expect(Number(pattern.getAttribute("height"))).toBeCloseTo(paper.heightPx, 5);
    expect(dom.querySelector("svg")!.getAttribute("viewBox")).toBe("0 0 9600000 9600000");
    expect(dom.querySelectorAll("path")).toHaveLength(1);
    expect(dom.querySelector("path")!.getAttribute("stroke-dasharray")).toBe("1 4");
    expect(markup).toContain('aria-hidden="true"');
  });
  it.each([0.1, 0.5, 1, 2, 4])("keeps dots one screen pixel wide at zoom %s", scale => {
    const layout = { ...createCustomPageLayout(20, 30, "inch"), printGuides: { enabled: true, presetId: "letter" as const } };
    const markup = renderToStaticMarkup(createElement(PrintPageGuideOverlay, { layout, scale }));
    const dom = new DOMParser().parseFromString(markup, "image/svg+xml");
    expect(Number(dom.querySelector("path")!.getAttribute("stroke-width")) * scale).toBeCloseTo(1, 6);
    expect(Number(dom.querySelector("pattern")!.getAttribute("width"))).toBe(816);
  });
  it.each(["portrait", "landscape"] as const)("follows the page's %s setting", orientation => {
    const layout = { ...createCustomPageLayout(20, 30, "inch"), orientation, printGuides: { enabled: true, presetId: "letter" as const } };
    const markup = renderToStaticMarkup(createElement(PrintPageGuideOverlay, { layout }));
    const pattern = new DOMParser().parseFromString(markup, "image/svg+xml").querySelector("pattern")!;
    expect(Number(pattern.getAttribute("width"))).toBe(orientation === "landscape" ? 1056 : 816);
    expect(Number(pattern.getAttribute("height"))).toBe(orientation === "landscape" ? 816 : 1056);
  });
  it("keeps legacy drawings guide-free and hides disabled settings", () => {
    const layout = createCustomPageLayout(20, 30, "inch");
    expect(renderToStaticMarkup(createElement(PrintPageGuideOverlay, { layout }))).toBe("");
    expect(renderToStaticMarkup(createElement(PrintPageGuideOverlay, { layout: { ...layout, printGuides: { enabled: false, presetId: "a4" } } }))).toBe("");
  });
  it("saves guides with the art space, preserves chemistry, retains them on later size changes and never adds export ink", () => {
    const original = createPhase4Document("Page guides");
    const size = { width: 20, height: 30, unit: "inch" as const };
    const plain = setDocumentCustomPageSize(original, size);
    const guides = { enabled: true, presetId: "a4" as const };
    const changed = setDocumentCustomPageSize(original, { ...size, printGuides: guides });
    const reopened = deserializeDocument(serializeDocument(changed));
    expect(reopened.pages[0].layout.printGuides).toEqual(guides);
    expect(changed.pages[0].objects).toEqual(original.pages[0].objects);
    expect(changed.selection).toEqual(original.selection);
    expect(exportDocumentToSvg(changed).contents).toBe(exportDocumentToSvg(plain).contents);
    expect(setDocumentCustomPageSize(reopened, { ...size, width: 40 }).pages[0].layout.printGuides).toEqual(guides);
    expect(setDocumentPageSize(reopened, "a3").pages[0].layout.printGuides).toEqual(guides);
    expect(setDocumentPageOrientation(reopened, "landscape").pages[0].layout.printGuides).toEqual(guides);
    expect(setDocumentCustomPageSize(reopened, { ...size, printGuides: { ...guides, enabled: false } }).pages[0].layout.printGuides?.enabled).toBe(false);
  });
});
