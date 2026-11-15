import { expect, it, vi } from "vitest";
import { createEmptyDocument } from "@chemdraft/chem-core";

const evaluated = vi.hoisted(() => vi.fn());
vi.mock("./fonts/PatrickHand-Regular", () => {
  evaluated();
  return { default: "font-payload" };
});

it("keeps entry/SVG imports and ordinary exports lazy, refuses unprepared Sketch, and shares one payload", async () => {
  const entry = await import("./index");
  const svg = await import("./svg");
  const document = createEmptyDocument();
  await entry.ensureSvgFontsLoaded(document);
  svg.exportDocumentToSvg(document);
  expect(evaluated).not.toHaveBeenCalled();

  document.pages.push({ ...document.pages[0]!, id: "second", objects: [{
    id: "text", type: "text", x: 10, y: 10, width: 80, height: 20, rotation: 0,
    style: { fontFamily: "'Patrick Hand', Arial, Helvetica, sans-serif" }, text: "OH", spans: []
  }] });
  await entry.ensureSvgFontsLoaded(document);
  expect(evaluated).not.toHaveBeenCalled();
  expect(() => svg.exportDocumentToSvg(document, { pageIndex: 1 })).toThrow(entry.HandwritingFontNotLoadedError);
  expect(evaluated).not.toHaveBeenCalled();

  await Promise.all([entry.ensureSvgFontsLoaded(document, { pageIndex: 1 }),
    entry.ensureSvgFontsLoaded(document, { pageIndex: 1 })]);
  expect(evaluated).toHaveBeenCalledTimes(1);
  expect(svg.exportDocumentToSvg(document, { pageIndex: 1 }).contents).toContain("base64,font-payload");
  const { loadHandwritingFont } = await import("./handwritingFont");
  expect((await loadHandwritingFont()).default).toBe("font-payload");
  expect(evaluated).toHaveBeenCalledTimes(1);
});
