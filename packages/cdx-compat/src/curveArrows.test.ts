import { describe, expect, it } from "vitest";
import { type GraphicObject, type GraphicPathNode, type Point } from "@chemdraft/chem-core";
import { planNativeArtVisual } from "../../art-engine/src/index";
import { canonicalVisibleCdxml, exportDocumentToCdxml, openChemDraftPayload } from "./index";

// Entirely synthetic: the first point is beside a lone pair on N, the last is the midpoint of
// the C–C bond. The curve states positions, so importing it must not invent atom/bond anchors.
const cubic = "27 66 42 33 84 33 108 72";
const chemistry = `<fragment id="m1">
  <n id="n1" p="24 72" Element="7"/>
  <n id="c1" p="96 72"/><n id="c2" p="120 72"/>
  <b id="b1" B="c1" E="c2" Order="1"/>
</fragment><t id="lp1" p="26 66"><s>··</s></t>`;
const fixture = (attributes: string, points = cubic, extra = "") =>
  `<CDXML>${extra}<page id="p1">${chemistry}<curve id="curve1" CurvePoints="${points}" ${attributes}/></page></CDXML>`;

function importedCurve(contents: string) {
  const opened = openChemDraftPayload(contents);
  expect(opened.document, JSON.stringify(opened.warnings)).toBeDefined();
  expect(opened.warnings.filter(({ code }) => code === "cdxml.object_import_unsupported")).toHaveLength(0);
  const curve = opened.document!.pages[0].objects.find((object): object is GraphicObject => object.type === "graphic");
  expect(curve).toBeDefined();
  expect(curve).toMatchObject({ type: "graphic", graphicKind: "path", data: { artPathKind: "bezier" } });
  return { opened, curve: curve!, document: opened.document! };
}

function expectPoint(actual: Point | undefined, expectedPt: Point) {
  expect(actual).toBeDefined();
  expect(Math.abs(actual!.x * 0.75 - expectedPt.x)).toBeLessThan(0.01);
  expect(Math.abs(actual!.y * 0.75 - expectedPt.y)).toBeLessThan(0.01);
}

function expectNodes(actual: GraphicPathNode[] | undefined, expectedPt: GraphicPathNode[]) {
  expect(actual).toHaveLength(expectedPt.length);
  expectedPt.forEach((node, index) => {
    expectPoint(actual![index].point, node.point);
    for (const control of ["inControl", "outControl"] as const) {
      if (node[control]) expectPoint(actual![index][control], node[control]);
      else expect(actual![index][control]).toBeUndefined();
    }
  });
}

function roundTrip(contents: string) {
  const before = importedCurve(contents);
  const exported = exportDocumentToCdxml(before.document);
  expect(exported.contents).toContain("<curve ");
  expect(exported.contents).not.toContain("<arrow ");
  expect(exported.warnings).toEqual([]);
  expect(openChemDraftPayload(exported.contents).document).toEqual(before.document);
  // Strip the native payload: prove that standard CDXML, by itself, retains editable geometry.
  const after = importedCurve(canonicalVisibleCdxml(exported.contents));
  expect(after.curve.data).toEqual(before.curve.data);
  expect(after.curve.style).toEqual(before.curve.style);
  expect([after.curve.x, after.curve.y, after.curve.width, after.curve.height])
    .toEqual([before.curve.x, before.curve.y, before.curve.width, before.curve.height]);
  const beforeMolecule = before.document.pages[0].objects.find(object => object.type === "molecule");
  const afterMolecule = after.document.pages[0].objects.find(object => object.type === "molecule");
  expect(afterMolecule?.atoms).toEqual(beforeMolecule?.atoms);
  expect(afterMolecule?.bonds).toEqual(beforeMolecule?.bonds);
  return { ...before, exported, after };
}

describe("CDXML Bezier mechanism curves", () => {
  it("imports a full head from a lone pair to a bond midpoint with exact cubic controls", () => {
    const { curve, exported } = roundTrip(fixture('ArrowheadHead="Full" ArrowheadType="Solid"'));
    expect(curve.data.artToolId).toBe("curvedArrow90");
    expect(curve.data.markerStart).toBeUndefined();
    expect(curve.data.markerEnd?.kind).toBe("filled-arrow");
    expectNodes(curve.data.pathNodes, [
      { point: { x: 27, y: 66 }, outControl: { x: 42, y: 33 } },
      { point: { x: 108, y: 72 }, inControl: { x: 84, y: 33 } }
    ]);
    expect(exported.contents).toContain(`CurvePoints="${cubic}"`);
    const visual = planNativeArtVisual(curve, { coordinateSpace: "page" });
    expect(visual.pathD).toContain("C ");
    expect(visual.markerEnd?.kind).toBe("filled-arrow");
    expect(visual.markerEndTerminal).toBeDefined();
  });

  it.each([
    ['ArrowheadHead="Half" ArrowheadType="Solid"', "half-arrow", "fishhookCurved"],
    ['ArrowheadHead="Full" ArrowheadType="Half"', "half-arrow", "fishhookCurved"],
    ['ArrowheadHead="HalfLeft" ArrowheadType="Solid"', "half-arrow", "fishhookCurved"],
    ['ArrowheadHead="HalfRight" ArrowheadType="Solid"', "half-arrow", "fishhookCurved"],
    ['ArrowheadHead="Full" ArrowheadType="Angle"', "open-arrow", "curvedArrow90"],
    ['ArrowheadHead="Angle" ArrowheadType="Full"', "open-arrow", "curvedArrow90"]
  ])("retains the endpoint head attributes %s", (attributes, kind, tool) => {
    const { curve, exported } = roundTrip(fixture(attributes));
    expect(curve.data.markerEnd?.kind).toBe(kind);
    expect(curve.data.artToolId).toBe(tool);
    expect(exported.contents).toContain(attributes);
  });

  it("retains a head at the start without reversing the control points", () => {
    const { curve, exported } = roundTrip(fixture('ArrowheadTail="Half" ArrowheadType="Solid"'));
    expect(curve.data.markerStart?.kind).toBe("half-arrow");
    expect(curve.data.markerEnd).toBeUndefined();
    expect(exported.contents).toContain(`CurvePoints="${cubic}"`);
  });

  it.each(["Full", "Half"])("retains both heads, including a %s tail", tail => {
    const { curve, exported } = roundTrip(fixture(`ArrowheadHead="Full" ArrowheadTail="${tail}" ArrowheadType="Solid"`));
    expect(curve.data.markerEnd?.kind).toBe("filled-arrow");
    expect(curve.data.markerStart?.kind).toBe(tail === "Half" ? "half-arrow" : "filled-arrow");
    expect(exported.contents).toContain(`ArrowheadTail="${tail}"`);
    const visual = planNativeArtVisual(curve, { coordinateSpace: "page" });
    expect(visual.markerStartTerminal).toBeDefined();
    expect(visual.markerEndTerminal).toBeDefined();
  });

  it("keeps every segment of a multi-segment Bezier without approximation", () => {
    const points = "27.123456 66.234567 42 33 84 33 108 72 132 111 162 27 180 60";
    const { curve, opened, exported } = roundTrip(fixture('ArrowheadHead="Full"', points));
    expectNodes(curve.data.pathNodes, [
      { point: { x: 27.123456, y: 66.234567 }, outControl: { x: 42, y: 33 } },
      { point: { x: 108, y: 72 }, inControl: { x: 84, y: 33 }, outControl: { x: 132, y: 111 } },
      { point: { x: 180, y: 60 }, inControl: { x: 162, y: 27 } }
    ]);
    expect(opened.warnings.map(({ code }) => code)).toEqual(expect.not.arrayContaining(["cdxml.curve_points_preserved"]));
    expect(exported.contents).toContain(`CurvePoints="${points}"`);
    expect(planNativeArtVisual(curve, { coordinateSpace: "page" }).pathD?.match(/C /g)).toHaveLength(2);
  });

  it("also keeps incoming/knot/outgoing triples, including exterior handles", () => {
    const points = "24 70 27 66 42 33 84 33 108 72 132 111 162 27 180 60 190 70";
    const { curve, exported } = roundTrip(fixture('ArrowheadHead="Full"', points));
    expectNodes(curve.data.pathNodes, [
      { point: { x: 27, y: 66 }, inControl: { x: 24, y: 70 }, outControl: { x: 42, y: 33 } },
      { point: { x: 108, y: 72 }, inControl: { x: 84, y: 33 }, outControl: { x: 132, y: 111 } },
      { point: { x: 180, y: 60 }, inControl: { x: 162, y: 27 }, outControl: { x: 190, y: 70 } }
    ]);
    expect(exported.contents).toContain(`CurvePoints="${points}"`);
  });

  it("elevates a quadratic to an exactly equivalent native cubic", () => {
    const points = "0 0 45 90 90 0";
    const { curve, exported } = roundTrip(fixture('ArrowheadHead="Half"', points));
    expectNodes(curve.data.pathNodes, [
      { point: { x: 0, y: 0 }, outControl: { x: 30, y: 60 } },
      { point: { x: 90, y: 0 }, inControl: { x: 60, y: 60 } }
    ]);
    expect(exported.contents).toContain(`CurvePoints="${points}"`);
  });

  it.each(["", 'ArrowheadHead="None" ArrowheadTail="Unspecified" ArrowheadType="Half"', 'Closed="yes"'])(
    "keeps an unheaded curve as an editable native graphic (%s)", attributes => {
      const { curve } = roundTrip(fixture(attributes));
      expect(curve.data.markerStart).toBeUndefined();
      expect(curve.data.markerEnd).toBeUndefined();
      expect(curve.data.artToolId).toBeUndefined();
      expect(Boolean(curve.data.pathClosed)).toBe(attributes === 'Closed="yes"');
    }
  );

  it("retains custom color, explicit width, dash, Z and original head sizing attributes", () => {
    const attributes = 'ArrowheadHead="Full" ArrowheadType="Solid" HeadSize="1000" ArrowheadCenterSize="875" ArrowheadWidth="250" LineType="Dashed" LineWidth="1.125" color="2" Z="42"';
    const palette = '<colortable><color r="0.2" g="0.4" b="0.6"/></colortable>';
    const { curve, opened, exported } = roundTrip(fixture(attributes, cubic, palette));
    expect(curve.style).toMatchObject({ strokeColor: "#336699", strokeWidth: 1.5, strokeDasharray: "3 4" });
    for (const attribute of ['HeadSize="1000"', 'ArrowheadCenterSize="875"', 'ArrowheadWidth="250"', 'LineWidth="1.125"', 'LineType="Dashed"', 'Z="42"']) {
      expect(exported.contents).toContain(attribute);
    }
    expect(opened.warnings).toContainEqual(expect.objectContaining({ code: "cdxml.curve_head_size_approximation", sourceObjectId: curve.id }));
    expect(curve.compatibility?.unknown.cdxmlCurveAttributes).toMatchObject({ CurvePoints: cubic, color: "2" });
  });

  it("keeps root and page line-width defaults through visible export", () => {
    const contents = `<CDXML LineWidth="1.5" BoldWidth="3"><page LineWidth="1.125">
      <curve id="a" CurvePoints="${cubic}" ArrowheadHead="Full"/>
      <curve id="b" CurvePoints="${cubic}" ArrowheadHead="Half" LineType="Bold"/>
    </page></CDXML>`;
    const opened = openChemDraftPayload(contents);
    const curves = opened.document!.pages[0].objects as GraphicObject[];
    expect(curves.map(curve => curve.style.strokeWidth)).toEqual([1.5, 4]);
    const exported = exportDocumentToCdxml(opened.document!);
    const reopened = openChemDraftPayload(canonicalVisibleCdxml(exported.contents));
    expect((reopened.document!.pages[0].objects as GraphicObject[]).map(curve => curve.style.strokeWidth)).toEqual([1.5, 4]);
    expect(exported.warnings).toEqual([]);
  });

  it.each([
    ['ArrowheadHead="HalfRight"', "cdxml.curve_half_head_handedness_approximation"],
    ['ArrowheadHead="Full" ArrowheadType="Hollow"', "cdxml.curve_hollow_head_approximation"],
    ['ArrowheadHead="UnrecognizedHead"', "cdxml.curve_head_approximation"],
    ['ArrowheadHead="Full" LineType="Wavy"', "cdxml.curve_line_type_approximation"],
    ['ArrowheadHead="Full" LineWidth="invalid"', "cdxml.curve_line_width_approximation"]
  ])("names the visual approximation while retaining %s", (attributes, code) => {
    const { opened, curve, exported } = roundTrip(fixture(attributes));
    expect(opened.warnings).toContainEqual(expect.objectContaining({ code, sourceObjectId: curve.id }));
    expect(curve.compatibility?.warnings).toContainEqual(expect.objectContaining({ code, objectId: curve.id }));
    expect(exported.contents).toContain(attributes);
  });

  it("exports edited native nodes, heads, width and color instead of restoring stale source values", () => {
    const { curve, document } = importedCurve(fixture('ArrowheadHead="Full" LineWidth="0.6"'));
    curve.data.pathNodes![0].outControl = { x: 60, y: 30 };
    curve.data.markerStart = { kind: "half-arrow", sizePx: 14 };
    delete curve.data.markerEnd;
    curve.style.strokeColor = "#123456";
    curve.style.strokeWidth = 2.5;
    const exported = exportDocumentToCdxml(document);
    const after = importedCurve(canonicalVisibleCdxml(exported.contents));
    expect(after.curve.data.pathNodes).toEqual(curve.data.pathNodes);
    expect(after.curve.data.markerStart?.kind).toBe("half-arrow");
    expect(after.curve.data.markerEnd).toBeUndefined();
    expect(after.curve.style).toMatchObject({ strokeColor: "#123456", strokeWidth: 2.5 });
    expect(exported.contents).not.toContain(`CurvePoints="${cubic}"`);
  });

  it("preserves an unsupported point layout with a named warning and writes the original back", () => {
    const points = "0 0 10 10 20 0 30 10 40 0";
    const opened = openChemDraftPayload(`<CDXML><page><curve id="odd" CurvePoints="${points}" ArrowheadHead="Half"/></page></CDXML>`);
    expect(opened.document?.pages[0].objects[0].type).toBe("unknown-compatibility-object");
    expect(opened.warnings).toContainEqual(expect.objectContaining({ code: "cdxml.curve_points_preserved", message: expect.stringContaining('curve "odd"') }));
    expect(opened.warnings.map(({ code }) => code)).not.toContain("cdxml.object_import_unsupported");
    const exported = exportDocumentToCdxml(opened.document!);
    expect(exported.contents).toContain(`CurvePoints="${points}"`);
    expect(exported.contents).toContain('ArrowheadHead="Half"');
    expect(openChemDraftPayload(canonicalVisibleCdxml(exported.contents)).document?.pages[0].objects[0].type)
      .toBe("unknown-compatibility-object");
  });

  it.each([undefined, "", "0 0 NaN 20 30 40", "0 0 1"])("preserves malformed curve points (%s) without dropping the curve", points => {
    const attribute = points === undefined ? "" : `CurvePoints="${points}"`;
    const opened = openChemDraftPayload(`<CDXML><page><curve id="malformed" ${attribute} ArrowheadTail="Half"/></page></CDXML>`);
    expect(opened.document?.pages[0].objects[0].type).toBe("unknown-compatibility-object");
    expect(opened.warnings.map(({ code }) => code)).toContain("cdxml.curve_points_preserved");
    const exported = exportDocumentToCdxml(opened.document!);
    expect(exported.contents).toContain("<curve ");
    expect(exported.contents).toContain('ArrowheadTail="Half"');
    if (points !== undefined) expect(exported.contents).toContain(attribute);
    expect(exported.warnings).toEqual([]);
  });

  it("keeps the standalone arrow arc export form", () => {
    const opened = openChemDraftPayload(`<CDXML><page><arrow id="arc1" BoundingBox="10 10 100 100"
      Tail3D="10 55 0" Head3D="55 10 0" AngularSize="90" ArrowheadHead="Full" ArrowheadType="Solid"/></page></CDXML>`);
    const arrow = opened.document!.pages[0].objects[0] as GraphicObject;
    expect(arrow.data.artPathKind).toBe("arc");
    expect(arrow.data.markerEnd?.kind).toBe("filled-arrow");
    const exported = exportDocumentToCdxml(opened.document!);
    expect(exported.contents).toContain("<arrow ");
    expect(exported.contents).not.toContain("<curve ");
    const after = openChemDraftPayload(canonicalVisibleCdxml(exported.contents)).document!.pages[0].objects[0] as GraphicObject;
    expect(after.data.artPathKind).toBe("arc");
    expect(after.data.arcSweepRadians).toBeCloseTo(arrow.data.arcSweepRadians!);
    expect(after.data.markerEnd).toEqual(arrow.data.markerEnd);
  });

  it("imports a mechanism-heavy synthetic page without dropping curves", () => {
    const curves = Array.from({ length: 180 }, (_, index) =>
      `<curve id="c${index}" CurvePoints="${cubic}" ArrowheadHead="${index % 2 ? "Full" : "Half"}"/>`).join("");
    const opened = openChemDraftPayload(`<CDXML><page>${curves}</page></CDXML>`);
    expect(opened.document?.pages[0].objects).toHaveLength(180);
    expect(opened.document?.pages[0].objects.every(object => object.type === "graphic" && object.data.pathNodes?.length === 2)).toBe(true);
    expect(opened.warnings.map(({ code }) => code)).toEqual(["cdxml.external_subset_imported"]);
  });
});
