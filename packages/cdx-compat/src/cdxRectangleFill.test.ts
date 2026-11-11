import { describe, expect, it } from "vitest";
import type { ChemDraftDocument, GraphicObject } from "@chemdraft/chem-core";
import { cdxElementToCdxml, readCdx, writeCdx } from "./cdxBinary";
import { exportDocumentToCdx, exportDocumentToCdxml, importCdx, openChemDraftPayload } from "./index";

// Independent synthetic CDX records: do not use the codec or tag table to build the input.
const u16 = (value: number) => [value & 255, value >>> 8 & 255];
const u32 = (value: number) => [...u16(value), ...u16(value >>> 16)];
const property = (tag: number, data: number[]) => [...u16(tag), ...u16(data.length), ...data];
const object = (tag: number, id: number, ...children: number[][]) =>
  [...u16(tag), ...u32(id), ...children.flat(), 0, 0];
const rectangle = (id: number, rectangleType?: number, fillType?: number, color?: number) => object(0x8007, id,
  property(0x0a00, u16(3)), // GraphicType = Rectangle
  property(0x0204, [20, 20 + id * 10, 60, 50 + id * 10].flatMap(value => u32(value * 65536))),
  ...(rectangleType === undefined ? [] : [property(0x0a03, u16(rectangleType))]),
  ...(rectangleType !== undefined && (rectangleType & 1) ? [property(0x0a3c, u16(400))] : []),
  ...(fillType === undefined ? [] : [property(0x0a37, u16(fillType))]),
  ...(color === undefined ? [] : [property(0x0301, u16(color))]));

function syntheticRectangles(...extra: number[][]): Uint8Array {
  const colors = [[65535, 65535, 65535], [0, 0, 0], [13107, 26214, 39321]];
  return new Uint8Array([
    ...new TextEncoder().encode("VjCD0100"), 4, 3, 2, 1, ...Array(10).fill(0),
    ...object(0x8000, 0,
      property(0x0300, [...u16(colors.length), ...colors.flatMap(color => color.flatMap(u16))]),
      object(0x8001, 1,
        rectangle(10, 0, 1, 4), // Explicit Plain / None, with a color that must not imply fill.
        rectangle(11, 8, 2, 4), // Filled / Solid, resolving color index 4 through the file's table.
        rectangle(12), // RectangleType, FillType and color absent entirely.
        ...extra))
  ]);
}

function requireDocument(result: ReturnType<typeof importCdx>): ChemDraftDocument {
  expect(result.document, JSON.stringify(result.warnings)).toBeDefined();
  expect(result.conflict).toBeUndefined();
  return result.document!;
}

function rectangles(document: ChemDraftDocument): GraphicObject[] {
  const graphics = document.pages.flatMap(page => page.objects)
    .filter((item): item is GraphicObject => item.type === "graphic" && item.graphicKind === "rect");
  expect(graphics).toHaveLength(document.pages.flatMap(page => page.objects).length);
  return graphics;
}

const routes = ["CDX", "CDXML", "CDXML->CDX"] as const;
function roundTrip(document: ChemDraftDocument, route: typeof routes[number]): ChemDraftDocument {
  if (route === "CDX") return requireDocument(importCdx(exportDocumentToCdx(document, { embedNativePayload: false }).bytes));
  const reopened = requireDocument(openChemDraftPayload(exportDocumentToCdxml(document, { embedNativePayload: false }).contents));
  return route === "CDXML" ? reopened
    : requireDocument(importCdx(exportDocumentToCdx(reopened, { embedNativePayload: false }).bytes));
}

describe("synthetic binary rectangle fills", () => {
  it("preserves absent fill properties, explicit no fill, palette colors and combined bits in the binary codec", () => {
    const bytes = syntheticRectangles(rectangle(13, 9, 2, 4), rectangle(14, 4, 4, 4));
    const decoded = readCdx(bytes);
    const graphics = decoded.kids.find(child => child.name === "page")!.kids;
    expect(graphics.map(graphic => [graphic.attrs.RectangleType, graphic.attrs.FillType, graphic.attrs.color])).toEqual([
      ["Plain", "None", "4"], ["Filled", "Solid", "4"], [undefined, undefined, undefined],
      ["RoundEdge Filled", "Solid", "4"], ["Shaded", "Shaded", "4"]
    ]);
    expect(readCdx(writeCdx(decoded))).toEqual(decoded);
  });

  it.each(routes)("keeps plain, solid colored and absent fills through CDX->%s", route => {
    const document = requireDocument(importCdx(syntheticRectangles()));
    const expected = ["none", "#336699", "none"];
    expect(rectangles(document).map(graphic => graphic.style.fillColor)).toEqual(expected);
    expect(rectangles(document).map(graphic => graphic.style.strokeColor)).toEqual(["#336699", "#336699", "#000000"]);
    expect(rectangles(roundTrip(document, route)).map(graphic => graphic.style.fillColor)).toEqual(expected);
  });

  describe.each([false, true])("combined rounded/filled rectangle (CDXML input=%s)", xmlInput => {
    it.each(routes)("preserves its fill through %s", route => {
      const bytes = syntheticRectangles(rectangle(13, 9, 2, 4));
      const document = requireDocument(xmlInput ? openChemDraftPayload(cdxElementToCdxml(readCdx(bytes))) : importCdx(bytes));
      const expected = ["none", "#336699", "none", "#336699"];
      expect(rectangles(document).map(graphic => graphic.style.fillColor)).toEqual(expected);
      expect(rectangles(document)[3].data.cornerRadiusPx).toBeGreaterThan(0);
      expect(rectangles(roundTrip(document, route)).map(graphic => graphic.style.fillColor)).toEqual(expected);
    });
  });

  it("imports a shaded rectangle as a visible fill", () => {
    const document = requireDocument(importCdx(syntheticRectangles(rectangle(14, 4, 4, 4))));
    expect(rectangles(document).map(graphic => graphic.style.fillColor)).toEqual(["none", "#336699", "none", "#336699"]);
    expect(rectangles(document)[3].style.fillMode).toBe("gloss");
  });
});

describe.each(routes)("CDXML rectangle combinations through %s", route => {
  it.each([
    "Filled", "RoundEdge Filled", "Shadow Filled", "RoundEdge Shadow Filled",
    "Dashed Filled", "RoundEdge Dashed Filled", "Shadow Dashed Filled", "RoundEdge Shadow Dashed Filled"
  ])("preserves fill, corners, shadow and dashes for %s", rectangleType => {
    const rounded = rectangleType.includes("RoundEdge");
    const shadow = rectangleType.includes("Shadow");
    const dashed = rectangleType.includes("Dashed");
    // Reverse the keyword order to also exercise order-independent import.
    const source = `<CDXML><colortable>
      <color r="1" g="1" b="1"/><color r="0" g="0" b="0"/><color r="0.2" g="0.4" b="0.6"/>
      </colortable><page id="1" BoundingBox="0 0 612 792">
      <graphic id="2" GraphicType="Rectangle" BoundingBox="20 20 80 60" color="4"
        RectangleType="${rectangleType.split(" ").reverse().join(" ")}" ${rounded ? 'CornerRadius="400"' : ""}/>
      </page></CDXML>`;
    const document = requireDocument(openChemDraftPayload(source));
    const before = rectangles(document)[0];
    expect(before.style.fillColor).toBe("#336699");
    expect(before.data.cornerRadiusPx).toBe(rounded ? 400 / 75 : undefined);
    expect(before.style.effect).toBe(shadow ? "shadow" : undefined);
    expect(before.style.strokeDasharray).toBe(dashed ? "3 4" : undefined);

    const exported = exportDocumentToCdxml(document, { embedNativePayload: false });
    expect(exported.contents).toContain(`RectangleType="${rectangleType}"`);
    const after = rectangles(roundTrip(document, route))[0];
    expect(after.style.fillColor).toBe("#336699");
    expect(after.data.cornerRadiusPx).toBe(before.data.cornerRadiusPx);
    expect(after.style.effect).toBe(before.style.effect);
    expect(after.style.strokeDasharray).toBe(before.style.strokeDasharray);
  });
});

describe.each([false, true])("distinct rectangle stroke and fill (CDXML input=%s)", xmlInput => {
  describe.each(routes)("through %s", route => {
    describe.each(["#ffffff", "#336699"])("fill %s", fillColor => {
      it.each([
        ...[0, 1, 2, 3, 16, 17, 18, 19].map(rectangleType => ({ rectangleType, cornerRadiusPx: undefined })),
        { rectangleType: 0, cornerRadiusPx: 0 }, { rectangleType: 16, cornerRadiusPx: 0 }
      ])("uses fill for plain rectangles and outline for rounded/shadowed rectangles: %o", ({ rectangleType, cornerRadiusPx }) => {
        const bytes = syntheticRectangles(rectangle(13, rectangleType, undefined, 3));
        const document = requireDocument(xmlInput ? openChemDraftPayload(cdxElementToCdxml(readCdx(bytes))) : importCdx(bytes));
        const before = rectangles(document)[3];
        // A native edit can express two colors that a visible CDXML/CDX rectangle cannot.
        before.style.strokeColor = "#000000";
        before.style.fillColor = fillColor;
        if (cornerRadiusPx !== undefined) before.data.cornerRadiusPx = cornerRadiusPx;
        const preserveOutline = Boolean(rectangleType & 3);

        const exported = route === "CDX"
          ? exportDocumentToCdx(document, { embedNativePayload: false })
          : exportDocumentToCdxml(document, { embedNativePayload: false });
        expect(exported.warnings).toContainEqual(expect.objectContaining({
          code: "cdxml.graphic_single_color", sourceObjectId: before.id,
          message: preserveOutline
            ? "CDXML graphics store a single color; the outline color was preserved and the distinct fill was not written."
            : "CDXML graphics store a single color; the visible fill was preserved and the distinct stroke color was dropped."
        }));
        const visible = "bytes" in exported ? cdxElementToCdxml(readCdx(exported.bytes)) : exported.contents;
        const emitted = [...visible.matchAll(/<graphic\b[^>]*>/g)].at(-1)![0];
        expect(emitted.includes("Filled")).toBe(!preserveOutline);
        // Omit explicit None so shadow rectangles retain their implicit white fill.
        expect(emitted).not.toContain('FillType="None"');
        if (!preserveOutline) expect(emitted).not.toContain("FillType=");
        const after = rectangles(roundTrip(document, route))[3];
        expect(after.style.strokeColor).toBe(preserveOutline ? "#000000" : fillColor);
        // Shadow without Filled defaults to white; rounded-only rectangles remain unfilled.
        expect(after.style.fillColor).toBe(preserveOutline ? (rectangleType & 2 ? "#ffffff" : "none") : fillColor);
        expect(after.data.cornerRadiusPx).toBe(before.data.cornerRadiusPx);
        expect(after.style.effect).toBe(before.style.effect);
        expect(after.style.strokeDasharray).toBe(before.style.strokeDasharray);
      });
    });
  });
});

it("round-trips a black outline and white shadow rectangle fill through CDXML and binary CDX", () => {
  const document = requireDocument(importCdx(syntheticRectangles(rectangle(13, 2, undefined, 3))));
  const before = rectangles(document)[3];
  expect(before.style.strokeColor).toBe("#000000");
  expect(before.style.fillColor).toBe("#ffffff");
  expect(before.style.effect).toBe("shadow");

  for (const route of ["CDXML", "CDX"] as const) {
    const after = rectangles(roundTrip(document, route))[3];
    expect(after.style.strokeColor, route).toBe("#000000");
    expect(after.style.fillColor, route).toBe("#ffffff");
    expect(after.style.effect, route).toBe("shadow");
  }
});

describe.each(routes)("matching rectangle colors through %s", route => {
  describe.each([0, 1, 2, 3, 16, 17, 18, 19])("rectangle bits %s", rectangleType => {
    it.each(["#000000", "#ffffff", "#336699"])("keeps both outline and fill %s", color => {
      const document = requireDocument(importCdx(syntheticRectangles(rectangle(13, rectangleType, undefined, 3))));
      const before = rectangles(document)[3];
      before.style.strokeColor = color.toUpperCase();
      before.style.fillColor = color;
      const exported = exportDocumentToCdxml(document, { embedNativePayload: false });
      const emitted = [...exported.contents.matchAll(/<graphic\b[^>]*>/g)].at(-1)![0];
      expect(emitted).toContain("Filled");
      expect(emitted).not.toContain("FillType=");
      expect(exported.warnings).not.toContainEqual(expect.objectContaining({ code: "cdxml.graphic_single_color" }));
      const after = rectangles(roundTrip(document, route))[3];
      expect(after.style.strokeColor).toBe(color);
      expect(after.style.fillColor).toBe(color);
    });
  });
});
