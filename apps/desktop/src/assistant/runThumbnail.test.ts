import { describe, expect, it } from "vitest";
import { applyPatch, createEmptyDocument, type TextObject } from "@chemdraft/chem-core";
import { ensureSvgFontsLoaded, exportDocumentToSvg } from "@chemdraft/export-engine";
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
  it("uses the canvas fallback for Sketch thumbnails while full SVG exports embed the font", async () => {
    const document = documentWith({ ...caption("sketch", 50),
      style: { fontFamily: "'Patrick Hand', Arial, Helvetica, sans-serif" } });
    const before = structuredClone(document);
    const uri = await runThumbnail(document, ["sketch"]);
    expect(uri).toBeDefined();
    expect(uri!.length).toBeLessThanOrEqual(ASSISTANT_PREVIEW_MAX_LENGTH);
    expect(svg(uri)).toContain('font-family="Arial, Helvetica, sans-serif"');
    expect(svg(uri)).not.toContain("@font-face");
    expect(svg(uri)).not.toContain("data:font/");
    expect(document).toEqual(before);
    await ensureSvgFontsLoaded(document);
    expect(exportDocumentToSvg(document).contents).toContain("data:font/ttf;base64,");
  });

  it("keeps a non-Sketch thumbnail byte-for-byte unchanged", async () => {
    const document = documentWith(caption("one", 50));
    const exported = exportDocumentToSvg(document, { pageIndex: 0, background: "transparent" }).contents;
    const body = exported.slice(exported.indexOf(">") + 1, exported.lastIndexOf("</svg>"));
    const expected = `<svg xmlns="http://www.w3.org/2000/svg" width="124" height="44" viewBox="0 0 124 44" role="img" aria-label="Assistant changes"><rect width="100%" height="100%" fill="white"/><g transform="scale(1)"><svg x="0" y="0" width="124" height="44" viewBox="38 48 124 44">${body}</svg></g></svg>`;
    expect(await runThumbnail(document, ["one"])).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(expected)}`);
  });

  it("omits an oversized SVG instead of returning a truncated data URI", async () => {
    const document = documentWith({ ...caption("large", 50), text: "x".repeat(ASSISTANT_PREVIEW_MAX_LENGTH) });
    expect((await runThumbnail(document, ["large"]))).toBeUndefined();
  });
  it("exports the union of touched bounds with 12px padding without editing the document", async () => {
    const document = documentWith(caption("one", 50), caption("two", 200), caption("outside", 800));
    const before = structuredClone(document);
    const uri = (await runThumbnail(document, ["one", "two"]));
    expect(uri).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(svg(uri)).toContain('viewBox="38 48 274 44"');
    expect(svg(uri)).toContain('width="274" height="44"');
    expect(svg(uri)).toContain("α &lt;script&gt; &amp; chemistry");
    expect(svg(uri)).not.toContain("<script>");
    expect(document).toEqual(before);
  });

  it("caps the outer viewBox to 1600px and scales the complete crop", async () => {
    const result = svg((await runThumbnail(documentWith(caption("wide", 50, 4000)), ["wide"])));
    const viewBox = result.match(/viewBox="([^"]+)"/)![1].split(" ").map(Number);
    expect(viewBox[2]).toBe(1600);
    expect(viewBox[3]).toBeLessThanOrEqual(1600);
    expect(result).toContain('viewBox="38 48 4024 44"');
    expect(result).toContain(`transform="scale(${1600 / 4024})"`);
  });

  it("returns no image for removed ids or an empty touched set", async () => {
    const document = documentWith(caption("one", 50));
    expect((await runThumbnail(document, ["deleted"]))).toBeUndefined();
    expect((await runThumbnail(document, []))).toBeUndefined();
  });

  it("includes crops from every touched page", async () => {
    const first = documentWith(caption("one", 50));
    const second = documentWith(caption("two", 200)).pages[0];
    const document = { ...first, pages: [first.pages[0], { ...second, id: "page_two" }] };
    const result = svg((await runThumbnail(document, ["one", "two"])));
    expect(result).toContain('viewBox="38 48 124 44"');
    expect(result).toContain('viewBox="188 48 124 44"');
    expect(result).toContain('width="124" height="88"');
  });

  it("uses the shared rotated text bounds", async () => {
    const document = documentWith({ ...caption("one", 50), rotation: 90 });
    const result = svg((await runThumbnail(document, ["one"])));
    // A 100×20 frame rotates about its center, giving a 20×100 frame plus padding.
    expect(result).toContain('width="44" height="124"');
  });

  it("keeps rotated graphics inside the crop using the canvas bounds helper", async () => {
    const initial = createEmptyDocument();
    const document = applyPatch(initial, { op: "addObject", pageId: initial.pages[0].id,
      object: { id: "rotated", type: "graphic", graphicKind: "rect", x: 50, y: 60,
        width: 100, height: 20, rotation: 90, style: {}, data: {} } });
    expect(svg((await runThumbnail(document, ["rotated"])))).toContain('width="44" height="124"');
  });
});
