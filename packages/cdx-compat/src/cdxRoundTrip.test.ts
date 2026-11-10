import { describe, expect, it } from "vitest";
import { cdxmlFixtures } from "@chemdraft/fixtures";
import { createEmptyDocument, createPageLayout, createCustomPageLayout, pageMarginFromLayout, GraphicObjectSchema, GraphicObjectDataSchema, type ChemDraftDocument, type GraphicObject, type MoleculeObject, type PageLayout } from "@chemdraft/chem-core";
import { nativeSingleBondGraphMetadata, nativeSingleBondGraphSmiles } from "../../document-workflow-core/src/index";
import { XMLParser } from "fast-xml-parser";
import { cdxElementFromOrderedTree, cdxElementToCdxml, CDX_NATIVE_ENVELOPE_ATTRIBUTE, CDX_POINT3D_ORDER_ATTRIBUTE, readCdx, writeCdx, type CdxElement } from "./cdxBinary";
import { ChemDraftObjectTags, exportDocumentToCdxml, exportDocumentToCdx, importCdx, legacyVisibleCdxmlHash, openChemDraftPayload, visibleHashForCdxml } from "./index";
import { sha256Hex } from "./sha256";

const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", parseAttributeValue: false, trimValues: false });
const tree = (xml: string) => cdxElementFromOrderedTree(parser.parse(xml));
const bytesFromCdxml = (xml: string) => writeCdx(tree(xml));
const wrap = (content: string) => `<CDXML CreationProgram="ChemDraft"><page id="1" BoundingBox="0 0 612 792">${content}</page></CDXML>`;

describe("interchange graphics and page extent", () => {
  const elements = (node: CdxElement, name: string): CdxElement[] =>
    [...(node.name === name ? [node] : []), ...node.kids.flatMap(child => elements(child, name))];
  const attributes = (xml: string, name: string) => elements(tree(xml), name).map(element => element.attrs);
  const sourceGraphic = (id: number, subtype: string) => `<graphic id="${id}" GraphicType="Orbital" ${subtype}
    BoundingBox="20 30 80 90" color="4" Z="7" LineWidth="0.75" IgnoreWarnings="yes" attrib4a10="|x|010203"/>`;

  it.each([false, true])("imports a fragment's aromatic ring circle and retains its source attributes (binary=%s)", binary => {
    const circle = '<graphic id="30" GraphicType="Oval" OvalType="Circle" BoundingBox="35 35 65 65" color="4" LineWidth="1.5" Z="7" attrib4a10="|x|010203"/>';
    const atoms = [[50,20],[76,35],[76,65],[50,80],[24,65],[24,35]]
      .map(([x,y], i) => `<n id="${i + 10}" p="${x} ${y}"/>`).join("");
    const bonds = Array.from({ length: 6 }, (_, i) => `<b id="${i + 20}" B="${i + 10}" E="${(i + 1) % 6 + 10}" Order="1.5"/>`).join("");
    const source = wrap(`<fragment id="2">${atoms}${bonds}${circle}</fragment>`).replace('<page ',
      '<colortable><color r="1" g="1" b="1"/><color r="0" g="0" b="0"/><color r="0.2" g="0.4" b="0.6"/></colortable><page ');
    const input = binary ? importCdx(bytesFromCdxml(source)) : openChemDraftPayload(source);
    const document = requireDocument(input);
    const molecule = document.pages[0].objects.find(object => object.type === "molecule") as MoleculeObject;
    const graphic = document.pages[0].objects.find(object => object.type === "graphic") as GraphicObject;
    expect(molecule.bonds.map(bond => bond.order)).toEqual(Array(6).fill("aromatic"));
    expect(graphic.graphicKind).toBe("ellipse");
    expect(graphic.style.strokeColor).toBe("#336699");
    expect(graphic.style.strokeWidth).toBeCloseTo(2);
    expect(graphic.compatibility?.unknown.cdxmlGraphicAttributes).toMatchObject({ GraphicType: "Oval", OvalType: "Circle", color: "4", LineWidth: "1.5" });
    expect(graphic.compatibility?.unknown.cdxmlGraphicAttributes).toEqual(attributes(source, "graphic")[0]);
    const output = binary ? importCdx(exportDocumentToCdx(document).bytes) : openChemDraftPayload(exportDocumentToCdxml(document, { embedNativePayload: false }).contents);
    const reopened = requireDocument(output).pages[0].objects.find(object => object.type === "graphic") as GraphicObject;
    expect(reopened.graphicKind).toBe("ellipse");
    expect(reopened.style.strokeColor).toBe("#336699");
    expect(reopened.style.strokeWidth).toBeCloseTo(2);
    expect(reopened.compatibility?.unknown.cdxmlGraphicAttributes).toMatchObject({ GraphicType: "Oval", OvalType: "Circle", color: "4", LineWidth: "1.5" });
    expect(reopened.compatibility?.unknown.cdxmlGraphicAttributes).toEqual(attributes(source, "graphic")[0]);
  });

  it("names superseded display graphics when skipping them", () => {
    const input = openChemDraftPayload(wrap('<graphic id="8" GraphicType="Oval" OvalType="Circle" SupersededBy="9"/><graphic id="9" GraphicType="Oval" BoundingBox="20 20 40 40"/>'));
    expect(input.warnings.some(warning => warning.code === "cdxml.graphic_superseded" && warning.message.includes("8") && warning.message.includes("Oval"))).toBe(true);
  });

  describe.each([false, true])("imported ellipse style edits (binary=%s)", binary => {
    const source = (subtype: string) => wrap(`<graphic id="30" GraphicType="Oval" OvalType="${subtype}"
      BoundingBox="35 35 65 65" color="4" LineWidth="1.5000" Z="7" IgnoreWarnings="yes" attrib4a10="|x|010203"
      ${subtype === "Shadowed" ? 'ShadowSize="600"' : ""}/>`);
    const open = (xml: string) => requireDocument(binary ? importCdx(bytesFromCdxml(xml)) : openChemDraftPayload(xml));
    const write = (document: ChemDraftDocument) => {
      const result = binary ? exportDocumentToCdx(document, { embedNativePayload: false })
        : exportDocumentToCdxml(document, { embedNativePayload: false });
      const xml = "bytes" in result ? cdxElementToCdxml(readCdx(result.bytes)) : result.contents;
      return { ...result, xml, attrs: attributes(xml, "graphic")[0], reopened: openChemDraftPayload(xml) };
    };

    it.each(["Circle", "Filled", "Circle Shaded", "Shadowed"])("keeps unedited %s attributes verbatim", subtype => {
      const document = open(source(subtype));
      const graphic = document.pages[0].objects[0] as GraphicObject;
      expect(write(document).attrs).toEqual(graphic.compatibility?.unknown.cdxmlGraphicAttributes);
    });

    it.each([false, true])("writes a circle's edited fill and names its distinct stroke loss (legacy=%s)", legacy => {
      const document = open(source("Circle"));
      const graphic = document.pages[0].objects[0] as GraphicObject;
      if (legacy) delete graphic.compatibility!.unknown.cdxmlGraphicStyle;
      expect(write(document).attrs).toEqual(graphic.compatibility?.unknown.cdxmlGraphicAttributes);
      graphic.style.fillMode = "solid";
      graphic.style.fillColor = "#336699";
      const result = write(document);
      expect(result.attrs.OvalType).toBe("Filled");
      expect(result.attrs).toMatchObject({ Z: "7", IgnoreWarnings: "yes", attrib4a10: "|x|010203" });
      const reopened = requireDocument(result.reopened).pages[0].objects[0] as GraphicObject;
      expect(reopened.style).toMatchObject({ fillMode: "solid", fillColor: "#336699", strokeColor: "#336699" });
      expect(result.warnings).toContainEqual(expect.objectContaining({ code: "cdxml.graphic_single_color", sourceObjectId: graphic.id }));
    });

    it.each(["Filled", "Circle Shaded", "Shadowed"])("removes the source %s fill or effect", subtype => {
      const document = open(source(subtype));
      const graphic = document.pages[0].objects[0] as GraphicObject;
      graphic.style.fillColor = "none";
      delete graphic.style.fillMode;
      delete graphic.style.effect;
      const result = write(document);
      expect(result.attrs.OvalType).toBeUndefined();
      expect(result.attrs.ShadowSize).toBeUndefined();
      expect(result.attrs).toMatchObject({ Z: "7", IgnoreWarnings: "yes", attrib4a10: "|x|010203" });
      const reopened = requireDocument(result.reopened).pages[0].objects[0] as GraphicObject;
      expect(reopened.style.fillColor).toBe("none");
      expect(reopened.style.fillMode).toBeUndefined();
      expect(reopened.style.effect).toBeUndefined();
    });

    it("replaces shading with a solid fill when only fillMode changes", () => {
      const document = open(source("Circle Shaded"));
      const graphic = document.pages[0].objects[0] as GraphicObject;
      graphic.style.fillMode = "solid";
      const result = write(document);
      expect(result.attrs.OvalType).toBe("Filled");
      expect((requireDocument(result.reopened).pages[0].objects[0] as GraphicObject).style)
        .toMatchObject({ fillMode: "solid", fillColor: graphic.style.fillColor });
    });

    it("updates and removes imported dash and bold width attributes", () => {
      const document = open(source("Circle").replace('LineWidth="1.5000"', 'LineType="Bold" BoldWidth="4" LineWidth="1.5000"'));
      const graphic = document.pages[0].objects[0] as GraphicObject;
      graphic.style.strokeDasharray = "3 4";
      graphic.style.strokeWidth = 2;
      const result = write(document);
      expect(result.attrs.LineType).toBe("Dashed");
      expect(result.attrs.BoldWidth).toBeUndefined();
      expect((requireDocument(result.reopened).pages[0].objects[0] as GraphicObject).style)
        .toMatchObject({ strokeDasharray: "3 4", strokeWidth: 2 });
      delete graphic.style.strokeDasharray;
      expect(write(document).attrs.LineType).toBeUndefined();
    });

    it("names edited styles that visible ellipse attributes cannot express", () => {
      const document = open(source("Circle"));
      const graphic = document.pages[0].objects[0] as GraphicObject;
      graphic.style.fillColor = "#ff0000";
      graphic.style.fillMode = "solid";
      graphic.style.effect = "shadow";
      graphic.style.fillOpacity = 0.5;
      const result = write(document);
      expect(result.warnings).toContainEqual(expect.objectContaining({ sourceObjectId: graphic.id,
        message: expect.stringContaining("fillColor") }));
      expect(result.warnings).toContainEqual(expect.objectContaining({ sourceObjectId: graphic.id,
        message: expect.stringContaining("fillOpacity") }));
    });
  });

  it.each([
    'OvalType="Filled" OrbitalType="s"',
    'OvalType="Shaded" OrbitalType="p"',
    'OvalType="Circle Filled" OrbitalType="dz2"',
    'OvalType="Circle Shaded" OrbitalType="dxy"'
  ])("retains every source orbital CDXML attribute: %s", subtype => {
    const source = wrap(sourceGraphic(10, subtype).replace('/>', ' ExtraSourceAttribute="opaque &amp; exact"/>'));
    const document = requireDocument(openChemDraftPayload(source));
    const graphic = document.pages[0].objects[0] as GraphicObject;
    expect(graphic.graphicKind).toBe("unknown");
    expect(graphic.compatibility?.unknown.cdxmlGraphicAttributes).toEqual(attributes(source, "graphic")[0]);
    expect(attributes(exportDocumentToCdxml(document, { embedNativePayload: false }).contents, "graphic"))
      .toEqual(attributes(source, "graphic"));
    expect(openChemDraftPayload(exportDocumentToCdxml(document).contents).document).toEqual(document);
  });

  it("retains a Symbol and all its attributes in visible CDXML", () => {
    const source = wrap('<graphic id="12" GraphicType="Symbol" SymbolType="CirclePlus" BoundingBox="90 30 110 50" Z="9" color="6" LineWidth="1.5" SourceAttribute="keep"/>');
    const document = requireDocument(openChemDraftPayload(source));
    expect(attributes(exportDocumentToCdxml(document, { embedNativePayload: false }).contents, "graphic"))
      .toEqual(attributes(source, "graphic"));
  });

  it("keeps source coordinate spelling and reversed orbital bounds until geometry changes", () => {
    const source = wrap(sourceGraphic(10, 'OvalType="Filled" OrbitalType="s"').replace('20 30 80 90', '80.0000 90.000 20.00 30.0'));
    const document = requireDocument(openChemDraftPayload(source));
    expect(attributes(exportDocumentToCdxml(document, { embedNativePayload: false }).contents, "graphic"))
      .toEqual(attributes(source, "graphic"));
    const graphic = document.pages[0].objects[0] as GraphicObject;
    graphic.x += 40; graphic.y += 20;
    expect(attributes(exportDocumentToCdxml(document, { embedNativePayload: false }).contents, "graphic")[0].BoundingBox)
      .toBe("110 105 50 45");
  });

  it("preserves an orbital's custom source color at its original index", () => {
    const source = wrap(sourceGraphic(10, 'OvalType="Filled" OrbitalType="s"')).replace('<page ',
      '<colortable><color r="1" g="1" b="1"/><color r="0" g="0" b="0"/><color r="0.2" g="0.4" b="0.6"/></colortable><page ');
    const document = requireDocument(openChemDraftPayload(source));
    const result = exportDocumentToCdxml(document, { embedNativePayload: false });
    const exported = result.contents;
    expect(result.warnings.filter(warning => warning.code === "cdxml.graphic_color_approximation")).toEqual([]);
    expect(attributes(exported, "graphic")).toEqual(attributes(source, "graphic"));
    expect(requireDocument(openChemDraftPayload(exported)).pages[0].objects[0].style).toEqual(document.pages[0].objects[0].style);
    const binary = exportDocumentToCdx(document);
    expect(binary.warnings.filter(warning => warning.code === "cdxml.graphic_color_approximation")).toEqual([]);
    expect(requireDocument(importCdx(binary.bytes)).pages[0].objects[0].style).toEqual(document.pages[0].objects[0].style);
  });

  it.each([false, true])("warns when a native graphic's custom color is actually approximated (embedded=%s)", embedNativePayload => {
    const document = requireDocument(openChemDraftPayload(wrap('<graphic id="10" GraphicType="Rectangle" BoundingBox="20 30 80 90"/>')));
    document.pages[0].objects[0].style.strokeColor = "#336699";
    for (const result of [exportDocumentToCdxml(document, { embedNativePayload }), exportDocumentToCdx(document, { embedNativePayload })]) {
      const warning = result.warnings.find(warning => warning.code === "cdxml.graphic_color_approximation");
      expect(warning).toMatchObject({ sourceObjectId: document.pages[0].objects[0].id });
      expect(warning?.message).toContain("#336699");
      const visible = "bytes" in result ? cdxElementToCdxml(readCdx(result.bytes)) : result.contents;
      expect(attributes(visible, "graphic")[0].color).toBeUndefined();
      if (!embedNativePayload) expect(requireDocument(openChemDraftPayload(visible)).pages[0].objects[0].style.strokeColor).not.toBe("#336699");
    }
  });

  it("recognizes an unedited source orbital even when its axis frame differs from BoundingBox", () => {
    const source = wrap(sourceGraphic(10, 'OrbitalType="p" OvalType="Filled" Center3D="100 100 0" MajorAxisEnd3D="120 100 0" MinorAxisEnd3D="100 120 0"'));
    const document = requireDocument(openChemDraftPayload(source));
    expect(attributes(exportDocumentToCdxml(document, { embedNativePayload: false }).contents, "graphic"))
      .toEqual(attributes(source, "graphic"));
    expect(elements(readCdx(exportDocumentToCdx(document).bytes), "graphic"))
      .toEqual(elements(readCdx(bytesFromCdxml(source)), "graphic"));
  });

  it("retains filled, shaded, circle orbitals and a Symbol through binary CDX", () => {
    // CDX uses numeric orbital enums; dz2Plus is the standard binary spelling.
    const source = wrap(sourceGraphic(10, 'OvalType="Filled" OrbitalType="s"') +
      sourceGraphic(11, 'OvalType="Shaded" OrbitalType="p"') +
      sourceGraphic(12, 'OvalType="Circle Filled" OrbitalType="dz2Plus"') +
      sourceGraphic(13, 'OvalType="Circle Shaded" OrbitalType="dxy"') +
      '<graphic id="14" GraphicType="Symbol" SymbolType="CircleMinus" BoundingBox="90 30 110 50" color="6" Z="8"/>');
    const original = readCdx(bytesFromCdxml(source));
    const document = requireDocument(importCdx(writeCdx(original)));
    const exported = exportDocumentToCdx(document);
    expect(exported.warnings.filter(warning => warning.code === "cdx.unencodable_data")).toEqual([]);
    expect(elements(readCdx(exported.bytes), "graphic")).toEqual(elements(original, "graphic"));
    expect(importCdx(exportDocumentToCdx(document, { embedNativePayload: true }).bytes).document).toEqual(document);
  });

  it.each([false, true])("changes only orbital geometry after a move and resize (binary=%s)", binary => {
    const source = wrap(sourceGraphic(10, 'OvalType="Circle Shaded" OrbitalType="p" Center3D="50 60 0" MajorAxisEnd3D="80 60 0" MinorAxisEnd3D="50 90 0"'));
    const document = requireDocument(binary ? importCdx(bytesFromCdxml(source)) : openChemDraftPayload(source));
    const graphic = document.pages[0].objects[0] as GraphicObject;
    graphic.x += 40; graphic.y += 20; graphic.width *= 2; graphic.height *= 3;
    const exported = binary ? cdxElementToCdxml(readCdx(exportDocumentToCdx(document).bytes))
      : exportDocumentToCdxml(document, { embedNativePayload: false }).contents;
    const before = attributes(source, "graphic")[0], after = attributes(exported, "graphic")[0];
    const geometry = new Set(["BoundingBox", "Center3D", "MajorAxisEnd3D", "MinorAxisEnd3D"]);
    expect(Object.fromEntries(Object.entries(after).filter(([key]) => !geometry.has(key))))
      .toEqual(Object.fromEntries(Object.entries(before).filter(([key]) => !geometry.has(key))));
    expect(after.BoundingBox).toBe("50 45 170 225");
    expect(after.Center3D).toBe("110 135 0");
    expect(after.MajorAxisEnd3D).toBe("170 135 0");
  });

  const nativeGraphic = (data: GraphicObject["data"] = {}, graphicKind: GraphicObject["graphicKind"] = "path"): GraphicObject => ({
    id: "native_graphic", type: "graphic", graphicKind, x: 40, y: 40, width: 120, height: 80,
    rotation: 0, style: { strokeColor: "#000000", strokeWidth: 1 }, data
  });
  const documentWithGraphic = (graphic: GraphicObject) => {
    const document = createEmptyDocument(); document.pages[0].objects = [graphic]; return document;
  };

  it("reopens native arrows, arcs, orbitals and ovals with every graphic's original geometry", () => {
    const document = requireDocument(openChemDraftPayload(wrap(`
      <arrow id="2" BoundingBox="40 96 120 104" Head3D="120 100 7" Tail3D="40 100 -9" ArrowheadHead="Full"/>
      <arrow id="3" BoundingBox="40 160 120 240" Head3D="80 240 5" Tail3D="120 200 -6" Center3D="80 200 11" MajorAxisEnd3D="120 200 12" MinorAxisEnd3D="80 240 13" AngularSize="90" ArrowheadHead="Full"/>
      <graphic id="4" GraphicType="Orbital" OrbitalType="p" Center3D="240 50 17" MajorAxisEnd3D="280 50 -23" MinorAxisEnd3D="240 80 39"/>
      <graphic id="5" GraphicType="Oval" Center3D="330 160 19" MajorAxisEnd3D="360 160 -29" MinorAxisEnd3D="330 180 43"/>
    `)));
    const objects = document.pages[0].objects as GraphicObject[];
    expect(objects.map(object => object.type)).toEqual(["graphic", "graphic", "graphic", "graphic"]);
    expect(objects[0].data).toMatchObject({ lineStart: { x: 40 * 4 / 3, y: 100 * 4 / 3 }, lineEnd: { x: 120 * 4 / 3, y: 100 * 4 / 3 } });
    expect(objects[1].data).toMatchObject({ artPathKind: "arc", arcStartRadians: 0, arcSweepRadians: Math.PI / 2 });
    expect(objects[2]).toMatchObject({ x: expect.closeTo(200 * 4 / 3, 8), y: expect.closeTo(20 * 4 / 3, 8),
      width: expect.closeTo(80 * 4 / 3, 8), height: expect.closeTo(60 * 4 / 3, 8) });
    expect(objects[3]).toMatchObject({ graphicKind: "ellipse", x: expect.closeTo(300 * 4 / 3, 8), y: expect.closeTo(140 * 4 / 3, 8),
      width: expect.closeTo(60 * 4 / 3, 8), height: expect.closeTo(40 * 4 / 3, 8) });
    const exported = exportDocumentToCdx(document);
    expect(readCdx(exported.bytes).attrs[CDX_POINT3D_ORDER_ATTRIBUTE]).toBe("|x|78797A");
    const reopened = requireDocument(importCdx(exported.bytes));
    expect(reopened.pages[0].objects).toHaveLength(objects.length);
    reopened.pages[0].objects.forEach((object, index) => {
      const before = objects[index];
      expect(object.type).toBe("graphic");
      if (object.type !== "graphic") throw new Error("Expected graphic fixture");
      for (const key of ["x", "y", "width", "height"] as const) expect(object[key]).toBeCloseTo(before[key], 3);
      for (const key of ["lineStart", "lineEnd", "arcCenter"] as const) {
        if (!before.data[key]) continue;
        expect(object.data[key]?.x).toBeCloseTo(before.data[key].x, 3);
        expect(object.data[key]?.y).toBeCloseTo(before.data[key].y, 3);
      }
      for (const key of ["arcStartRadians", "arcSweepRadians"] as const) {
        if (before.data[key] !== undefined) expect(object.data[key]).toBeCloseTo(before.data[key], 4);
      }
    });
  });

  it("never writes an Unknown graphic for any native graphic kind or art path kind", () => {
    const kinds = GraphicObjectSchema._def.schema.shape.graphicKind._def.innerType.options;
    const paths = GraphicObjectDataSchema.shape.artPathKind.unwrap().options;
    for (const graphicKind of kinds) for (const artPathKind of [undefined, ...paths]) {
      const graphic = nativeGraphic({ artPathKind, lineStart: { x: 40, y: 60 }, lineEnd: { x: 160, y: 60 },
        pathControlPoint: artPathKind === "quadratic" ? { x: 100, y: 40 } : undefined,
        pathNodes: [ { point: { x: 40, y: 60 } }, { point: { x: 100, y: 40 } }, { point: { x: 160, y: 60 } } ],
        pathClosed: true }, graphicKind);
      const document = documentWithGraphic(graphic);
      for (const embedded of [false, true]) {
        const xml = exportDocumentToCdxml(document, { embedNativePayload: embedded }).contents;
        const binaryXml = cdxElementToCdxml(readCdx(exportDocumentToCdx(document, { embedNativePayload: embedded }).bytes));
        expect(xml, `${graphicKind}/${artPathKind}`).not.toContain('GraphicType="Unknown"');
        expect(binaryXml, `${graphicKind}/${artPathKind}`).not.toContain('GraphicType="Unknown"');
      }
    }
    const missing = exportDocumentToCdxml(documentWithGraphic(nativeGraphic({}, "unknown")), { embedNativePayload: false });
    expect(missing.contents).not.toContain("<graphic ");
    expect(missing.warnings).toContainEqual(expect.objectContaining({ code: "cdxml.graphic_not_written", sourceObjectId: "native_graphic", message: expect.stringContaining("NOT written") }));
  });

  it.each(["bezier", "quadratic", "arc", "polyline", "polygon"])("exports native %s paths as real curves with heads", kind => {
    const graphic = nativeGraphic({ ...(kind === "polygon" ? { pathD: "M 0 0 L 80 0 L 80 40 z" } : {
      artPathKind: kind as "bezier", pathNodes: kind === "bezier" || kind === "polyline" ? [
        { point: { x: 40, y: 80 }, outControl: { x: 60, y: 40 } },
        { point: { x: 140, y: 80 }, inControl: { x: 120, y: 40 } }
      ] : undefined,
      lineStart: { x: 40, y: 80 }, lineEnd: { x: 140, y: 80 },
      pathControlPoint: kind === "quadratic" ? { x: 90, y: 50 } : undefined,
      arcStartRadians: 0, arcSweepRadians: Math.PI,
      pathClosed: kind === "polyline"
    }), markerStart: { kind: "half-arrow" }, markerEnd: { kind: "filled-arrow" } });
    const document = documentWithGraphic(graphic);
    for (const xml of [exportDocumentToCdxml(document, { embedNativePayload: false }).contents,
      cdxElementToCdxml(readCdx(exportDocumentToCdx(document).bytes))]) {
      const curves = attributes(xml, "curve");
      expect(curves).toHaveLength(1);
      expect(curves[0]).toMatchObject({ ArrowheadHead: "Full", ArrowheadTail: "HalfLeft", ArrowheadType: "Solid" });
      expect(curves[0].CurvePoints.split(/\s+/).length).toBeGreaterThan(4);
      if (kind === "polygon" || kind === "polyline") expect(curves[0].Closed).toBe("yes");
    }
    expect(importCdx(exportDocumentToCdx(document, { embedNativePayload: true }).bytes).document?.pages[0].objects[0]).toEqual(graphic);
  });

  it("exports relative SVG Bezier shorthand and quadratic shorthand with their reflected controls", () => {
    const graphic = nativeGraphic({ pathD: "m 0 20 c 10 -20 20 -20 30 0 s 20 20 30 0 q 10 -20 20 0 t 20 0",
      markerEnd: { kind: "half-arrow" } });
    const xml = exportDocumentToCdxml(documentWithGraphic(graphic), { embedNativePayload: false }).contents;
    const curve = attributes(xml, "curve")[0];
    expect(curve.ArrowheadHead).toBe("HalfLeft");
    const reopened = requireDocument(openChemDraftPayload(xml)).pages[0].objects[0] as GraphicObject;
    expect(reopened.data.pathNodes).toHaveLength(5);
    expect(reopened.data.pathNodes?.[1].outControl).toEqual({ x: 80, y: 80 });
    expect(reopened.data.pathNodes?.[2].outControl?.x).toBeCloseTo(106.6666667, 3);
    expect(reopened.data.pathNodes?.[3].outControl?.y).toBeCloseTo(73.3333333, 3);
  });

  it.each([
    { style: { fillMode: "gloss" as const, fillColor: "#000000" }, code: "cdxml.graphic_gloss_payload_only" },
    { style: { effect: "reflection" as const }, code: "cdxml.graphic_effect_payload_only" }
  ])("warns about unsupported Bezier styling: $code", ({ style, code }) => {
    const graphic = nativeGraphic({ artPathKind: "bezier", pathClosed: true, pathNodes: [
      { point: { x: 40, y: 80 }, outControl: { x: 60, y: 40 } },
      { point: { x: 140, y: 80 }, inControl: { x: 120, y: 40 } }
    ] });
    Object.assign(graphic.style, style);
    const document = documentWithGraphic(graphic);
    for (const binary of [false, true]) for (const embedNativePayload of [false, true]) {
      const exported = binary ? exportDocumentToCdx(document, { embedNativePayload })
        : exportDocumentToCdxml(document, { embedNativePayload });
      const xml = "bytes" in exported ? cdxElementToCdxml(readCdx(exported.bytes)) : exported.contents;
      expect(attributes(xml, "curve")).toHaveLength(1);
      const limitations = exported.warnings.filter(warning => warning.code === code);
      expect(limitations).toHaveLength(1);
      expect(limitations[0].sourceObjectId).toBe(graphic.id);
      if (!embedNativePayload) expect(limitations[0].message).toContain("NOT written");
      const opened = "bytes" in exported ? importCdx(exported.bytes) : openChemDraftPayload(exported.contents);
      expect(opened.conflict).toBeUndefined();
      if (embedNativePayload) expect(opened.document).toEqual(document);
      else {
        const visible = requireDocument(opened).pages[0].objects[0];
        expect(visible.style.fillMode).not.toBe("gloss");
        expect(visible.style.effect).not.toBe("reflection");
      }
    }
  });

  it.each([
    { axis: "x", magnitude: 1.7e308 }, { axis: "y", magnitude: 1.7e308 },
    // The point extent is finite here, but converting the fitted size back to native units overflows.
    { axis: "x", magnitude: 1e308 }, { axis: "y", magnitude: 1e308 }
  ])("retains finite coordinates when fitting $axis positions at ±$magnitude would overflow", ({ axis, magnitude }) => {
    const document = documentWithGraphic(nativeGraphic({}, "rect"));
    document.pages[0].objects = [-magnitude, magnitude].map((position, index) => ({
      ...nativeGraphic({}, "rect"), id: `extreme_${index}`, x: -40, y: -40, [axis]: position
    }));
    const exported = exportDocumentToCdxml(document, { embedNativePayload: false });
    expect(exported.warnings).toContainEqual(expect.objectContaining({
      code: "cdxml.page_fit_unrepresentable", sourceObjectId: document.pages[0].id
    }));
    expect(exported.contents).not.toMatch(/Infinity|NaN/);
    const page = attributes(exported.contents, "page")[0];
    expect(page.attrib4346).toBeUndefined();
    const pageBounds = page.BoundingBox.split(" ").map(Number);
    expect(pageBounds.every(Number.isFinite)).toBe(true);
    expect(pageBounds[2]).toBeGreaterThanOrEqual(612);
    expect(pageBounds[3]).toBeGreaterThanOrEqual(792);
    const coordinateIndex = axis === "x" ? 0 : 1;
    const bounds = attributes(exported.contents, "graphic").map(graphic => graphic.BoundingBox.split(" ").map(Number));
    expect(bounds.map(box => box[coordinateIndex])).toEqual([-magnitude * 0.75, magnitude * 0.75]);
    expect(bounds.map(box => box[1 - coordinateIndex])).toEqual([-30, -30]);
  });

  it.each([false, true])("sizes the page around faraway content (binary=%s)", binary => {
    const document = documentWithGraphic({ ...nativeGraphic({}, "rect"), x: 5000, y: 4300 });
    const xml = binary ? cdxElementToCdxml(readCdx(exportDocumentToCdx(document).bytes))
      : exportDocumentToCdxml(document, { embedNativePayload: false }).contents;
    const page = attributes(xml, "page")[0];
    const [, , right, bottom] = page.BoundingBox.split(" ").map(Number);
    expect(right).toBeGreaterThan((5000 + 120) * 0.75);
    expect(bottom).toBeGreaterThan((4300 + 80) * 0.75);
    expect(attributes(xml, "graphic")[0].BoundingBox).toBe("3750 3225 3840 3285");
    expect(page.attrib4346).toBeUndefined();
  });

  it.each([false, true])("shifts all visible coordinates together and restores their original positions (binary=%s)", binary => {
    const source = wrap(`<group id="20"><fragment id="21"><n id="22" Element="7" p="-40 -120"/><n id="23" p="-20 -100"/><b id="24" B="22" E="23" Order="2"/></fragment>
      <t id="25" p="40 -70"><s>  label  </s></t></group>
      <curve id="26" CurvePoints="10 -30 30 -80 60 -80 90 -30" ArrowheadHead="Full"/>
      <arrow id="27" Tail3D="100 -100 0" Head3D="160 -100 0" ArrowheadHead="Full"/>
      ${sourceGraphic(28, 'OrbitalType="p" OvalType="Shaded" xyz="210 -50 41" Center3D="210 -50 17" MajorAxisEnd3D="240 -50 -23" MinorAxisEnd3D="210 -20 39"').replace('20 30 80 90', '180 -80 240 -20')}
      <graphic id="29" GraphicType="Bracket" BracketType="Square" BoundingBox="250 -120 260 0"/>`);
    const original = requireDocument(openChemDraftPayload(source));
    const xmlExport = exportDocumentToCdxml(original, { embedNativePayload: false }).contents;
    const xml = binary ? cdxElementToCdxml(readCdx(exportDocumentToCdx(original).bytes)) : xmlExport;
    expect(attributes(xml, "page")[0].attrib4346).toMatch(/^\|x\|/);
    const offsetTag = attributes(xml, "page")[0].attrib4346;
    const [dx, dy] = JSON.parse(Buffer.from(offsetTag.slice(3), "hex").toString("utf8"));
    expect(dx).toBeGreaterThan(40); expect(dy).toBeGreaterThan(120);
    const atom = attributes(xml, "n")[0].p.split(" ").map(Number);
    expect(atom[0] + 40).toBeCloseTo(dx, 4); expect(atom[1] + 120).toBeCloseTo(dy, 4);
    expect(attributes(xml, "arrow")[0].Tail3D.split(" ").slice(0, 2).map(Number)).toEqual([100 + dx, -100 + dy]);
    const orbital = attributes(xml, "graphic").find(graphic => graphic.GraphicType === "Orbital")!;
    expect(orbital.xyz.split(" ").map(Number)).toEqual([210 + dx, -50 + dy, 41]);
    expect(orbital.Center3D.split(" ").map(Number)).toEqual([210 + dx, -50 + dy, 17]);
    expect(orbital.MajorAxisEnd3D.split(" ").map(Number)).toEqual([240 + dx, -50 + dy, -23]);
    expect(orbital.MinorAxisEnd3D.split(" ").map(Number)).toEqual([210 + dx, -20 + dy, 39]);
    const reopened = requireDocument(binary ? importCdx(exportDocumentToCdx(original).bytes) : openChemDraftPayload(xml));
    expect(reopened.pages[0].objects.map(object => object.type)).toEqual(original.pages[0].objects.map(object => object.type));
    reopened.pages[0].objects.forEach((object, index) => {
      const before = original.pages[0].objects[index];
      expect(object.x).toBeCloseTo(before.x, 3); expect(object.y).toBeCloseTo(before.y, 3);
      if (object.type === "graphic" && before.type === "graphic") {
        expect(object.width).toBeCloseTo(before.width, 3); expect(object.height).toBeCloseTo(before.height, 3);
        expect(object.data).toEqual(before.data);
        if (before.graphicKind === "unknown") expect(object.compatibility?.unknown.cdxmlGraphicAttributes)
          .toEqual(before.compatibility?.unknown.cdxmlGraphicAttributes);
      }
      if (object.type === "molecule" && before.type === "molecule") {
        object.atoms.forEach((atom, index) => {
          expect(atom.x).toBeCloseTo(before.atoms[index].x, 3);
          expect(atom.y).toBeCloseTo(before.atoms[index].y, 3);
        });
        expect(chemistry(object)).toEqual(chemistry(before));
      }
      if (object.type === "graphic" && before.type === "graphic" && before.data.artPathKind === "bezier") expect(object.data.pathNodes).toEqual(before.data.pathNodes);
      if (object.type === "text" && before.type === "text") expect(object.text).toBe(before.text);
    });
    expect(openChemDraftPayload(exportDocumentToCdxml(original).contents).document).toEqual(original);
    expect(importCdx(exportDocumentToCdx(original, { embedNativePayload: true }).bytes).document).toEqual(original);
    // A second interchange cycle must not accumulate the offset.
    const again = requireDocument(binary ? importCdx(exportDocumentToCdx(reopened).bytes)
      : openChemDraftPayload(exportDocumentToCdxml(reopened, { embedNativePayload: false }).contents));
    again.pages[0].objects.forEach((object, index) => {
      expect(object.x).toBeCloseTo(reopened.pages[0].objects[index].x, 3);
      expect(object.y).toBeCloseTo(reopened.pages[0].objects[index].y, 3);
    });
  });

  it("keeps letter-sized in-page content stationary and omits the hash selector only for interchange", () => {
    const document = documentWithGraphic(nativeGraphic({}, "rect"));
    for (const embedded of [false, true]) {
      const xml = exportDocumentToCdxml(document, { embedNativePayload: embedded }).contents;
      const root = tree(xml), page = elements(root, "page")[0];
      expect(page.attrs.BoundingBox).toBe("0 0 612 792");
      expect(page.attrs.attrib4346).toBeUndefined();
      expect(page.attrs.WidthPages).toBeUndefined();
      expect(page.attrs.HeightPages).toBeUndefined();
      expect(root.attrs.PrintMargins).toBeUndefined();
      expect(attributes(xml, "graphic")[0].BoundingBox).toBe("30 30 120 90");
      expect(root.attrs.attrib4345).toBe(embedded ? "|x|32" : undefined);
      const binaryRoot = readCdx(exportDocumentToCdx(document, { embedNativePayload: embedded }).bytes);
      expect(binaryRoot.attrs.attrib4345).toBe(embedded ? "|x|32" : undefined);
      expect(binaryRoot.attrs.PrintMargins).toBeUndefined();
      expect(elements(binaryRoot, "page")[0].attrs).toMatchObject({ BoundingBox: "0 0 612 792" });
      expect(elements(binaryRoot, "page")[0].attrs.WidthPages).toBeUndefined();
    }
  });

  const halfInchMargins = { top: 48, left: 48, bottom: 48, right: 48 };
  const setLayout = (document: ChemDraftDocument, layout: PageLayout) => {
    Object.assign(document.pages[0], { layout, width: layout.widthPx, height: layout.heightPx, margin: pageMarginFromLayout(layout) });
  };
  const interchange = (document: ChemDraftDocument, binary: boolean) => binary
    ? readCdx(exportDocumentToCdx(document).bytes)
    : tree(exportDocumentToCdxml(document, { embedNativePayload: false }).contents);

  it.each([false, true])("fits wholly negative content using its shifted extents (binary=%s)", binary => {
    const document = documentWithGraphic({ ...nativeGraphic({}, "rect"),
      x: -600 / 0.75, y: -600 / 0.75, width: 100 / 0.75, height: 100 / 0.75 });
    const root = interchange(document, binary), page = elements(root, "page")[0];
    expect(page.attrs.BoundingBox).toBe("0 0 612 792");
    expect(page.attrs.WidthPages).toBeUndefined();
    expect(page.attrs.HeightPages).toBeUndefined();
    expect(root.attrs.PrintMargins).toBeUndefined();
    expect(JSON.parse(Buffer.from(page.attrs.attrib4346.slice(3), "hex").toString("utf8"))).toEqual([618, 618]);
    expect(elements(page, "graphic")[0].attrs.BoundingBox).toBe("18 18 118 118");
    const reopened = requireDocument(binary ? importCdx(writeCdx(root)) : openChemDraftPayload(cdxElementToCdxml(root)));
    expect(reopened.pages[0].objects[0].x).toBeCloseTo(-600 / 0.75, 3);
    expect(reopened.pages[0].objects[0].y).toBeCloseTo(-600 / 0.75, 3);
  });

  it.each([false, true])("writes shared margins when only a later plain source page grows (binary=%s)", binary => {
    const source = `<CDXML><page id="1" BoundingBox="0 0 612 792"/>
      <page id="2" BoundingBox="0 0 612 792"><graphic id="3" GraphicType="Rectangle" BoundingBox="20 30 80 90"/></page></CDXML>`;
    const document = requireDocument(binary ? importCdx(bytesFromCdxml(source)) : openChemDraftPayload(source));
    document.pages[1].objects[0].width = 900 / 0.75;
    const exported = binary ? exportDocumentToCdx(document) : exportDocumentToCdxml(document, { embedNativePayload: false });
    expect(exported.warnings.filter(warning => warning.code === "cdxml.page_margins_conflict")).toEqual([]);
    const root = interchange(document, binary);
    expect(root.attrs.PrintMargins).toBe("54 54 54 54");
    expect(elements(root, "page")[1].attrs).toMatchObject({ BoundingBox: "0 0 1008 684", WidthPages: "2", HeightPages: "1" });
    const reopened = requireDocument(binary ? importCdx(writeCdx(root)) : openChemDraftPayload(cdxElementToCdxml(root)));
    expect(reopened.pages.map(page => [page.width, page.height, page.margin])).toEqual(
      document.pages.map(page => [page.width, page.height, page.margin]));
  });

  it.each([false, true].flatMap(binary => ["36.0 36.0 36.0 36.0", "36.00001 36.00001 36.00001 36.00001"]
    .map(margins => ({ binary, margins }))))("compares preserved and regenerated margins numerically (binary=$binary, margins=$margins)", ({ binary, margins }) => {
    const source = `<CDXML PrintMargins="${margins}">
      <page id="1" BoundingBox="0 0 540 720" WidthPages="1" HeightPages="1"/>
      <page id="2" BoundingBox="0 0 540 720" WidthPages="1" HeightPages="1">
        <graphic id="3" GraphicType="Rectangle" BoundingBox="20 30 80 90"/></page></CDXML>`;
    const document = requireDocument(binary ? importCdx(bytesFromCdxml(source)) : openChemDraftPayload(source));
    document.pages[1].objects[0].width = 900 / 0.75;
    const exported = binary ? exportDocumentToCdx(document) : exportDocumentToCdxml(document, { embedNativePayload: false });
    expect(exported.warnings.filter(warning => warning.code === "cdxml.page_margins_conflict")).toEqual([]);
    const root = interchange(document, binary);
    expect(root.attrs.PrintMargins).toBe(binary ? readCdx(bytesFromCdxml(source)).attrs.PrintMargins : margins);
    expect(elements(root, "page")[1].attrs).toMatchObject({ BoundingBox: "0 0 1080 720", WidthPages: "2", HeightPages: "1" });
  });

  it.each([false, true])("does not add a page when content ends exactly at a printable boundary (binary=%s)", binary => {
    for (const preset of ["letter", "a4"] as const) {
      const layout = createPageLayout(preset, "portrait", halfInchMargins);
      const document = documentWithGraphic({ ...nativeGraphic({}, "rect"), x: 0, y: 0,
        width: layout.widthPx - 96, height: layout.heightPx - 96 });
      setLayout(document, layout);
      const root = interchange(document, binary);
      expect(root.attrs.PrintMargins).toBe("36 36 36 36");
      expect(elements(root, "page")[0].attrs).toMatchObject({ WidthPages: "1", HeightPages: "1" });
      const box = elements(root, "page")[0].attrs.BoundingBox.split(" ").map(Number);
      expect(box[2]).toBeCloseTo((layout.widthPx - 96) * 0.75, 3);
      expect(box[3]).toBeCloseTo((layout.heightPx - 96) * 0.75, 3);
      document.pages[0].objects[0].width += 0.01 / 0.75;
      expect(elements(interchange(document, binary), "page")[0].attrs.WidthPages).toBe("2");
    }
  });

  it.each([false, true])("fits different native-page margins to the shared root print setup and warns (binary=%s)", binary => {
    const document = documentWithGraphic(nativeGraphic({}, "rect"));
    document.pages.push({ ...structuredClone(document.pages[0]), id: "page_002", objects: [
      { ...nativeGraphic({}, "rect"), id: "graphic_002", x: 0, y: 0, width: 520 / 0.75 }
    ] });
    document.pages[1].margin = halfInchMargins;
    document.pages[1].layout = createPageLayout("letter", "portrait", halfInchMargins);
    const exported = binary ? exportDocumentToCdx(document) : exportDocumentToCdxml(document, { embedNativePayload: false });
    expect(exported.warnings).toContainEqual(expect.objectContaining({ code: "cdxml.page_margins_conflict", sourceObjectId: "page_002" }));
    const root = interchange(document, binary);
    expect(root.attrs.PrintMargins).toBe("54 54 54 54");
    expect(elements(root, "page")[1].attrs).toMatchObject({ BoundingBox: "0 0 1008 684", WidthPages: "2", HeightPages: "1" });
    const reopened = requireDocument(binary ? importCdx(writeCdx(root)) : openChemDraftPayload(cdxElementToCdxml(root)));
    expect(reopened.pages[1]).toMatchObject({ width: 816, height: 1056, margin: document.pages[0].margin });
  });

  it.each([false, true])("regenerates a preserved grid whose page margins differ from the shared root (binary=%s)", binary => {
    const source = `<CDXML PrintMargins="36 36 36 36">
      <page id="1" BoundingBox="0 0 540 720" WidthPages="1" HeightPages="1"/>
      <page id="2" PrintMargins="54 54 54 54" BoundingBox="0 0 504 684" WidthPages="1" HeightPages="1">
        <graphic id="3" GraphicType="Rectangle" BoundingBox="20 30 80 90"/></page></CDXML>`;
    const document = requireDocument(binary ? importCdx(bytesFromCdxml(source)) : openChemDraftPayload(source));
    const exported = binary ? exportDocumentToCdx(document) : exportDocumentToCdxml(document, { embedNativePayload: false });
    expect(exported.warnings).toContainEqual(expect.objectContaining({ code: "cdxml.page_margins_conflict", sourceObjectId: document.pages[1].id }));
    const root = interchange(document, binary), page = elements(root, "page")[1];
    expect(root.attrs.PrintMargins).toBe("36 36 36 36");
    expect(page.attrs.PrintMargins).toBeUndefined();
    expect(page.attrs).toMatchObject({ BoundingBox: "0 0 540 720", WidthPages: "1", HeightPages: "1" });
  });

  it.each([false, true])("replaces a source root margin value that differs from the first page's effective margins (binary=%s)", binary => {
    const source = `<CDXML PrintMargins="36 36 36 36"><page id="1" PrintMargins="54 54 54 54"
      BoundingBox="0 0 504 684" WidthPages="1" HeightPages="1">
      <graphic id="2" GraphicType="Rectangle" BoundingBox="20 30 80 90"/></page></CDXML>`;
    const document = requireDocument(binary ? importCdx(bytesFromCdxml(source)) : openChemDraftPayload(source));
    const root = interchange(document, binary);
    expect(root.attrs.PrintMargins).toBe("54 54 54 54");
    expect(elements(root, "page")[0].attrs.PrintMargins).toBeUndefined();
    expect(elements(root, "page")[0].attrs).toMatchObject({ BoundingBox: "0 0 504 684", WidthPages: "1", HeightPages: "1" });
    const reopened = requireDocument(binary ? importCdx(writeCdx(root)) : openChemDraftPayload(cdxElementToCdxml(root)));
    expect(reopened.pages[0]).toMatchObject({ width: 816, height: 1056, margin: document.pages[0].margin });
  });

  it.each([false, true])("exports each native page with explicit grid counts in a multi-page document (binary=%s)", binary => {
    const document = documentWithGraphic(nativeGraphic({}, "rect"));
    document.pages.push({ ...structuredClone(document.pages[0]), id: "page_002", objects: [] });
    const root = interchange(document, binary);
    expect(root.attrs.PrintMargins).toBe("54 54 54 54");
    expect(elements(root, "page")).toHaveLength(2);
    for (const page of elements(root, "page")) {
      expect(page.attrs).toMatchObject({ BoundingBox: "0 0 504 684", WidthPages: "1", HeightPages: "1" });
    }
    const reopened = requireDocument(binary ? importCdx(writeCdx(root)) : openChemDraftPayload(cdxElementToCdxml(root)));
    expect(reopened.pages).toHaveLength(2);
    expect(reopened.pages.map(page => [page.width, page.height])).toEqual([[816, 1056], [816, 1056]]);
  });

  it.each([false, true])("imports unambiguous uncounted paper and printable sizes with margins (binary=%s)", binary => {
    for (const box of ["0 0 595.28 841.89", "0 0 523.28 769.89", "0 0 841.89 595.28", "0 0 769.89 523.28"]) {
      const source = `<CDXML PrintMargins="36 36 36 36"><page id="1" BoundingBox="${box}">
        <graphic id="2" GraphicType="Rectangle" BoundingBox="20 30 80 90"/></page></CDXML>`;
      const document = requireDocument(binary ? importCdx(bytesFromCdxml(source)) : openChemDraftPayload(source));
      expect(document.pages[0].layout.presetId).toBe("a4");
      expect(document.pages[0].layout.sourceUnit).toBe("mm");
      expect(Math.min(document.pages[0].width, document.pages[0].height) * 0.75).toBeCloseTo(595.28, 3);
      expect(Math.max(document.pages[0].width, document.pages[0].height) * 0.75).toBeCloseTo(841.89, 3);
      expect(document.pages[0].margin).toEqual(halfInchMargins);
      const original = binary ? readCdx(bytesFromCdxml(source)) : tree(source);
      expect(elements(interchange(document, binary), "page")[0].attrs.BoundingBox).toBe(elements(original, "page")[0].attrs.BoundingBox);
    }
  });

  it.each([false, true])("derives portrait, landscape and A4 grids from the actual paper and asymmetric margins (binary=%s)", binary => {
    const cases = [
      { layout: createPageLayout("letter", "portrait", halfInchMargins), printable: [540, 720], extent: [900, 1200], counts: [2, 2] },
      { layout: createPageLayout("letter", "landscape", halfInchMargins), printable: [720, 540], extent: [1300, 900], counts: [2, 2] },
      { layout: createCustomPageLayout(595.28 / 0.75, 841.89 / 0.75, "css-px", halfInchMargins), printable: [523.28, 769.89], extent: [900, 1200], counts: [2, 2] },
      { layout: createPageLayout("a4", "portrait", { top: 24, left: 32, bottom: 40, right: 48 }),
        printable: [210 / 25.4 * 72 - 60, 297 / 25.4 * 72 - 48], extent: [900, 400], counts: [2, 1] }
    ];
    for (const { layout, printable, extent, counts } of cases) {
      const document = documentWithGraphic({ ...nativeGraphic({}, "rect"),
        x: -40, y: -80, width: extent[0] / 0.75, height: extent[1] / 0.75 });
      setLayout(document, layout);
      const root = interchange(document, binary), page = elements(root, "page")[0];
      expect(root.attrs.PrintMargins).toBe([layout.marginTopPx, layout.marginLeftPx, layout.marginBottomPx, layout.marginRightPx].map(value => value * 0.75).join(" "));
      expect(page.attrs).toMatchObject({ WidthPages: String(counts[0]), HeightPages: String(counts[1]) });
      const [left, top, width, height] = page.attrs.BoundingBox.split(/\s+/).map(Number);
      expect([left, top]).toEqual([0, 0]);
      expect(width).toBeCloseTo(printable[0] * counts[0], 3);
      expect(height).toBeCloseTo(printable[1] * counts[1], 3);
      expect(page.attrs.attrib4346).toMatch(/^\|x\|/);
      const reopened = requireDocument(binary ? importCdx(writeCdx(root)) : openChemDraftPayload(cdxElementToCdxml(root)));
      expect(reopened.pages[0].width).toBeCloseTo(layout.widthPx, 3);
      expect(reopened.pages[0].height).toBeCloseTo(layout.heightPx, 3);
      expect(reopened.pages[0].margin).toEqual(document.pages[0].margin);
      expect(reopened.pages[0].layout.orientation).toBe(layout.orientation);
      expect(reopened.pages[0].objects[0].x).toBeCloseTo(-40, 3);
      expect(reopened.pages[0].objects[0].y).toBeCloseTo(-80, 3);
      const repeated = interchange(reopened, binary);
      expect(repeated.attrs.PrintMargins).toBe(root.attrs.PrintMargins);
      expect(elements(repeated, "page")[0].attrs).toEqual(page.attrs);
    }
  });

  it.each([false, true])("preserves all source page attributes and root margins verbatim while a 2 by 2 drawing fits (binary=%s)", binary => {
    const source = `<CDXML PrintMargins="36.000 36.00 36.0 36">
      <page id="1" BoundingBox="0.000 0.00 1080.0000 1440.00" WidthPages="2" HeightPages="2"
        HeaderPosition="24.000" FooterPosition="28.00" Header="source header" Footer="source footer"
        PrintTrimMarks="yes" PageOverlap="0" DrawingSpace="poster" attrib4a12="|x|010203"
        ${binary ? "" : 'Orientation="portrait" ExtraPageSetting="opaque &amp; exact"'}>
        <graphic id="2" GraphicType="Rectangle" BoundingBox="20 30 1000 1300"/>
      </page></CDXML>`;
    const original = binary ? readCdx(bytesFromCdxml(source)) : tree(source);
    const pageAttributes = elements(original, "page")[0].attrs;
    const document = requireDocument(binary ? importCdx(writeCdx(original)) : openChemDraftPayload(source));
    const page = document.pages[0];
    expect(page.width).toBe(816); expect(page.height).toBe(1056);
    expect(page.margin).toEqual(halfInchMargins);
    expect(page.layout).toMatchObject({ presetId: "letter", orientation: "portrait", sourceUnit: "inch" });
    expect(page.compatibility?.unknown.cdxmlPageAttributes).toEqual(pageAttributes);
    expect(page.compatibility?.unknown.cdxmlRootPageAttributes).toEqual({ PrintMargins: original.attrs.PrintMargins });
    const exported = interchange(document, binary);
    expect(exported.attrs.PrintMargins).toBe(original.attrs.PrintMargins);
    expect(elements(exported, "page")[0].attrs).toEqual({ ...pageAttributes, id: elements(exported, "page")[0].attrs.id });
    const reimported = requireDocument(binary ? importCdx(writeCdx(exported)) : openChemDraftPayload(cdxElementToCdxml(exported)));
    expect(reimported.pages[0].objects[0].x).toBeCloseTo(page.objects[0].x, 4);
    expect(reimported.pages[0].objects[0].y).toBeCloseTo(page.objects[0].y, 4);
    expect(openChemDraftPayload(exportDocumentToCdxml(document).contents).document).toEqual(document);
    expect(importCdx(exportDocumentToCdx(document, { embedNativePayload: true }).bytes).document).toEqual(document);

    page.objects[0].width = 1500 / 0.75;
    page.objects[0].height = 1900 / 0.75;
    const grown = interchange(document, binary), grownPage = elements(grown, "page")[0].attrs;
    expect(grown.attrs.PrintMargins).toBe("36 36 36 36");
    expect(grownPage).toMatchObject({ BoundingBox: "0 0 1620 2160", WidthPages: "3", HeightPages: "3", HeaderPosition: pageAttributes.HeaderPosition,
      FooterPosition: pageAttributes.FooterPosition, PrintTrimMarks: "yes", attrib4a12: "|x|010203" });
  });

  it.each([false, true])("uses a changed native paper setup instead of stale source counts and margins (binary=%s)", binary => {
    const document = requireDocument(openChemDraftPayload(`<CDXML PrintMargins="36 36 36 36"><page id="1"
      BoundingBox="0 0 1080 1440" WidthPages="2" HeightPages="2" Width="612" Height="792" Orientation="portrait">
      <graphic id="2" GraphicType="Rectangle" BoundingBox="20 30 80 90"/></page></CDXML>`));
    setLayout(document, createPageLayout("letter", "landscape", halfInchMargins));
    const exported = interchange(document, binary), page = elements(exported, "page")[0].attrs;
    expect(page).toMatchObject({ BoundingBox: "0 0 720 540", WidthPages: "1", HeightPages: "1" });
    expect(page.Width).toBeUndefined(); expect(page.Height).toBeUndefined(); expect(page.Orientation).toBeUndefined();
    const reopened = requireDocument(binary ? importCdx(writeCdx(exported)) : openChemDraftPayload(cdxElementToCdxml(exported)));
    expect(reopened.pages[0].layout).toMatchObject({ presetId: "letter", orientation: "landscape" });
    expect(reopened.pages[0].width).toBe(1056); expect(reopened.pages[0].height).toBe(816);
  });
});
type Node = [number, number, number, string?];
type Edge = [number, number, string?, string?];
const fragment = (nodes: Node[], bonds: Edge[]) => `<fragment id="2">${nodes.map(([element, x, y, attrs = ""], k) => `<n id="${k + 10}" Element="${element}" p="${x} ${y}" ${attrs}/>`).join("")}${bonds.map(([a, b, order = "1", display], k) => `<b id="${k + 100}" B="${a + 10}" E="${b + 10}" Order="${order}"${display ? ` Display="${display}"` : ""}/>`).join("")}</fragment>`;
const ring: Node[] = Array.from({ length: 6 }, (_, k) => [6, 100 + 20 * Math.cos(k * Math.PI / 3), 100 + 20 * Math.sin(k * Math.PI / 3)]);
const ringBonds: Edge[] = Array.from({ length: 6 }, (_, k) => [k, (k + 1) % 6, k % 2 ? "1" : "2"]);
const examples: [string, string, string | undefined][] = [
  ["benzene", wrap(fragment(ring, ringBonds)), "C6H6"],
  ["aspirin", wrap(fragment([...ring, [6, 140, 100], [8, 150, 80], [8, 150, 120], [8, 120, 140], [6, 140, 150], [8, 150, 135], [6, 150, 170]], [...ringBonds, [0, 6], [6, 7, "2"], [6, 8], [1, 9], [9, 10], [10, 11, "2"], [10, 12]])), "C9H8O4"],
  ["lactic acid with wedge", wrap(fragment([[6, 40, 100], [6, 60, 100], [6, 80, 100], [8, 60, 80], [8, 90, 80], [8, 90, 120]], [[0, 1], [1, 2], [1, 3, "1", "WedgeBegin"], [2, 4, "2"], [2, 5]])), "C3H6O3"],
  ["E alkene", wrap(fragment([[6, 40, 80], [6, 60, 100], [6, 80, 100], [6, 100, 120]], [[0, 1], [1, 2, "2"], [2, 3]])), "C4H8"],
  ["Z alkene", wrap(fragment([[6, 40, 80], [6, 60, 100], [6, 80, 100], [6, 100, 80]], [[0, 1], [1, 2, "2"], [2, 3]])), "C4H8"],
  ["quaternary ammonium", wrap(fragment([[7, 60, 100, 'Charge="1"'], [6, 40, 100], [6, 80, 100], [6, 60, 80], [6, 60, 120]], [[0, 1], [0, 2], [0, 3], [0, 4]])), "C4H12N"],
  ["nitrobenzene", wrap(fragment([...ring, [7, 140, 100, 'Charge="1"'], [8, 155, 80], [8, 155, 120, 'Charge="-1"']], [...ringBonds, [0, 6], [6, 7, "2"], [6, 8]])), "C6H5NO2"],
  ["salt pair", wrap(fragment([[11, 40, 100, 'Charge="1"'], [17, 80, 100, 'Charge="-1"']], [])), "ClNa"],
  ["isotope", wrap(fragment([[6, 40, 100, 'Isotope="13"'], [8, 60, 100]], [[0, 1]])), undefined],
  ["radical", wrap(fragment([[6, 40, 100, 'Radical="Doublet"']], [])), undefined],
  ["text", wrap('<t id="4" p="20 30"><s font="3" size="12" face="1">α → β &amp; H₂O</s></t>'), undefined],
  ["reaction arrow with conditions", wrap('<graphic id="3" GraphicType="Line" ArrowType="FullHead" BoundingBox="40 100 120 100"/><t id="4" p="65 80"><s>NaOH, 25 °C</s></t>'), undefined],
  ["equilibrium arrow", wrap('<graphic id="3" GraphicType="Line" ArrowType="Equilibrium" BoundingBox="40 100 120 100"/>'), undefined],
  ["retrosynthesis arrow", wrap('<graphic id="3" GraphicType="Line" ArrowType="RetroSynthetic" BoundingBox="40 100 120 100"/>'), undefined]
];

function requireDocument(result: ReturnType<typeof openChemDraftPayload>): ChemDraftDocument {
  expect(result.document, JSON.stringify(result.warnings)).toBeDefined();
  return result.document!;
}

function chemistry(molecule: MoleculeObject) {
  const index = new Map(molecule.atoms.map((atom, k) => [atom.id, k]));
  const metadata = nativeSingleBondGraphMetadata(molecule.atoms, molecule.bonds);
  return {
    formula: metadata.formula, charge: molecule.atoms.reduce((sum, atom) => sum + atom.formalCharge, 0),
    smiles: nativeSingleBondGraphSmiles(molecule.atoms, molecule.bonds),
    atoms: molecule.atoms.map((a) => [a.element, a.formalCharge, a.isotope, a.markRadicals]),
    bonds: molecule.bonds.map((b) => [index.get(b.fromAtomId), index.get(b.toAtomId), b.order, b.stereo, b.display?.bondStyle])
  };
}

function compareDocuments(actual: ChemDraftDocument, expected: ChemDraftDocument) {
  expect(actual.pages).toHaveLength(expected.pages.length);
  for (let p = 0; p < actual.pages.length; p++) {
    const left = actual.pages[p].objects, right = expected.pages[p].objects;
    expect(left.map((x) => x.type)).toEqual(right.map((x) => x.type));
    expect(left.filter((x) => x.type === "text")).toHaveLength(right.filter((x) => x.type === "text").length);
    expect(left.filter((x) => x.type === "reaction-arrow" || x.type === "graphic")).toHaveLength(right.filter((x) => x.type === "reaction-arrow" || x.type === "graphic").length);
    left.forEach((object, k) => {
      const original = right[k];
      if (object.type === "molecule" && original.type === "molecule") {
        expect(chemistry(object)).toEqual(chemistry(original));
        expect(object.atoms).toHaveLength(original.atoms.length);
        expect(object.bonds).toHaveLength(original.bonds.length);
        object.atoms.forEach((atom, j) => {
          expect(atom.x).toBeCloseTo(original.atoms[j].x, 3);
          expect(atom.y).toBeCloseTo(original.atoms[j].y, 3);
        });
      } else if (object.type === "text" && original.type === "text") expect(object.text).toBe(original.text);
      else if (object.type === "graphic" && original.type === "graphic") {
        expect(object.graphicKind).toBe(original.graphicKind);
        expect(object.data.artToolId).toBe(original.data.artToolId);
      }
      expect(object.x).toBeCloseTo(original.x, 2);
      expect(object.y).toBeCloseTo(original.y, 2);
    });
  }
}

describe("chemical and drawing round trips", () => {
  it("imports an independently constructed horizontal arrow with x/y/z coordinates", () => {
    const bytes = new Uint8Array(Buffer.from([
      "566A4344303130300403020100000000000000000000", // Header.
      "008000000000", "018001000000", "218003000000", // Document, page, arrow.
      "07020C00000078000000640000000000", // Head: x=120, y=100, z=0.
      "08020C00000028000000640000000000", // Tail: x=40, y=100, z=0.
      "000000000000"
    ].join(""), "hex"));
    const document = requireDocument(importCdx(bytes));
    expect(document.pages[0].objects).toHaveLength(1);
    // CDX points are 1/72 inch; native document coordinates are 1/96 inch.
    expect(document.pages[0].objects[0]).toMatchObject({
      type: "graphic", data: { lineStart: { x: 40 * 4 / 3, y: 100 * 4 / 3 }, lineEnd: { x: 120 * 4 / 3, y: 100 * 4 / 3 } }
    });
  });
  for (const [name, cdxml, formula] of examples) {
    it(`preserves ${name}: CDXML → CDX → native → CDX → CDXML`, () => {
      const original = requireDocument(openChemDraftPayload(cdxml));
      if (formula) {
        const molecules = original.pages[0].objects.filter((x): x is MoleculeObject => x.type === "molecule");
        expect(molecules.map((m) => chemistry(m).formula).join(".")).toBe(formula);
      }
      const initial = requireDocument(importCdx(bytesFromCdxml(cdxml)));
      compareDocuments(initial, original);
      const exported = exportDocumentToCdx(initial, { embedNativePayload: false });
      expect(readCdx(exported.bytes).attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE]).toBeUndefined();
      const reopened = requireDocument(importCdx(exported.bytes));
      compareDocuments(reopened, initial);
      const viaCdxml = requireDocument(openChemDraftPayload(cdxElementToCdxml(readCdx(exported.bytes))));
      compareDocuments(viaCdxml, initial);
    });
  }

  for (const name of ["single-bond.cdxml", "heteroatom-double.cdxml", "triple-bond.cdxml", "wedge-hash-dash-bold.cdxml", "text-plus-molecule.cdxml", "arrow-heads.cdxml"]) {
    it(`preserves the existing ${name} fixture through CDX`, () => {
      const original = requireDocument(openChemDraftPayload(cdxmlFixtures[name]));
      compareDocuments(requireDocument(importCdx(exportDocumentToCdx(original).bytes)), original);
    });
  }

  it.each(["CDX", "CDXML"] as const)("preserves bond crossings and names the omitted bracket group in %s export", format => {
    const original = requireDocument(openChemDraftPayload(cdxmlFixtures["crossing-bonds.cdxml"]));
    const unknown = original.pages[0].objects.filter(object => object.type === "unknown-compatibility-object");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatchObject({
      sourceObjectType: "bracketedgroup",
      raw: {
        name: "bracketedgroup", attributes: { id: "bg_crossing", BracketedObjectIDs: "a1 a2" }
      }
    });
    const exported = format === "CDX"
      ? exportDocumentToCdx(original, { embedNativePayload: false })
      : exportDocumentToCdxml(original, { embedNativePayload: false });
    // A single attachment cannot form a native bracket pair. Its group is still omitted;
    // the specific diagnostic replaces the former generic object_export_unsupported warning.
    expect(exported.warnings).toContainEqual(expect.objectContaining({
      code: "cdxml.bracket_group_preserved", sourceObjectId: "bg_crossing",
      message: expect.stringMatching(/Bracket group bg_crossing:.*bracket members and crossing bonds are NOT written to visible export/)
    }));
    const supported = structuredClone(original);
    supported.pages[0].objects = supported.pages[0].objects.filter(object => object.id !== unknown[0].id);
    const reopened = requireDocument("bytes" in exported
      ? importCdx(exported.bytes)
      : openChemDraftPayload(exported.contents));
    compareDocuments(reopened, supported);
    expect(reopened.pages[0].crossings).toHaveLength(original.pages[0].crossings.length);
  });

  it("retains isotope, radical and wedge data rather than passing through an empty graph", () => {
    const isotope = requireDocument(importCdx(bytesFromCdxml(examples.find(([n]) => n === "isotope")![1]))).pages[0].objects[0] as MoleculeObject;
    expect(isotope.atoms[0].isotope).toBe(13);
    const radical = requireDocument(importCdx(bytesFromCdxml(examples.find(([n]) => n === "radical")![1]))).pages[0].objects[0] as MoleculeObject;
    expect(radical.atoms[0].markRadicals).toBe(1);
    const stereo = requireDocument(importCdx(bytesFromCdxml(examples.find(([n]) => n === "lactic acid with wedge")![1]))).pages[0].objects[0] as MoleculeObject;
    expect(stereo.bonds.some((b) => b.display?.bondStyle?.includes("wedge"))).toBe(true);
  });

  it("preserves a triplet and refuses an unrepresentable singlet instead of changing its electron state", () => {
    const source = wrap(fragment([[6, 40, 100, 'Radical="Triplet"']], []));
    const triplet = requireDocument(importCdx(bytesFromCdxml(source)));
    expect((triplet.pages[0].objects[0] as MoleculeObject).atoms[0].markRadicals).toBe(2);
    compareDocuments(requireDocument(importCdx(exportDocumentToCdx(triplet).bytes)), triplet);
    const refused = importCdx(bytesFromCdxml(source.replace("Triplet", "Singlet")));
    expect(refused.document).toBeUndefined();
    expect(refused.warnings.some((w) => w.code === "cdxml.atom_radical_unsupported")).toBe(true);
  });
});

describe("native payload Save As and interchange Export", () => {
  const findText = (element: CdxElement): CdxElement | undefined => element.name === "s" ? element : element.kids.map(findText).find(Boolean);

  it.each(["ChemDraft", "Custom producer"])("opens old swapped Point3D saves from %s with both integrity checks intact", creationProgram => {
    const source = wrap('<arrow id="2" Head3D="120 100 0" Tail3D="40 100 0"/><graphic id="3" GraphicType="Orbital" Center3D="240 50 17" MajorAxisEnd3D="280 50 -23" MinorAxisEnd3D="240 80 39"/>')
      .replace('CreationProgram="ChemDraft"', `CreationProgram="${creationProgram}"`);
    const original = requireDocument(openChemDraftPayload(source));
    const current = readCdx(exportDocumentToCdx(original, { embedNativePayload: true, creationProgram }).bytes);
    const envelope = JSON.parse(Buffer.from(current.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE].slice(3), "hex").toString("utf8"));
    delete envelope.visibleHashVersion;
    envelope.tags.find(([name]: [string, string]) => name === ChemDraftObjectTags.visibleCdxmlHash)[1] = legacyVisibleCdxmlHash(source);
    // Build released-writer bytes independently, including z/y/x points and y/x rectangles.
    const u16 = (n: number) => [n & 255, n >>> 8 & 255];
    const u32 = (n: number) => [...u16(n), ...u16(n >>> 16)];
    const property = (tag: number, data: number[]) => [...u16(tag), ...u16(data.length), ...data];
    const object = (tag: number, id: number, ...children: number[][]) => [...u16(tag), ...u32(id), ...children.flat(), 0, 0];
    const point = (tag: number, x: number, y: number, z: number) => property(tag, [z, y, x].flatMap(n => u32(n * 65536)));
    const header = [...Buffer.from("VjCD0100"), 4, 3, 2, 1, ...Array(10).fill(0)];
    const body = [property(0x0003, [0, 0, ...Buffer.from(creationProgram)]),
      object(0x8001, 1, property(0x0204, [0, 0, 792, 612].flatMap(n => u32(n * 65536))),
        object(0x8021, 2, point(0x0207, 120, 100, 0), point(0x0208, 40, 100, 0)),
        object(0x8007, 3, property(0x0a00, u16(5)), point(0x020d, 240, 50, 17),
          point(0x020e, 280, 50, -23), point(0x020f, 240, 80, 39)))];
    envelope.visibleBinaryHash = sha256Hex(new Uint8Array([...header, ...object(0x8000, 0, ...body)]));
    const bytes = new Uint8Array([...header, ...object(0x8000, 0, ...body,
      property(0x4344, [...Buffer.from(JSON.stringify(envelope))]))]);
    const opened = importCdx(bytes);
    expect(opened.source).toBe("native-payload");
    expect(opened.conflict).toBeUndefined();
    expect(opened.warnings).toEqual([]);
    expect(opened.document).toEqual(original);
    const visible = structuredClone(readCdx(bytes));
    delete visible.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE];
    expect(legacyVisibleCdxmlHash(cdxElementToCdxml(visible))).toBe(legacyVisibleCdxmlHash(source));
    compareDocuments(requireDocument(openChemDraftPayload(cdxElementToCdxml(visible))), original);
    const resaved = exportDocumentToCdx(requireDocument(opened), { embedNativePayload: true });
    expect(readCdx(resaved.bytes).attrs[CDX_POINT3D_ORDER_ATTRIBUTE]).toBe("|x|78797A");
    expect(importCdx(resaved.bytes).document).toEqual(original);
  });

  it("omits the v2 marker only for interchange and rejects embedded visible edits even after marker removal in CDXML and CDX", () => {
    const original = requireDocument(openChemDraftPayload(wrap('<t id="4" p="20 30"><s>A&amp;#10;B</s></t>')));
    for (const binary of [false, true]) {
      const interchange = binary ? exportDocumentToCdx(original, { embedNativePayload: false })
        : exportDocumentToCdxml(original, { embedNativePayload: false });
      const interchangeRoot = "bytes" in interchange ? readCdx(interchange.bytes) : tree(interchange.contents);
      expect(interchangeRoot.attrs.attrib4345).toBeUndefined();
      const visible = "bytes" in interchange ? importCdx(interchange.bytes) : openChemDraftPayload(interchange.contents);
      expect(visible.document?.pages[0].objects[0]).toMatchObject({ text: "A&#10;B" });
      expect(visible.conflict).toBeUndefined();

      const saved = binary ? exportDocumentToCdx(original, { embedNativePayload: true })
        : exportDocumentToCdxml(original, { embedNativePayload: true });
      const root = "bytes" in saved ? readCdx(saved.bytes) : tree(saved.contents);
      expect(root.attrs.attrib4345).toBe("|x|32");
      const unchanged = "bytes" in saved ? importCdx(saved.bytes) : openChemDraftPayload(saved.contents);
      expect(unchanged.document).toEqual(original);
      expect(unchanged.conflict).toBeUndefined();

      for (const removeMarker of [false, true]) for (const editText of [false, true]) {
        if (!removeMarker && !editText) continue;
        let opened;
        if ("bytes" in saved) {
          const altered = structuredClone(root);
          if (removeMarker) delete altered.attrs.attrib4345;
          if (editText) findText(altered)!.text = "A\nB";
          // Recompute only binary integrity, so the independent v2 visible hash must still protect the payload.
          const envelope = JSON.parse(Buffer.from(altered.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE].slice(3), "hex").toString("utf8"));
          delete altered.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE];
          envelope.visibleBinaryHash = sha256Hex(writeCdx(altered));
          altered.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE] = `|x|${Buffer.from(JSON.stringify(envelope)).toString("hex")}`;
          opened = importCdx(writeCdx(altered));
        } else {
          let altered = saved.contents;
          if (removeMarker) altered = altered.replace(' attrib4345="|x|32"', "");
          if (editText) altered = altered.replace("A&amp;#10;B", "A&#10;B");
          opened = openChemDraftPayload(altered);
        }
        expect(opened.document).toBeUndefined();
        expect(opened.conflict?.kind).toBe("visible-layer-modified");
        expect(opened.conflict?.embeddedDocument).toEqual(original);
        if (editText) expect(opened.conflict?.visibleDocument?.pages[0].objects[0]).toMatchObject({ text: "A\nB" });
      }
    }
  });

  const textEnvelope = (text: string, legacy = false) => {
    const original = requireDocument(openChemDraftPayload(wrap('<t id="4" p="20 30"><s>old</s></t>')));
    const object = original.pages[0].objects[0];
    if (object.type !== "text") throw new Error("Expected text fixture");
    object.text = text;
    const visible = readCdx(exportDocumentToCdx(original, { embedNativePayload: true }).bytes);
    const envelope = JSON.parse(Buffer.from(visible.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE].slice(3), "hex").toString("utf8"));
    delete visible.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE];
    if (legacy) {
      delete visible.attrs.attrib4345;
      delete envelope.visibleHashVersion;
      envelope.tags.find(([name]: [string, string]) => name === ChemDraftObjectTags.visibleCdxmlHash)[1] = legacyVisibleCdxmlHash(cdxElementToCdxml(visible));
      envelope.visibleBinaryHash = sha256Hex(writeCdx(visible));
    }
    return { original, visible, envelope };
  };

  it.each([
    ["known, accepted limitation: a legacy CDX numeric-reference substitution opens without conflict after recomputing the binary hash", "legacy"],
    ["conflicts on a cross-semantics text substitution in a v2 CDX even with a recomputed binary hash", "current"]
  ] as const)("%s", (_name, version) => {
    const { original, visible, envelope } = textEnvelope(version === "legacy" ? "A\nB" : "A&#10;B", version === "legacy");
    const unchanged = structuredClone(visible);
    unchanged.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE] = `|x|${Buffer.from(JSON.stringify(envelope)).toString("hex")}`;
    expect(importCdx(writeCdx(unchanged)).document).toEqual(original);
    expect(importCdx(writeCdx(unchanged)).conflict).toBeUndefined();
    findText(visible)!.text = version === "legacy" ? "A&#10;B" : "A\nB";
    const alternateHash = version === "legacy" ? visibleHashForCdxml : legacyVisibleCdxmlHash;
    expect(alternateHash(cdxElementToCdxml(visible))).toBe(envelope.tags.find(([name]: [string, string]) => name === ChemDraftObjectTags.visibleCdxmlHash)[1]);
    if (version === "legacy") {
      expect(legacyVisibleCdxmlHash(cdxElementToCdxml(visible))).toBe(envelope.tags.find(([name]: [string, string]) => name === ChemDraftObjectTags.visibleCdxmlHash)[1]);
    }
    envelope.visibleBinaryHash = sha256Hex(writeCdx(visible));
    visible.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE] = `|x|${Buffer.from(JSON.stringify(envelope)).toString("hex")}`;
    const opened = importCdx(writeCdx(visible));
    if (version === "legacy") {
      expect(opened.source).toBe("native-payload");
      expect(opened.document).toEqual(original);
      expect(opened.conflict).toBeUndefined();
      expect(opened.warnings).toEqual([]);
      return;
    }
    expect(opened.document).toBeUndefined();
    expect(opened.conflict?.embeddedDocument).toEqual(original);
    expect(opened.conflict?.visibleDocument?.pages[0].objects[0]).toMatchObject({ text: "A\nB" });
    expect(opened.warnings.some(({ code }) => code === "cdx.native_payload_modified")).toBe(false);
    expect(opened.warnings.some(({ code }) => code === "cdxml.visible_layer_modified")).toBe(true);
  });

  it("silently restores unchanged legacy CDX with a line break and upgrades to v2 on save", () => {
    const { original, visible, envelope } = textEnvelope("A\nB", true);
    expect(visible.attrs.attrib4345).toBeUndefined();
    expect(envelope.visibleHashVersion).toBeUndefined();
    visible.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE] = `|x|${Buffer.from(JSON.stringify(envelope)).toString("hex")}`;
    const opened = importCdx(writeCdx(visible));
    expect(opened.source).toBe("native-payload");
    expect(opened.document).toEqual(original);
    expect(opened.conflict).toBeUndefined();
    expect(opened.warnings).toEqual([]);

    const resaved = exportDocumentToCdx(requireDocument(opened), { embedNativePayload: true });
    const upgraded = readCdx(resaved.bytes);
    expect(upgraded.attrs.attrib4345).toBe("|x|32");
    const upgradedEnvelope = JSON.parse(Buffer.from(upgraded.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE].slice(3), "hex").toString("utf8"));
    expect(upgradedEnvelope.visibleHashVersion).toBe("2");
    delete upgraded.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE];
    expect(upgradedEnvelope.tags.find(([name]: [string, string]) => name === ChemDraftObjectTags.visibleCdxmlHash)[1]).toBe(visibleHashForCdxml(cdxElementToCdxml(upgraded)));
    const reopened = importCdx(resaved.bytes);
    expect(reopened.document).toEqual(original);
    expect(reopened.conflict).toBeUndefined();
    expect(reopened.warnings).toEqual([]);
  });

  it.each(["envelope", "property", "both"])("rejects stripping or altering the %s version even after recomputing the binary hash", (target) => {
    for (const version of [undefined, "1", "3", ""]) {
      for (const editText of [false, true]) {
        const { original, visible, envelope } = textEnvelope("A&#10;B");
        expect(envelope.visibleHashVersion).toBe("2");
        expect(visible.attrs.attrib4345).toBe("|x|32");
        if (target !== "property") {
          if (version === undefined) delete envelope.visibleHashVersion;
          else envelope.visibleHashVersion = version;
        }
        if (target !== "envelope") {
          if (version === undefined) delete visible.attrs.attrib4345;
          else visible.attrs.attrib4345 = `|x|${Buffer.from(version).toString("hex")}`;
        }
        if (editText) findText(visible)!.text = "A\nB";
        envelope.visibleBinaryHash = sha256Hex(writeCdx(visible));
        visible.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE] = `|x|${Buffer.from(JSON.stringify(envelope)).toString("hex")}`;
        const opened = importCdx(writeCdx(visible));
        expect(opened.document).toBeUndefined();
        expect(opened.conflict?.embeddedDocument).toEqual(original);
        expect(opened.warnings.some(({ code }) => code === "cdxml.visible_layer_modified")).toBe(true);
      }
    }
  });

  it("rejects upgrading a legacy CDX selector to authorize a cross-semantics edit", () => {
    const { original, visible, envelope } = textEnvelope("A\nB", true);
    findText(visible)!.text = "A&#10;B";
    visible.attrs.attrib4345 = "|x|32";
    envelope.visibleHashVersion = "2";
    envelope.visibleBinaryHash = sha256Hex(writeCdx(visible));
    visible.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE] = `|x|${Buffer.from(JSON.stringify(envelope)).toString("hex")}`;
    expect(importCdx(writeCdx(visible)).conflict?.embeddedDocument).toEqual(original);
  });

  it("never accepts an unknown CDX version even if both visible hashes are recomputed", () => {
    const { original, visible, envelope } = textEnvelope("A&#10;B");
    visible.attrs.attrib4345 = "|x|33";
    envelope.visibleHashVersion = "3";
    envelope.visibleBinaryHash = sha256Hex(writeCdx(visible));
    envelope.tags.find(([name]: [string, string]) => name === ChemDraftObjectTags.visibleCdxmlHash)[1] = visibleHashForCdxml(cdxElementToCdxml(visible));
    visible.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE] = `|x|${Buffer.from(JSON.stringify(envelope)).toString("hex")}`;
    expect(importCdx(writeCdx(visible)).conflict?.embeddedDocument).toEqual(original);
  });

  it.each(["\n", "\r", "\t", "\n\r\t"])("restores unchanged legacy CDX with %j in text and attributes and still detects visible edits", (character) => {
    const original = requireDocument(openChemDraftPayload(wrap('<t id="4" p="20 30"><s>old</s></t>')));
    const text = original.pages[0].objects[0];
    if (text.type !== "text") throw new Error("Expected text fixture");
    text.text = `before${character}after`;
    const saved = readCdx(exportDocumentToCdx(original, { embedNativePayload: true, creationProgram: `before${character}after` }).bytes);
    // CDX stores line endings as CR and decodes them as LF. The native payload must still
    // restore the original controls exactly, with the hash covering the decoded visible layer.
    const decodedCharacter = character.replace(/\r\n?/g, "\n");
    expect(saved.attrs.CreationProgram).toBe(`before${decodedCharacter}after`);
    const envelope = JSON.parse(Buffer.from(saved.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE].slice(3), "hex").toString("utf8"));
    delete saved.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE];
    delete saved.attrs.attrib4345;
    delete envelope.visibleHashVersion;
    envelope.visibleBinaryHash = sha256Hex(writeCdx(saved));
    const xml = cdxElementToCdxml(saved);
    const legacyHash = legacyVisibleCdxmlHash(xml);
    expect(legacyHash).not.toBe(visibleHashForCdxml(xml));
    envelope.tags.find(([name]: [string, string]) => name === ChemDraftObjectTags.visibleCdxmlHash)[1] = legacyHash;
    saved.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE] = `|x|${Buffer.from(JSON.stringify(envelope)).toString("hex")}`;
    const opened = importCdx(writeCdx(saved));
    expect(opened.source).toBe("native-payload");
    expect(opened.conflict).toBeUndefined();
    expect(opened.warnings).toEqual([]);
    expect(opened.document).toEqual(original);

    const findText = (element: CdxElement): CdxElement | undefined => element.name === "s" ? element : element.kids.map(findText).find(Boolean);
    findText(saved)!.text = `Before${character}after`;
    expect(legacyVisibleCdxmlHash(cdxElementToCdxml(saved))).not.toBe(legacyHash);
    expect(visibleHashForCdxml(cdxElementToCdxml(saved))).not.toBe(legacyHash);
    const edited = importCdx(writeCdx(saved));
    expect(edited.document).toBeUndefined();
    expect(edited.conflict?.embeddedDocument).toEqual(original);
    expect(edited.conflict?.visibleDocument?.pages[0].objects[0]).toMatchObject({ text: `Before${decodedCharacter}after` });
    expect(edited.warnings.some(warning => warning.code === "cdx.native_payload_modified")).toBe(true);
    expect(edited.warnings.some(warning => warning.code === "cdxml.visible_layer_modified")).toBe(true);
  });

  it.each([
    ["current", visibleHashForCdxml],
    ["legacy", legacyVisibleCdxmlHash]
  ] as const)("requires the stored %s XML hash even when an edited CDX has a recomputed binary hash", (name, hash) => {
    const original = requireDocument(openChemDraftPayload(wrap('<t id="4" p="20 30"><s>old</s></t>')));
    const text = original.pages[0].objects[0];
    if (text.type !== "text") throw new Error("Expected text fixture");
    text.text = "before\n\r\tafter";
    const saved = readCdx(exportDocumentToCdx(original, { embedNativePayload: true, creationProgram: "before\n\r\tafter" }).bytes);
    const envelope = JSON.parse(Buffer.from(saved.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE].slice(3), "hex").toString("utf8"));
    delete saved.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE];
    if (name === "legacy") {
      delete saved.attrs.attrib4345;
      delete envelope.visibleHashVersion;
    }
    const storedHash = hash(cdxElementToCdxml(saved));
    envelope.tags.find(([name]: [string, string]) => name === ChemDraftObjectTags.visibleCdxmlHash)[1] = storedHash;

    for (const target of ["text", "attribute"]) {
      const edited = structuredClone(saved);
      const findText = (element: CdxElement): CdxElement | undefined => element.name === "s" ? element : element.kids.map(findText).find(Boolean);
      if (target === "text") findText(edited)!.text = "Before\n\r\tafter";
      else edited.attrs.CreationProgram = "Before\n\r\tafter";
      expect(legacyVisibleCdxmlHash(cdxElementToCdxml(edited))).not.toBe(storedHash);
      expect(visibleHashForCdxml(cdxElementToCdxml(edited))).not.toBe(storedHash);
      // Recompute only the binary hash; the XML hash and embedded native document stay stale.
      envelope.visibleBinaryHash = sha256Hex(writeCdx(edited));
      edited.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE] = `|x|${Buffer.from(JSON.stringify(envelope)).toString("hex")}`;
      const bytes = writeCdx(edited);
      const integrity: { visibleBinaryHash?: string } = {};
      readCdx(bytes, true, [], integrity);
      expect(integrity.visibleBinaryHash).toBe(envelope.visibleBinaryHash);
      const opened = importCdx(bytes);
      expect(opened.source).toBe("external-cdxml");
      expect(opened.document).toBeUndefined();
      expect(opened.conflict?.embeddedDocument).toEqual(original);
      if (target === "text") expect(opened.conflict?.visibleDocument?.pages[0].objects[0]).toMatchObject({ text: "Before\n\n\tafter" });
      expect(opened.warnings.some(({ code }) => code === "cdx.native_payload_modified")).toBe(false);
      expect(opened.warnings.some(({ code }) => code === "cdxml.visible_layer_modified")).toBe(true);
    }
  });

  it.each([["0700", 0x0700], ["0709", 0x0709]] as const)("detects an edit to only text property 0x%s", (_name, tag) => {
    const original = requireDocument(openChemDraftPayload(wrap('<t id="4" p="20 30"><s>old</s></t>')));
    const bytes = exportDocumentToCdx(original, { embedNativePayload: true }).bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 22, edited = false;
    while (offset < bytes.length) {
      const propertyTag = view.getUint16(offset, true); offset += 2;
      if (!propertyTag) continue;
      if (propertyTag & 0x8000) { offset += 4; continue; }
      let size = view.getUint16(offset, true); offset += 2;
      if (size === 0xffff) { size = view.getUint32(offset, true); offset += 4; }
      if (propertyTag === tag) {
        const runs = view.getUint16(offset, true);
        const start = offset + 2 + 10 * runs;
        expect(new TextDecoder().decode(bytes.subarray(start, offset + size))).toBe("old");
        bytes.set(new TextEncoder().encode("new"), start);
        edited = true;
        break;
      }
      offset += size;
    }
    expect(edited).toBe(true);
    const opened = importCdx(bytes);
    expect(opened.source).toBe("external-cdxml");
    expect(opened.document).toBeUndefined();
    expect(opened.conflict?.embeddedDocument).toEqual(original);
    expect(opened.warnings.some((w) => w.code === "cdx.native_payload_modified")).toBe(true);
    expect(opened.warnings.some((w) => w.code === "cdxml.visible_layer_modified")).toBe(true);
    if (tag === 0x0709) expect(opened.conflict?.visibleDocument?.pages[0].objects[0]).toMatchObject({ text: "new" });
  });

  it.each(examples)("Save As reopens %s as the identical native document", (_name, xml) => {
    const original = requireDocument(openChemDraftPayload(xml));
    const saved = exportDocumentToCdx(original, { embedNativePayload: true });
    expect(readCdx(saved.bytes).attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE]).toBeDefined();
    const opened = importCdx(saved.bytes);
    expect(opened.source).toBe("native-payload");
    expect(opened.conflict).toBeUndefined();
    expect(opened.warnings).toEqual([]);
    expect(opened.document).toEqual(original);
  });

  it("handles a native payload longer than 65535 bytes", () => {
    const original = createEmptyDocument();
    original.title = "x".repeat(90_000);
    const opened = importCdx(exportDocumentToCdx(original, { embedNativePayload: true }).bytes);
    expect(opened.source).toBe("native-payload");
    expect(opened.document).toEqual(original);
  });

  it("Export omits all native metadata and the user-defined property", () => {
    const original = requireDocument(openChemDraftPayload(examples[0][1]));
    const exported = exportDocumentToCdx(original, { embedNativePayload: false });
    expect(cdxElementToCdxml(readCdx(exported.bytes))).not.toContain("org.chemdraft/");
    expect(readCdx(exported.bytes).attrs.attrib4345).toBeUndefined();
    expect(importCdx(exported.bytes).source).toBe("external-cdxml");
  });

  it("detects visible edits without trusting stale embedded chemistry", () => {
    const original = requireDocument(openChemDraftPayload(examples[0][1]));
    const saved = readCdx(exportDocumentToCdx(original, { embedNativePayload: true }).bytes);
    const find = (x: CdxElement): CdxElement | undefined => x.name === "n" ? x : x.kids.map(find).find(Boolean);
    find(saved)!.attrs.Charge = "1";
    const opened = importCdx(writeCdx(saved));
    expect(opened.document).toBeUndefined();
    expect(opened.conflict?.embeddedDocument).toEqual(original);
    expect(opened.warnings.some((w) => w.code === "cdxml.visible_layer_modified")).toBe(true);
  });

  it("warns about a malformed native envelope and still imports the visible subset", () => {
    const root = tree(examples[0][1]); root.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE] = "|x|7B";
    const opened = importCdx(writeCdx(root));
    expect(opened.document).toBeDefined();
    expect(opened.warnings.some((w) => w.code === "cdx.native_payload_invalid")).toBe(true);
  });

  it("requires conflict review for an older envelope without a binary integrity hash", () => {
    const original = requireDocument(openChemDraftPayload(examples[0][1]));
    const saved = readCdx(exportDocumentToCdx(original, { embedNativePayload: true }).bytes);
    const encoded = saved.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE].slice(3);
    const envelope = JSON.parse(Buffer.from(encoded, "hex").toString("utf8"));
    delete envelope.visibleBinaryHash;
    saved.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE] = `|x|${Buffer.from(JSON.stringify(envelope)).toString("hex")}`;
    const opened = importCdx(writeCdx(saved));
    expect(opened.source).toBe("external-cdxml");
    expect(opened.document).toBeUndefined();
    expect(opened.conflict?.embeddedDocument).toEqual(original);
    expect(opened.warnings.some((w) => w.code === "cdx.native_payload_modified")).toBe(true);
  });
});
