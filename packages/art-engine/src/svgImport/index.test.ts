import { createEmptyDocument, DocumentObjectSchema, type GraphicObject } from "@chemdraft/chem-core";
import { exportDocumentToSvg } from "@chemdraft/export-engine";
import { Resvg } from "@resvg/resvg-js";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  convertSvgToShapes, SVG_IMPORT_MAX_DEPTH, SVG_IMPORT_MAX_ELEMENTS, SVG_IMPORT_MAX_EXPANDED_ELEMENTS, SVG_IMPORT_MAX_OBJECTS,
  SVG_IMPORT_MAX_PATH_CHARS, SVG_IMPORT_MAX_REFERENCE_DEPTH, SVG_IMPORT_MAX_SOURCE_CHARS,
  SvgImportError, type SvgImportFrame, type SvgImportReportCode
} from "./index";
import { planNativeArtVisual } from "../index";

const ns = "http://www.w3.org/2000/svg";
const domParser = new (new JSDOM("").window.DOMParser)();
const frame = { x: 0, y: 0, width: 100, height: 100, rotation: 0 };
const svg = (body: string, attributes = 'viewBox="0 0 100 100"') => `<svg xmlns="${ns}" ${attributes}>${body}</svg>`;
const convert = (body: string, pictureFrame: SvgImportFrame = frame, attrs?: string) => convertSource(svg(body, attrs), pictureFrame);
const thinClip = '<defs><clipPath id="c"><rect x="99.99999" width="10" height="100"/></clipPath></defs><rect width="100" height="100" clip-path="url(#c)"/>';
const edgeText = '<text x="50" y="40" font-size="20">WWWW</text>';
const gradientStops = '<stop stop-color="black"/><stop offset="1" stop-color="white"/>';
const gradientFill = '<rect x="10" y="10" width="40" height="20" fill="url(#paint)"/>';
function convertSource(source: string, pictureFrame: SvgImportFrame = frame) {
  let id = 0;
  return convertSvgToShapes(source, { frame: pictureFrame, idFactory: () => `object-${++id}`, domParser });
}
const onlyGraphic = (body: string, pictureFrame = frame, attrs?: string): GraphicObject => {
  const result = convert(body, pictureFrame, attrs);
  expect(result.report).toEqual({ exact: true, entries: [] });
  expect(result.objects).toHaveLength(1);
  expect(result.objects[0].type).toBe("graphic");
  DocumentObjectSchema.parse(result.objects[0]);
  return result.objects[0] as GraphicObject;
};

describe("SVG element conversion", () => {
  it.each([
    ['<path d="M10 20h30v20H10z"/>', "path", [10, 20, 30, 20]],
    ['<rect x="10" y="20" width="30" height="20"/>', "rect", [10, 20, 30, 20]],
    ['<rect x="10" y="20" width="30" height="20" rx="3" ry="4"/>', "path", [10, 20, 30, 20]],
    ['<circle cx="25" cy="30" r="10"/>', "ellipse", [15, 20, 20, 20]],
    ['<ellipse cx="25" cy="30" rx="15" ry="10"/>', "ellipse", [10, 20, 30, 20]],
    ['<line x1="40" y1="40" x2="10" y2="20" stroke="#000"/>', "line", [10, 20, 30, 20]],
    ['<polyline points="10,20 40,20 40,40" fill="none" stroke="#000"/>', "path", [10, 20, 30, 20]],
    ['<polygon points="10,20 40,20 40,40"/>', "path", [10, 20, 30, 20]],
    ['<rect x="10%" y="20%" width="30%" height="20%"/>', "rect", [10, 20, 30, 20]]
  ] as const)("converts %s to a native %s", (body, kind, bounds) => {
    const object = onlyGraphic(body);
    expect(object.graphicKind).toBe(kind);
    [object.x, object.y, object.width, object.height].forEach((value, index) => expect(value).toBeCloseTo(bounds[index], 5));
  });

  it("keeps native rect rounding and default paint", () => {
    const rect = onlyGraphic('<rect x="10" y="10" width="40" height="20" rx="8"/>');
    expect(rect.data.cornerRadiusPx).toBe(8);
    expect(rect.style).toMatchObject({ fillColor: "#000000", strokePaint: { kind: "none" } });
    const clamped = onlyGraphic('<rect x="10" y="10" width="40" height="20" ry="50"/>');
    expect(clamped.graphicKind).toBe("path");
  });

  it("preserves subpixel rect geometry when the native rect frame would widen it", () => {
    const rect = onlyGraphic('<rect x="10" y="10" width=".75" height="20"/>');
    expect(rect).toMatchObject({ graphicKind: "path", width: .75 });
  });

  it("returns editable groups with unique child ids and selects only the roots", () => {
    const result = convert('<g data-component="Example"><title>Drawing</title><rect width="20" height="20"/><g><circle cx="25" cy="25" r="2"/></g></g>');
    const [rect, circle, inner, outer] = result.objects;
    expect(inner).toMatchObject({ type: "group", childObjectIds: [circle.id] });
    expect(outer).toMatchObject({ type: "group", childObjectIds: [rect.id, inner.id] });
    expect(result.selectionIds).toEqual([outer.id]);
    expect(result.report.exact).toBe(true);
    for (const object of result.objects) DocumentObjectSchema.parse(object);
  });

  it("converts simple text with positioned native baseline and alignment", () => {
    const { objects, report } = convert('<text x="60" y="40" dx="2" dy="-3" text-anchor="middle" font-family="Arial" font-size="12" font-weight="bold" font-style="italic" letter-spacing="1" fill="#013" fill-opacity=".5"> Hi   SVG </text>');
    expect(report).toEqual({ exact: false, entries: [{ code: "svgImport.viewport_clip_not_kept",
      detail: expect.any(String), elementCount: 1 }] });
    const [text] = objects;
    expect(text).toMatchObject({ type: "text", text: "Hi SVG", style: {
      textAlign: "center", fontFamily: "Arial", fontSizePx: 12, fontWeight: 700, fontStyle: "italic",
      letterSpacingPx: 1, color: "rgba(0,17,51,0.5)"
    } });
    expect(text.y).toBeCloseTo(25);
    expect(text.x + text.width / 2).toBeCloseTo(62);
    DocumentObjectSchema.parse(text);
  });

  it("resolves nested use, instance style, href and xlink:href", () => {
    const result = convert(`<defs><path id="leaf" d="M0 0h5v5z"/><g id="copy" transform="translate(4 6)"><use href="#leaf" x="2"/></g></defs>
      <use href="#copy" x="10" y="12" fill="red"/><use xlink:href="#leaf" x="50" y="50" fill="#0f0"/>`,
    frame, 'viewBox="0 0 100 100" xmlns:xlink="http://www.w3.org/1999/xlink"');
    expect(result.report.exact).toBe(true);
    expect(result.objects.map(object => [object.type, object.x, object.y])).toEqual([
      ["graphic", 16, 18], ["group", 16, 18], ["graphic", 50, 50]
    ]);
    expect(result.objects[0].style.fillColor).toBe("red");
    expect(result.objects[2].style.fillColor).toBe("#00ff00");
  });

  it("maps a referenced symbol into the use viewport", () => {
    const { objects, report } = convert(`<defs><symbol id="icon" viewBox="10 20 10 10"><path d="M10 20h10v10H10z"/></symbol></defs>
      <use href="#icon" x="20" y="30" width="30" height="20"/>`);
    expect(report.exact).toBe(true);
    expect(objects[0]).toMatchObject({ x: 25, y: 30, width: 20, height: 20 });
  });

  it("bakes transform lists, nested transforms, viewBox origin, outer stretch and frame rotation", () => {
    const result = convert(`<g transform="translate(4 2) scale(2)"><line x1="2" y1="2" x2="6" y2="2" stroke="#000"/></g>`,
      { x: 100, y: 50, width: 80, height: 40, rotation: 90 }, 'width="20" height="20" viewBox="5 5 20 20"');
    expect(result.report.exact).toBe(true);
    const line = result.objects[0] as GraphicObject;
    expect(line.data.lineStart?.x).toBeCloseTo(158);
    expect(line.data.lineStart?.y).toBeCloseTo(42);
    expect(line.data.lineEnd?.x).toBeCloseTo(158);
    expect(line.data.lineEnd?.y).toBeCloseTo(74);
    expect(line.style.strokeWidth).toBeCloseTo(4);
  });

  it("preserves the SVG's own aspect rule inside the stretched picture", () => {
    const object = onlyGraphic('<rect x="5" y="5" width="20" height="20"/>',
      { ...frame, width: 120, height: 60 }, 'width="40" height="20" viewBox="5 5 20 20"');
    expect(object.x).toBeCloseTo(30, 5);
    expect(object.width).toBeCloseTo(60, 5);
    const stretched = onlyGraphic('<circle cx="15" cy="15" r="5"/>',
      { ...frame, width: 120, height: 60 }, 'width="40" height="20" viewBox="5 5 20 20" preserveAspectRatio="none"');
    expect(stretched).toMatchObject({ graphicKind: "path", x: 30, y: 15, width: 60, height: 30 });
    expect(stretched.data.pathD).toContain("A");
  });

  it("uses unrotated authored width and height when no viewBox is present", () => {
    const rect = onlyGraphic('<rect x="10" y="10" width="20" height="20"/>',
      { ...frame, width: 80, height: 80 }, 'width="40" height="40"');
    expect(rect).toMatchObject({ graphicKind: "rect" });
    expect(rect.x).toBeCloseTo(20, 5);
  });

  it("scales a butt line's width and dash lengths along different axes", () => {
    const line = onlyGraphic('<line x1="10" y1="10" x2="20" y2="10" stroke="black" stroke-width="2" stroke-dasharray="3 2" transform="scale(2 3)"/>');
    expect(line.style).toMatchObject({ strokeWidth: 6, strokeDasharray: "6 4" });
  });
});

describe("SVG paint and presentation", () => {
  it.each([
    ['fill="#123"', { fillColor: "#112233" }],
    ['stroke="#abc"', { strokeColor: "#aabbcc" }],
    ['stroke-width="2.5px"', { strokeWidth: 5 }],
    ['opacity=".5"', { opacity: 0.5 }],
    ['fill-opacity="55%"', { fillOpacity: 0.55 }],
    ['stroke-opacity=".4"', { strokeOpacity: 0.4 }],
    ['stroke-linecap="square"', { strokeLineCap: "square" }],
    ['stroke-linejoin="bevel"', { strokeLineJoin: "bevel" }],
    ['stroke-miterlimit="7"', { strokeMiterLimit: 7 }],
    ['stroke-dasharray="3 1, 4"', { strokeDasharray: "6 2 8" }]
  ] as const)("keeps %s", (attribute, expected) => {
    const stroke = attribute.startsWith("stroke=") ? "" : 'stroke="#000"';
    expect(onlyGraphic(`<path d="M10 10h10v10z" transform="scale(2)" ${stroke} ${attribute}/>`).style).toMatchObject(expected);
  });

  it("applies inheritance, CSS precedence, currentColor and per-shape opacity", () => {
    const result = convert(`<g fill="red" stroke="black" stroke-linejoin="miter" fill-opacity=".8" opacity=".5">
      <rect x="20" y="20" width="20" height="20" fill="green"
        style="fill:currentColor !important; fill:purple; color:#abc; stroke-linejoin:round; opacity:.2"/>
    </g>`);
    expect(result.report.exact).toBe(true);
    expect(result.objects[0].style).toMatchObject({
      fillColor: "#aabbcc", strokeColor: "black", opacity: 0.1, fillOpacity: 0.8, strokeLineJoin: "round"
    });
  });

  it("represents open fill and an open stroke as two editable paths", () => {
    const { objects, report } = convert('<polyline points="10,10 30,10 30,30" fill="red" stroke="black"/>');
    expect(report.exact).toBe(true);
    expect(objects).toHaveLength(3);
    expect(objects[0]).toMatchObject({ data: { pathD: "M0 0 L20 0 L20 20 Z" }, style: { fillColor: "red" } });
    expect(objects[1]).toMatchObject({ data: { pathD: "M0 0 L20 0 L20 20" }, style: { fillPaint: { kind: "none" } } });
    expect(objects[2].type).toBe("group");
  });

  it("keeps native no-stroke paint and normalizes alpha colors", () => {
    const rect = onlyGraphic('<rect x="20" y="20" width="20" height="20" fill="#1358" fill-opacity=".5" stroke-width="0" stroke="red"/>');
    expect(rect.style).toMatchObject({ fillColor: "#113355", fillOpacity: 68 / 255, strokePaint: { kind: "none" } });
    expect(planNativeArtVisual(rect).stroke.paint.kind).toBe("none");
    const rgb = onlyGraphic('<rect x="20" y="20" width="20" height="20" fill="rgb(34 51 68 / .5)"/>');
    expect(rgb.style).toMatchObject({ fillColor: "#223344", fillOpacity: .5 });
  });

  it("rewinds simple nested rings to preserve even-odd fill", () => {
    const ring = onlyGraphic('<path fill-rule="evenodd" d="M10 10H90V90H10Z M30 30H70V70H30Z"/>');
    expect(ring.data.pathD).toBe("M0 0 L80 0 L80 80 L0 80 Z M20 60 L60 60 L60 20 L20 20 Z");
  });

  it("keeps linear gradient units, transform, href inheritance and inherited stops", () => {
    const { objects, report } = convert(`<defs>
      <linearGradient id="stops" x2="50%" y2="0%"><stop offset="20%" stop-color="red"/><stop offset="10%" style="stop-color:#234;stop-opacity:.3"/><stop offset="100%" stop-color="blue"/></linearGradient>
      <linearGradient id="paint" href="#stops" gradientUnits="userSpaceOnUse" x1="10" gradientTransform="translate(10 0)"/>
    </defs><path d="M10 10h70v40H10z" fill="url(#paint)"/>`);
    expect(report.exact).toBe(true);
    expect(objects[0].style.fillPaint).toMatchObject({ kind: "linear-gradient", x1: 1 / 7, y1: 0, x2: 5 / 7, y2: 0,
      stops: [{ offset: .2, color: "red" }, { offset: .2, color: "#223344", opacity: .3 }, { offset: 1, color: "blue" }] });
  });

  it("keeps radial gradient focal point and radius after similarity transforms", () => {
    const shape = onlyGraphic(`<defs><radialGradient id="paint" cx=".4" cy=".5" fx=".35" r=".2">
      <stop stop-color="#abc"/><stop offset="1" stop-color="#def"/>
    </radialGradient></defs><path d="M10 10h40v40H10z" fill="url(#paint)"/>`);
    expect(shape.style.fillPaint).toMatchObject({ kind: "radial-gradient", units: "object",
      cx: .4, cy: .5, fx: .35, fy: .5, r: .2 });
  });

  it("uses interpolation from the referenced gradient's own ancestry", () => {
    const shape = onlyGraphic(`<defs color-interpolation="linearRGB" style="color-interpolation: initial">
      <linearGradient id="base" color-interpolation="linearRGB">${gradientStops}</linearGradient>
      <linearGradient id="paint" href="#base"/>
    </defs>${gradientFill}`);
    expect(shape.style.fillPaint?.kind).toBe("linear-gradient");
  });

  it("clips simple fill geometry and produces no objects for an empty intersection", () => {
    const defs = '<defs><clipPath id="trim" clipPathUnits="objectBoundingBox"><rect x=".25" width=".5" height="1"/></clipPath></defs>';
    const shape = onlyGraphic(defs + '<rect x="10" y="20" width="40" height="30" clip-path="url(#trim)"/>');
    expect(shape).toMatchObject({ x: 20, y: 20, width: 20, height: 30, graphicKind: "path" });
    const empty = convert(defs + '<rect x="150" y="150" width="40" height="30" clip-path="url(#trim)"/>');
    expect(empty).toEqual({ objects: [], selectionIds: [], report: { exact: true, entries: [] } });
    const disjoint = convert('<defs><clipPath id="c"><rect width="20" height="20"/></clipPath></defs>'
      + '<rect x="25" width="20" height="20" clip-path="url(#c)"/>');
    expect(disjoint).toEqual(empty);
  });

  it.each([90, 30])("reports rounding loss for a surviving intersection with a clip %s units wide", width => {
    const { objects, report } = convert(
      `<defs><clipPath id="c"><rect x="20.123451" width="${width}" height="1000"/></clipPath></defs>`
        + '<rect width="100" height="1000" clip-path="url(#c)"/>',
      { ...frame, height: 1000 }, 'width="100" height="1000"');
    expect(objects).toHaveLength(1);
    expect(report.exact).toBe(false);
    expect(report.entries).toContainEqual({ code: "svgImport.clip_not_kept",
      detail: expect.stringContaining("rounding"), elementCount: 1 });
  });

  it("resolves a clip use and leaves enclosed geometry unchanged", () => {
    const result = convert(`<defs><path id="boundary" d="M0 0h20v20H0z" fill="red"/>
      <clipPath id="c"><use x="10" y="20" href="#boundary"/></clipPath></defs>
      <g clip-path="url(#c)"><circle cx="20" cy="30" r="3"/><rect x="25" y="25" width="10" height="10"/></g>`);
    expect(result.report.exact).toBe(true);
    expect(result.objects[0]).toMatchObject({ graphicKind: "ellipse" });
    expect(result.objects[1]).toMatchObject({ x: 25, width: 5, graphicKind: "path" });
  });
});

describe("typed conversion reports and refusal limits", () => {
  const tiny = '<rect x="10" y="10" width="10" height="10"/>';
  const chain = Array.from({ length: SVG_IMPORT_MAX_REFERENCE_DEPTH + 1 }, (_, index) =>
    `<use id="ref${index}" href="#ref${index + 1}"/>`).join("");
  it.each([
    ["unsupported_element", "<switch/>"],
    ["unsupported_attribute", tiny.replace("/>", ' transform="not-a-transform"/>')],
    ["stylesheet_not_kept", `<style>rect { fill: red }</style>${tiny}`],
    ["invalid_geometry", '<path d="M potato"/>'],
    ["pattern_fill_not_kept", '<defs><pattern id="p"/></defs><rect width="10" height="10" fill="url(#p) red"/>'],
    ["mask_not_kept", '<rect width="10" height="10" mask="url(#missing)"/>'],
    ["filter_not_kept", '<rect width="10" height="10" filter="url(#missing)"/>'],
    ["image_not_kept", '<image width="10" height="10" href="data:image/png;base64,AA=="/>'],
    ["paint_not_kept", '<rect width="10" height="10" fill="url(#missing)"/>'],
    ["gradient_not_kept", '<defs><radialGradient id="r"><stop/><stop offset="1"/></radialGradient></defs><rect width="40" height="20" fill="url(#r)"/>'],
    ["clip_not_kept", '<defs><clipPath id="c"><line x2="10"/></clipPath></defs><rect width="10" height="10" clip-path="url(#c)"/>'],
    ["clip_curve_sampled", '<defs><clipPath id="c"><circle cx="20" cy="20" r="8"/></clipPath></defs><rect x="10" y="10" width="20" height="20" clip-path="url(#c)"/>'],
    ["viewport_clip_not_kept", '<line x1="1" y1="0" x2="40" y2="0" stroke="red"/>'],
    ["fill_rule_not_kept", '<path d="M5 5C10 30 30 10 40 40Z" fill-rule="evenodd"/>'],
    ["stroke_transform_approximated", '<circle cx="25" cy="25" r="8" stroke="red" transform="scale(2 1)"/>'],
    ["group_opacity_approximated", `<g opacity=".5">${tiny}${tiny}</g>`],
    ["text_not_kept", '<text x="10" y="30" transform="skewX(10)">hi</text>'],
    ["text_style_not_kept", '<text x="10" y="30" stroke="red">hi</text>'],
    ["reference_not_kept", '<use href="#missing"/>'],
    ["reference_cycle", '<defs><g id="g"><use href="#g"/></g></defs><use href="#g"/>'],
    ["reference_depth", `<defs>${chain}</defs><use href="#ref0"/>`]
  ] as const)("reports svgImport.%s", (code, body) => {
    const { report } = convert(body);
    expect(report.exact).toBe(false);
    const fullCode: SvgImportReportCode = `svgImport.${code}`;
    expect(report.entries).toContainEqual({ code: fullCode, detail: expect.any(String), elementCount: 1 });
  });

  it.each([
    ["thin clip", thinClip, "clip_not_kept"],
    ["text near the viewport edge", edgeText, "viewport_clip_not_kept"],
    ["linear RGB inherited through defs", `<defs color-interpolation="linearRGB">
      <linearGradient id="paint">${gradientStops}</linearGradient></defs>${gradientFill}`, "gradient_not_kept"],
    ["linear RGB inherited from inline style", `<defs color-interpolation="sRGB" style="color-interpolation:linearRGB">
      <linearGradient id="paint" color-interpolation="inherit" href="#base"/>
      <linearGradient id="base" color-interpolation="sRGB">${gradientStops}</linearGradient></defs>${gradientFill}`, "gradient_not_kept"],
    ["CSS overriding a zero root width", tiny, "unsupported_attribute", 'width="0" height="100" style="width:100px"'],
    ["visible tspan inside hidden text", '<text x="10" y="30" visibility="hidden"><tspan visibility="visible">visible</tspan></text>', "text_style_not_kept"],
    ["inherited nested viewport overflow", '<g overflow="visible"><svg width="8" height="8" overflow="inherit"><rect width="20" height="20"/></svg></g>', "viewport_clip_not_kept"],
    ["non-finite clip boundary", `<defs><clipPath id="c" transform="scale(1e200)"><rect x="1e200" width="1e200" height="10"/></clipPath></defs>
      <rect width="20" height="20" clip-path="url(#c)"/>`, "clip_not_kept"],
    ["non-finite nested viewport boundary", '<svg transform="scale(1e100)" width="1e210" height="1"><rect width="1e-100" height="1e-100"/></svg>', "viewport_clip_not_kept"],
    ["inherited even-odd clip rule", `<defs clip-rule="evenodd"><clipPath id="c"><path d="M0 0H90V90H0V0H90V90H0Z"/></clipPath></defs>
      <rect x="10" y="10" width="20" height="20" clip-path="url(#c)"/>`, "clip_not_kept"]
  ] as const)("reports losses in the %s scene", (_name, body, code, attrs?) => {
    const { report } = convert(body, frame, attrs);
    expect(report.exact).toBe(false);
    expect(report.entries).toContainEqual({ code: `svgImport.${code}`, detail: expect.any(String), elementCount: 1 });
  });

  it("counts affected source elements and groups identical detail entries", () => {
    const { report } = convert('<image/><image/>');
    expect(report.entries).toEqual([{ code: "svgImport.image_not_kept", detail: "Embedded SVG image element", elementCount: 2 }]);
  });

  const rejects = (fn: () => unknown, code: SvgImportError["code"], message: string) => {
    expect(fn).toThrowError(SvgImportError);
    expect(fn).toThrowError(expect.objectContaining({ code, message: expect.stringContaining(message) }));
  };
  it("refuses too many source elements", () => {
    rejects(() => convert("<g/>".repeat(SVG_IMPORT_MAX_ELEMENTS)), "element_limit", `${SVG_IMPORT_MAX_ELEMENTS} SVG elements`);
  });
  it("refuses too many output objects created by use", () => {
    const body = `<defs><g id="many">${tiny.repeat(250)}</g></defs>${'<use href="#many"/>'.repeat(81)}`;
    rejects(() => convert(body), "object_limit", `${SVG_IMPORT_MAX_OBJECTS} native objects`);
  });
  it("bounds repeated references even when they produce no objects", () => {
    const group = `<g id="empty">${"<title/>".repeat(250)}</g>`;
    const body = `<defs>${group}</defs>${'<use href="#empty"/>'.repeat(Math.ceil(SVG_IMPORT_MAX_EXPANDED_ELEMENTS / 252))}`;
    rejects(() => convert(body), "object_limit", `${SVG_IMPORT_MAX_EXPANDED_ELEMENTS} expanded SVG elements`);
  });
  it("refuses oversized source and expanded path data", () => {
    rejects(() => convert(`<path d="M${" ".repeat(SVG_IMPORT_MAX_PATH_CHARS)}"/>`), "path_limit",
      `${SVG_IMPORT_MAX_PATH_CHARS} source path-data characters`);
    const path = `<path id="p" d="M0 0H10V10Z${" ".repeat(5_000)}"/>`;
    const body = `<defs>${path}</defs>${'<use href="#p"/>'.repeat(400)}`;
    rejects(() => convert(body), "path_limit", `${SVG_IMPORT_MAX_PATH_CHARS} expanded path-data characters`);
  });
  it("refuses excessive SVG source size before XML parsing", () => {
    rejects(() => convertSource(" ".repeat(SVG_IMPORT_MAX_SOURCE_CHARS + 1)), "source_limit",
      `${SVG_IMPORT_MAX_SOURCE_CHARS} source characters`);
  });
  it("refuses excessive XML nesting", () => {
    const body = "<g>".repeat(SVG_IMPORT_MAX_DEPTH) + "</g>".repeat(SVG_IMPORT_MAX_DEPTH);
    rejects(() => convert(body), "depth_limit", `${SVG_IMPORT_MAX_DEPTH} SVG nesting levels`);
  });
  it("refuses malformed SVG and invalid frames", () => {
    rejects(() => convertSource(`<svg xmlns="${ns}">`), "invalid_svg", "well-formed SVG");
    rejects(() => convert(tiny, { ...frame, width: 0 }), "invalid_frame", "positive width and height");
  });
});

describe("exported SVG raster equivalence", () => {
  it.each([
    ["primitive strokes, rounding and opacity", `<rect x="8" y="10" width="45" height="22" rx="4" fill="#468" stroke="#234" stroke-width="3"/>
      <circle cx="60" cy="65" r="21" stroke="red" stroke-width="3" stroke-dasharray="4 2" fill="navy" opacity=".4"/>
      <line x1="24" y1="38" x2="40" y2="60" stroke="#455" stroke-width="4" stroke-linecap="round"/>`, frame],
    ["asymmetric viewBox and baked arc transform", `<g transform="translate(4 4) skewX(13)">
        <ellipse cx="35" cy="35" rx="21" ry="12" fill="#189"/><path d="M30 40A9 12 20 1 0 65 70L50 60z" fill="#d75"/>
      </g>`, { x: 25, y: 25, width: 112, height: 67, rotation: 27 }],
    ["open path fill and stroke and even-odd rings", `<polyline points="10,10 30,10 30,30" fill="red" stroke="#222" stroke-width="2"/>
      <path fill="#678" fill-rule="evenodd" d="M40 20H90V85H40Z M50 35H70V70H50Z"/>`, frame],
    ["use, clipping and gradients", `<defs><path id="shape" d="M0 0H25V25H0z"/>
        <clipPath id="c"><rect x="45" y="20" width="30" height="20"/></clipPath>
        <linearGradient id="l" x2="100%"><stop stop-color="red"/><stop offset="1" stop-color="blue" stop-opacity=".7"/></linearGradient>
        <radialGradient id="r" gradientTransform="translate(.05 .025)"><stop stop-color="#ee3"/><stop offset="1" stop-color="#113"/></radialGradient>
      </defs><use x="10" y="55" href="#shape" fill="url(#r)"/><rect x="9" y="10" width="25" height="30" fill="url(#l)"/>
      <polygon points="32,18 80,24 80,50 30,50" clip-path="url(#c)" fill="#23a"/>`, frame],
    ["text anchor and rotation", '<text x="50" y="40" text-anchor="middle" font-family="sans-serif" font-size="17" transform="rotate(18 50 40)">SVG art</text>', frame, "svgImport.viewport_clip_not_kept"]
  ] as const)("keeps %s within raster tolerance", (_name, body, pictureFrame, expectedLoss?) => {
    const authored = svg(body, 'width="100" height="100" viewBox="2 3 100 100"');
    const result = convertSource(authored, pictureFrame);
    expect(result.report).toEqual(expectedLoss
      ? { exact: false, entries: [{ code: expectedLoss, detail: expect.any(String), elementCount: 1 }] }
      : { exact: true, entries: [] });
    const size = 180;
    const document = createEmptyDocument({ title: "SVG import test" });
    Object.assign(document.pages[0]!, { objects: result.objects, width: size, height: size });
    const exported = exportDocumentToSvg(document, { outputWidth: size, outputHeight: size, background: "transparent" });
    expect(exported.warnings).toEqual([]);

    const { x, y, width, height, rotation } = pictureFrame;
    const reference = svg(`<g transform="rotate(${rotation} ${x + width / 2} ${y + height / 2})">
      <svg x="${x}" y="${y}" width="${width}" height="${height}" viewBox="0 0 100 100" preserveAspectRatio="none">${authored}</svg></g>`,
    `width="${size}" height="${size}"`);
    const render = (source: string) => new Resvg(source, { background: "white",
      fitTo: { mode: "zoom", value: 2 } }).render().pixels;
    const expected = render(reference), actual = render(exported.contents);
    expect(actual.length).toBe(expected.length);
    let ink = 0, largeDeltas = 0, error = 0;
    for (let i = 0; i < expected.length; i += 4) {
      const delta = Math.max(Math.abs(expected[i] - actual[i]),
        Math.abs(expected[i + 1] - actual[i + 1]), Math.abs(expected[i + 2] - actual[i + 2]));
      if (Math.min(expected[i], expected[i + 1], expected[i + 2]) < 250) ink++;
      if (delta > 20) largeDeltas++;
      error += delta;
    }
    expect(ink).toBeGreaterThan(10);
    // The transformed arc has the largest delta: 19 edge pixels out of 5,471
    // ink pixels at 2× (0.3473%). The other four scenes have no large deltas.
    expect(largeDeltas / ink).toBeLessThan(0.0035);
    expect(error / ink).toBeLessThan(2.8);
  });
});
