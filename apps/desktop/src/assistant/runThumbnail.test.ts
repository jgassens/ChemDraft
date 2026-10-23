import { describe, expect, it } from "vitest";
import { applyPatch, createEmptyDocument, type TextObject } from "@chemdraft/chem-core";
import { ASSISTANT_PREVIEW_MAX_LENGTH, runThumbnail } from "./runThumbnail";

const caption = (id: string, x: number, width = 100): TextObject => ({
  id, type: "text", x, y: 60, width, height: 20, rotation: 0, style: {}, text: "α <script> & chemistry", spans: []
});
function documentWith(...objects: TextObject[]) {
  let document = createEmptyDocument();
  for (const object of objects) document = applyPatch(document, { op: "addObject", pageId: document.pages[0].id, object });
  return document;
}
const svg = (uri: string | undefined) => decodeURIComponent(uri!.split(",").slice(1).join(","));

describe("run thumbnail", () => {
  it("omits an oversized SVG instead of returning a truncated data URI", () => {
    const document = documentWith({ ...caption("large", 50), text: "x".repeat(ASSISTANT_PREVIEW_MAX_LENGTH) });
    expect(runThumbnail(document, ["large"])).toBeUndefined();
  });
  it("exports the union of touched bounds with 12px padding without editing the document", () => {
    const document = documentWith(caption("one", 50), caption("two", 200), caption("outside", 800));
    const before = structuredClone(document);
    const uri = runThumbnail(document, ["one", "two"]);
    expect(uri).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(svg(uri)).toContain('viewBox="38 48 274 44"');
    expect(svg(uri)).toContain('width="274" height="44"');
    expect(svg(uri)).toContain("α &lt;script&gt; &amp; chemistry");
    expect(svg(uri)).not.toContain("<script>");
    expect(document).toEqual(before);
  });

  it("caps the outer viewBox to 1600px and scales the complete crop", () => {
    const result = svg(runThumbnail(documentWith(caption("wide", 50, 4000)), ["wide"]));
    const viewBox = result.match(/viewBox="([^"]+)"/)![1].split(" ").map(Number);
    expect(viewBox[2]).toBe(1600);
    expect(viewBox[3]).toBeLessThanOrEqual(1600);
    expect(result).toContain('viewBox="38 48 4024 44"');
    expect(result).toContain(`transform="scale(${1600 / 4024})"`);
  });

  it("returns no image for removed ids or an empty touched set", () => {
    const document = documentWith(caption("one", 50));
    expect(runThumbnail(document, ["deleted"])).toBeUndefined();
    expect(runThumbnail(document, [])).toBeUndefined();
  });

  it("includes crops from every touched page", () => {
    const first = documentWith(caption("one", 50));
    const second = documentWith(caption("two", 200)).pages[0];
    const document = { ...first, pages: [first.pages[0], { ...second, id: "page_two" }] };
    const result = svg(runThumbnail(document, ["one", "two"]));
    expect(result).toContain('viewBox="38 48 124 44"');
    expect(result).toContain('viewBox="188 48 124 44"');
    expect(result).toContain('width="124" height="88"');
  });

  it("uses the shared rotated text bounds", () => {
    const document = documentWith({ ...caption("one", 50), rotation: 90 });
    const result = svg(runThumbnail(document, ["one"]));
    // A 100×20 frame rotates about its center, giving a 20×100 frame plus padding.
    expect(result).toContain('width="44" height="124"');
  });

  it("keeps rotated graphics inside the crop using the canvas bounds helper", () => {
    const initial = createEmptyDocument();
    const document = applyPatch(initial, { op: "addObject", pageId: initial.pages[0].id,
      object: { id: "rotated", type: "graphic", graphicKind: "rect", x: 50, y: 60,
        width: 100, height: 20, rotation: 90, style: {}, data: {} } });
    expect(svg(runThumbnail(document, ["rotated"]))).toContain('width="44" height="124"');
  });
});
