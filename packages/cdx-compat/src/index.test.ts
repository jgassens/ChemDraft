import { describe, expect, it } from "vitest";
import {
  ChemDraftDocumentSchema,
  DocumentSchemaVersion,
  createEmptyDocument,
  serializeDocument,
  type ArrowObject,
  type ChemDraftDocument,
  type GraphicObject,
  type MoleculeObject,
  type TextObject
} from "@chemdraft/chem-core";
import { cdxmlFixtures } from "@chemdraft/fixtures";
import {
  CdxmlEnvelopeCodecVersion,
  ChemDraftObjectTags,
  canonicalVisibleCdxml,
  decodeBase64UrlUtf8,
  exportDocumentToCdxml,
  openChemDraftPayload,
  sha256Utf8Hex,
  visibleHashForCdxml
} from "./index";
import { sha256Hex, utf8Bytes } from "./sha256";

describe("CDXML-compatible ChemDraft envelope", () => {
  it("hashes UTF-8 bytes with the bundled SHA-256 helper", () => {
    expect(sha256Hex(utf8Bytes("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("exports a deterministic CDXML envelope with hidden native payload metadata", () => {
    const document = createEmptyDocument({ title: "Escaped & Quoted", now: "2026-06-06T00:00:00.000Z" });
    const result = exportDocumentToCdxml(document, { creationProgram: 'Test "Build" & Check' });
    const nativeJson = serializeDocument(document);

    expect(result.warnings).toEqual([]);
    expect(result.contents).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(result.contents).toContain('<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd">');
    expect(result.contents).toContain('CreationProgram="Test &quot;Build&quot; &amp; Check"');
    expect(result.contents).toContain(`<objecttag Name="${ChemDraftObjectTags.nativeDocument}"`);
    expect(result.contents).toContain('Persistent="yes" TagType="String" Value="');
    expect(result.contents).not.toContain("<fragment");

    expect(extractObjectTag(result.contents, ChemDraftObjectTags.codecVersion)).toBe(CdxmlEnvelopeCodecVersion);
    expect(extractObjectTag(result.contents, ChemDraftObjectTags.schemaVersion)).toBe(DocumentSchemaVersion);
    expect(extractObjectTag(result.contents, ChemDraftObjectTags.nativePayloadHash)).toBe(sha256Utf8Hex(nativeJson));
    expect(decodeBase64UrlUtf8(extractObjectTag(result.contents, ChemDraftObjectTags.nativeDocument))).toBe(nativeJson);
    expect(extractObjectTag(result.contents, ChemDraftObjectTags.visibleCdxmlHash)).toBe(visibleHashForCdxml(result.contents));
  });

  it("preserves non-ASCII native text through UTF-8 base64url payload encoding", () => {
    const document = documentWithObjects([
      {
        id: "text_unicode",
        type: "text",
        x: 120,
        y: 140,
        width: 220,
        height: 42,
        rotation: 0,
        style: {},
        text: "Delta G = -5.2 kJ mol-1; cafe; snowman; ΔG° café ☃",
        spans: []
      }
    ]);
    const result = exportDocumentToCdxml(document, { creationProgram: "Unicode Test" });

    expect(openChemDraftPayload(result.contents).document).toEqual(document);
  });

  it("canonicalizes writer and reader visible projections through the same parsed tree path", () => {
    const document = documentWithObjects([singleBondMolecule()]);
    const result = exportDocumentToCdxml(document, { creationProgram: "Canonical Test" });
    const visibleHash = extractObjectTag(result.contents, ChemDraftObjectTags.visibleCdxmlHash);

    expect(visibleHash).toBe(visibleHashForCdxml(result.contents));
    expect(canonicalVisibleCdxml(result.contents)).toContain("<fragment");
    expect(result.contents).toContain('p="75 111"');
    expect(canonicalVisibleCdxml(result.contents)).not.toContain("org.chemdraft/native-document");
  });

  it("exports visible CDXML page and atom coordinates as vertical-then-horizontal", () => {
    const document = documentWithObjects([
      {
        ...singleBondMolecule(),
        id: "mol_coordinate_order",
        x: 160,
        y: 190,
        width: 72,
        height: 104,
        atoms: [
          { id: "atom_001", element: "C", x: 174.5, y: 210.20703125, formalCharge: 0 },
          { id: "atom_002", element: "C", x: 196.5, y: 210.20703125, formalCharge: 0 },
          { id: "atom_003", element: "C", x: 203.84375090314296, y: 230.94514405402793, formalCharge: 0 }
        ],
        bonds: [
          { id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" },
          { id: "bond_002", fromAtomId: "atom_002", toAtomId: "atom_003", order: "single" }
        ]
      }
    ]);
    const result = exportDocumentToCdxml(document, { creationProgram: "Coordinate Order Test" });

    expect(result.contents).toContain('<page id="page_001" BoundingBox="0 0 792 612">');
    expect(result.contents).toContain('p="157.6553 130.875"');
    expect(result.contents).toContain('p="157.6553 147.375"');
    expect(result.contents).toContain('p="173.2089 152.8828"');
    expect(result.contents).not.toContain('p="130.875 157.6553"');
  });

  it("canonicalizes equivalent visible XML despite comments, whitespace, CDATA, and attribute ordering", () => {
    const withNoise = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<CDXML b="2" a="1">',
      '  <?chemdraft-test ignored?>',
      '  <page id="p1">',
      '    <!-- ignored -->',
      '    <t p="1 2" id="t1"><![CDATA[A & B]]></t>',
      '  </page>',
      '</CDXML>'
    ].join("\n");
    const clean = '<CDXML a="1" b="2"><page id="p1"><t id="t1" p="1 2">A &amp; B</t></page></CDXML>';

    expect(canonicalVisibleCdxml(withNoise)).toBe(canonicalVisibleCdxml(clean));
    expect(visibleHashForCdxml(withNoise)).toBe(visibleHashForCdxml(clean));
  });

  it("reports each export compatibility warning once while reusing the hashed visible projection", () => {
    const document = documentWithObjects([
      {
        ...singleBondMolecule(),
        bonds: [{ id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "aromatic" }]
      }
    ]);
    const result = exportDocumentToCdxml(document, { creationProgram: "Warning Test" });

    expect(result.warnings.filter((item) => item.code === "cdxml.aromatic_bond_approximation")).toHaveLength(1);
    expect(extractObjectTag(result.contents, ChemDraftObjectTags.visibleCdxmlHash)).toBe(visibleHashForCdxml(result.contents));
  });

  it("exports text, plus signs, and reaction arrows visibly while warning for payload-only reaction metadata", () => {
    const document = documentWithObjects([
      {
        id: "text_001",
        type: "text",
        x: 96,
        y: 112,
        width: 120,
        height: 24,
        rotation: 0,
        style: {},
        text: "A + B",
        spans: []
      },
      {
        id: "plus_001",
        type: "plus",
        x: 140,
        y: 112,
        width: 16,
        height: 16,
        rotation: 0,
        style: {}
      },
      {
        id: "arrow_001",
        type: "reaction-arrow",
        x: 180,
        y: 112,
        width: 80,
        height: 16,
        rotation: 0,
        style: {},
        arrowKind: "forward",
        start: { kind: "point", point: { x: 180, y: 120 } },
        end: { kind: "point", point: { x: 260, y: 120 } },
        labels: []
      },
      {
        id: "reaction_001",
        type: "reaction",
        x: 90,
        y: 100,
        width: 190,
        height: 40,
        rotation: 0,
        style: {},
        components: [],
        conditionsTextObjectIds: [],
        mappingState: "unknown"
      },
      {
        id: "mechanism_001",
        type: "mechanism-arrow",
        x: 96,
        y: 170,
        width: 64,
        height: 40,
        rotation: 0,
        style: {},
        arrowKind: "full-headed",
        source: { kind: "point", point: { x: 96, y: 170 } },
        target: { kind: "point", point: { x: 160, y: 210 } },
        controlPoints: [],
        warnings: []
      }
    ]);
    const result = exportDocumentToCdxml(document, { creationProgram: "Visible Objects Test" });

    expect(result.contents).toContain("<t ");
    expect(result.contents).toContain(">A + B</t>");
    expect(result.contents).toContain(">+</t>");
    expect(result.contents).toContain('<graphic id="');
    expect(result.contents).toContain('GraphicType="Line"');
    expect(result.contents).toContain('ArrowType="forward"');
    expect(result.warnings.map((item) => item.code)).toEqual([
      "cdxml.reaction_scheme_export_partial",
      "cdxml.mechanism_payload_only"
    ]);
  });

  it("warns only for native graphic style that visible CDXML cannot represent", () => {
    const graphic = {
      id: "art_cdxml_effects",
      type: "graphic",
      x: 120,
      y: 140,
      width: 72,
      height: 40,
      rotation: 0,
      style: {
        strokeColor: "#111111",
        fillColor: "#1d7f68",
        strokeWidth: 2,
        strokeDasharray: "3 4",
        fillMode: "gloss",
        effect: "shadow",
        tiltXDegrees: 20,
        tiltYDegrees: -10
      },
      graphicKind: "rect",
      data: {
        cornerRadiusPx: 7,
        artToolId: "roundedRectGloss"
      }
    } satisfies GraphicObject;
    const document = documentWithObjects([graphic]);
    const result = exportDocumentToCdxml(document, { creationProgram: "Graphic Warning Test" });

    expect(result.contents).toContain('<graphic id="');
    expect(result.contents).toContain('GraphicType="Rectangle"');
    expect(result.contents).toContain('RectangleType="RoundEdge Shadow"');
    expect(result.contents).toContain('CornerRadius="525"');
    expect(result.warnings.map((item) => item.code)).toEqual([
      "cdxml.graphic_color_approximation",
      "cdxml.graphic_gloss_payload_only",
      "cdxml.graphic_tilt_payload_only"
    ]);
    expect(openChemDraftPayload(result.contents).document?.pages[0].objects[0]).toMatchObject({
      type: "graphic",
      style: { fillMode: "gloss", effect: "shadow" },
      data: { cornerRadiusPx: 7, artToolId: "roundedRectGloss" }
    });
  });

  it("warns when a native graphic path bend cannot be represented exactly in visible CDXML", () => {
    const graphic = {
      id: "art_cdxml_bent_line",
      type: "graphic",
      x: 94,
      y: 84,
      width: 132,
      height: 92,
      rotation: 0,
      style: {
        strokeColor: "#000000",
        strokeWidth: 2
      },
      graphicKind: "path",
      data: {
        artPathKind: "quadratic",
        lineStart: { x: 100, y: 170 },
        pathControlPoint: { x: 160, y: 90 },
        lineEnd: { x: 220, y: 170 }
      }
    } satisfies GraphicObject;
    const result = exportDocumentToCdxml(documentWithObjects([graphic]), {
      creationProgram: "Graphic Bend Warning Test"
    });

    expect(result.contents).toContain('GraphicType="Line"');
    expect(openChemDraftPayload(result.contents).document?.pages[0].objects[0]).toMatchObject({
      type: "graphic",
      data: {
        pathControlPoint: { x: 160, y: 90 }
      }
    });
    expect(result.warnings.map((item) => item.code)).toContain("cdxml.graphic_path_control_payload_only");
  });

  it("exports circular graphic arcs from native radian sweep metadata", () => {
    const graphic = {
      id: "art_cdxml_circle_arc",
      type: "graphic",
      x: 40,
      y: 60,
      width: 58,
      height: 58,
      rotation: 0,
      style: {
        strokeColor: "#000000",
        strokeWidth: 2
      },
      graphicKind: "path",
      data: {
        artPathKind: "arc",
        arcStartRadians: 0,
        arcSweepRadians: Math.PI * 1.5
      }
    } satisfies GraphicObject;
    const result = exportDocumentToCdxml(documentWithObjects([graphic]), {
      creationProgram: "Graphic Circular Arc Export Test"
    });

    expect(result.contents).toContain('GraphicType="Arc"');
    expect(result.contents).toContain('AngularSize="270"');
    expect(result.contents).toContain('Start="66.75 70.5"');
    expect(result.contents).toContain('End="48 51.75"');
    expect(result.warnings).toEqual([]);
  });

  it("imports CDXML arcs as circular native graphic arcs with radian angles", () => {
    const opened = openChemDraftPayload(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE CDXML SYSTEM "https://static.chemistry.revvitycloud.com/cdxml/CDXML.dtd">
<CDXML CreationProgram="Arc Import Test">
  <page id="20" BoundingBox="0 0 540 720">
    <graphic id="7" BoundingBox="30 45 73.5 88.5" GraphicType="Arc" AngularSize="270" Start="66.75 70.5" End="48 51.75"/>
  </page>
</CDXML>`);
    const graphic = opened.document?.pages[0].objects[0] as GraphicObject | undefined;

    expect(opened.source).toBe("external-cdxml");
    expect(graphic).toMatchObject({
      type: "graphic",
      graphicKind: "path",
      data: {
        artPathKind: "arc"
      }
    });
    expect(graphic?.data.arcStartRadians).toBeCloseTo(0, 6);
    expect(graphic?.data.arcSweepRadians).toBeCloseTo(Math.PI * 1.5, 6);
    expect(graphic?.data.lineStart).toBeUndefined();
    expect(graphic?.data.lineEnd).toBeUndefined();
  });

  it("round-trips a clockwise (negative sweep) graphic arc without flipping direction", () => {
    const graphic = {
      id: "art_cdxml_cw_arc",
      type: "graphic",
      x: 40,
      y: 60,
      width: 58,
      height: 58,
      rotation: 0,
      style: { strokeColor: "#000000", strokeWidth: 2 },
      graphicKind: "path",
      data: {
        artPathKind: "arc",
        arcStartRadians: 0,
        arcSweepRadians: -Math.PI / 2
      }
    } satisfies GraphicObject;
    const result = exportDocumentToCdxml(documentWithObjects([graphic]), {
      creationProgram: "Clockwise Arc Round Trip"
    });

    expect(result.contents).toContain('AngularSize="-90"');

    const reopened = openChemDraftPayload(result.contents).document?.pages[0].objects[0] as
      | GraphicObject
      | undefined;
    expect(reopened?.data.arcSweepRadians).toBeCloseTo(-Math.PI / 2, 6);
  });

  it("exports the fill color (not stroke) for filled graphic shapes", () => {
    const graphic = {
      id: "art_cdxml_filled_rect",
      type: "graphic",
      x: 40,
      y: 60,
      width: 80,
      height: 50,
      rotation: 0,
      style: {
        strokeColor: "#000000",
        fillColor: "#00ff00",
        strokeWidth: 2
      },
      graphicKind: "rect",
      data: {}
    } satisfies GraphicObject;
    const result = exportDocumentToCdxml(documentWithObjects([graphic]), {
      creationProgram: "Filled Shape Color Export"
    });

    expect(result.contents).toContain('RectangleType="Filled"');
    // Pure green resolves to CDXML color index 6 (table slot 4, offset by the reserved black/white).
    expect(result.contents).toContain('color="6"');
    expect(result.warnings.map((item) => item.code)).toContain("cdxml.graphic_single_color");

    const reopened = openChemDraftPayload(result.contents).document?.pages[0].objects[0] as
      | GraphicObject
      | undefined;
    expect(reopened?.style.fillColor?.toLowerCase()).toBe("#00ff00");
  });

  it("imports and exports ChemDraw shape graphics as native graphic objects", () => {
    const opened = openChemDraftPayload(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE CDXML SYSTEM "https://static.chemistry.revvitycloud.com/cdxml/CDXML.dtd">
<CDXML CreationProgram="ChemDraw 26.0.0.6599">
  <colortable>
    <color r="1" g="1" b="1"/>
    <color r="0" g="0" b="0"/>
    <color r="1" g="0" b="0"/>
    <color r="1" g="1" b="0"/>
    <color r="0" g="1" b="0"/>
    <color r="0" g="1" b="1"/>
    <color r="0" g="0" b="1"/>
    <color r="1" g="0" b="1"/>
  </colortable>
  <page id="20" BoundingBox="0 0 540 720">
    <graphic id="7" BoundingBox="202.34 192 121 192" Z="1" color="8" GraphicType="Oval" OvalType="Circle Shaded" Center3D="121 192 0" MajorAxisEnd3D="202.34 192 0" MinorAxisEnd3D="121 273.34 0"/>
    <graphic id="10" SupersededBy="22" BoundingBox="329.66 376.34 201 505" Z="4" color="9" LineType="Wavy" GraphicType="Line"/>
    <arrow id="22" BoundingBox="200.08 375.42 330.58 505.92" Z="4" color="9" LineType="Wavy" FillType="None" ArrowheadType="Solid" Head3D="329.66 376.34 0" Tail3D="201 505 0" Center3D="265.33 440.67 0" MajorAxisEnd3D="447.28 440.67 0" MinorAxisEnd3D="265.33 622.62 0"/>
    <graphic id="17" BoundingBox="491 168 441.95 76.95" Z="11" color="4" GraphicType="Rectangle" RectangleType="Filled" Center3D="466.47 122.47 0" MajorAxisEnd3D="491 122.47 0" MinorAxisEnd3D="466.47 168 0"/>
  </page>
</CDXML>`);
    const objects = opened.document?.pages[0].objects ?? [];
    const [circle, wavy, rectangle] = objects as GraphicObject[];

    expect(opened.source).toBe("external-cdxml");
    expect(objects.map((object) => object.type)).toEqual(["graphic", "graphic", "graphic"]);
    expect(circle).toMatchObject({
      graphicKind: "ellipse",
      style: {
        strokeColor: "#0000ff",
        fillColor: "#0000ff",
        fillMode: "gloss"
      }
    });
    expect(wavy).toMatchObject({
      graphicKind: "path",
      style: {
        strokeColor: "#ff00ff"
      },
      data: {
        artPathKind: "wavy"
      }
    });
    expect(wavy.data.lineStart?.x).toBeCloseTo(268, 6);
    expect(wavy.data.lineStart?.y).toBeCloseTo(673.3333333333334, 6);
    expect(wavy.data.lineEnd?.x).toBeCloseTo(439.5466666666667, 6);
    expect(wavy.data.lineEnd?.y).toBeCloseTo(501.7866666666667, 6);
    expect(wavy.x).toBeCloseTo(266.7733333333333, 6);
    expect(wavy.y).toBeCloseTo(500.56, 6);
    expect(wavy.width).toBeCloseTo(174, 6);
    expect(wavy.height).toBeCloseTo(174, 6);
    expect(rectangle).toMatchObject({
      graphicKind: "rect",
      style: {
        strokeColor: "#ff0000",
        fillColor: "#ff0000",
        fillMode: "solid"
      }
    });

    const exported = exportDocumentToCdxml(opened.document ?? documentWithObjects([]), { creationProgram: "Shape Round Trip Test" });
    expect(exported.contents).toContain("<colortable>");
    expect(exported.contents).toContain('GraphicType="Oval"');
    expect(exported.contents).toContain('OvalType="Circle Shaded"');
    expect(exported.contents).toContain('color="8"');
    expect(exported.contents).toContain("<arrow ");
    expect(exported.contents).toContain('LineType="Wavy"');
    expect(exported.contents).toContain('color="9"');
    expect(exported.contents).toContain('GraphicType="Rectangle"');
    expect(exported.contents).toContain('RectangleType="Filled"');
    expect(exported.contents).toContain('color="4"');
    expect(exported.warnings).toEqual([]);
  });

  it("opens legacy JSON with a BOM and leading whitespace", () => {
    const document = documentWithObjects([singleBondMolecule()]);
    const result = openChemDraftPayload(`\uFEFF  ${serializeDocument(document)}`);

    expect(result.source).toBe("legacy-json");
    expect(result.warnings).toEqual([]);
    expect(result.document).toEqual(document);
  });

  it("returns warning results for empty or unrecognized payloads", () => {
    const empty = openChemDraftPayload("\uFEFF  ");
    const unrecognized = openChemDraftPayload("not a document");

    expect(empty.document).toBeUndefined();
    expect(empty.warnings.map((item) => item.code)).toContain("cdxml.empty_payload");
    expect(unrecognized.document).toBeUndefined();
    expect(unrecognized.warnings.map((item) => item.code)).toContain("cdxml.unrecognized_payload");
  });

  it("detects tampered embedded native payloads", () => {
    const document = documentWithObjects([singleBondMolecule()]);
    const result = exportDocumentToCdxml(document, { creationProgram: "Tamper Test" });
    const payload = extractObjectTag(result.contents, ChemDraftObjectTags.nativeDocument);
    const tampered = result.contents.replace(payload, `${payload.slice(0, -1)}A`);
    const opened = openChemDraftPayload(tampered);

    expect(opened.document).toBeUndefined();
    expect(opened.warnings.map((item) => item.code)).toContain("cdxml.native_payload_hash_mismatch");
  });

  it("detects visible-layer modification and returns a conflict instead of silently restoring stale JSON", () => {
    const document = documentWithObjects([singleBondMolecule()]);
    const result = exportDocumentToCdxml(document, { creationProgram: "Conflict Test" });
    const externallyEdited = result.contents.replace("</fragment>", "</fragment><t id=\"999\" p=\"0 0\">Edited elsewhere</t>");
    const opened = openChemDraftPayload(externallyEdited);

    expect(opened.document).toBeUndefined();
    expect(opened.conflict?.kind).toBe("visible-layer-modified");
    expect(opened.conflict?.embeddedDocument).toEqual(document);
    expect(opened.conflict?.visibleDocument?.pages[0].objects.some((object) => object.type === "text")).toBe(true);
    expect(opened.warnings.map((item) => item.code)).toContain("cdxml.visible_layer_modified");
  });

  it("returns a friendly unsupported-version warning for forward codec versions", () => {
    const document = createEmptyDocument({ now: "2026-06-06T00:00:00.000Z" });
    const result = exportDocumentToCdxml(document, { creationProgram: "Future Test" });
    const future = replaceObjectTag(result.contents, ChemDraftObjectTags.codecVersion, "chemdraft.cdxml.v999");
    const opened = openChemDraftPayload(future);

    expect(opened.document).toBeUndefined();
    expect(opened.warnings.map((item) => item.code)).toContain("cdxml.codec_version_unsupported");
  });

  it("returns a friendly unsupported-version warning for forward legacy JSON schemas", () => {
    const document = createEmptyDocument({ now: "2026-06-06T00:00:00.000Z" });
    const futureJson = JSON.stringify({ ...document, schema: "chemdraft.document.v999" }, null, 2);
    const opened = openChemDraftPayload(futureJson);

    expect(opened.document).toBeUndefined();
    expect(opened.source).toBe("legacy-json");
    expect(opened.warnings.map((item) => item.code)).toContain("cdxml.schema_version_unsupported");
  });

  it("reports external CDXML without a supported visible subset instead of crashing", () => {
    const opened = openChemDraftPayload(cdxmlFixture("empty-page.cdxml"));

    expect(opened.source).toBe("external-cdxml");
    expect(opened.document).toBeUndefined();
    expect(opened.warnings.map((item) => item.code)).toContain("cdxml.external_import_not_implemented");
  });

  it("returns a warning result for malformed XML", () => {
    const opened = openChemDraftPayload("<CDXML><page></CDXML>");

    expect(opened.document).toBeUndefined();
    expect(opened.warnings.map((item) => item.code)).toContain("cdxml.malformed_xml");
  });

  it("imports a synthetic visible CDXML molecule subset as a valid native molecule", () => {
    const opened = openChemDraftPayload(cdxmlFixture("heteroatom-double.cdxml"));

    expect(opened.document).toBeDefined();
    const molecule = opened.document?.pages[0].objects[0] as MoleculeObject | undefined;
    expect(molecule).toMatchObject({
      type: "molecule",
      structureFormat: "unknown",
      structure: "",
      atoms: [
        { element: "C", x: 100, y: 100, formalCharge: 0 },
        { element: "O", x: 148, y: 100, formalCharge: -1 }
      ],
      bonds: [{ fromAtomId: "atom_001", toAtomId: "atom_002", order: "double" }]
    });
    expect(opened.warnings.map((item) => item.code)).toContain("cdxml.structure_string_not_derived");
  });

  it("imports CDXML p and BoundingBox coordinates as vertical-then-horizontal", () => {
    const opened = openChemDraftPayload(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd">
<CDXML CreationProgram="ChemDraft Synthetic Fixture">
  <page id="p1" BoundingBox="0 0 720 540">
    <fragment id="top" BoundingBox="100 120 100 156">
      <n id="a1" p="100 120"/>
      <n id="a2" p="100 156"/>
      <b id="b1" B="a1" E="a2" Order="1"/>
    </fragment>
    <fragment id="bottom" BoundingBox="220 120 220 156">
      <n id="a3" p="220 120"/>
      <n id="a4" p="220 156"/>
      <b id="b2" B="a3" E="a4" Order="1"/>
    </fragment>
    <t id="label" p="300 120">vertical stack</t>
  </page>
</CDXML>`);

    const [top, bottom, label] = opened.document?.pages[0].objects ?? [];

    expect(top?.type).toBe("molecule");
    expect(bottom?.type).toBe("molecule");
    expect(label?.type).toBe("text");
    expect(top?.x).toBeCloseTo(bottom?.x ?? 0);
    expect(bottom?.y ?? 0).toBeGreaterThan((top?.y ?? 0) + 100);
    expect(label?.y ?? 0).toBeGreaterThan((bottom?.y ?? 0) + 100);
  });

  it("rotates ChemDraw 26 visible CDXML into the displayed page orientation", () => {
    const opened = openChemDraftPayload(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE CDXML SYSTEM "https://static.chemistry.revvitycloud.com/cdxml/CDXML.dtd">
<CDXML CreationProgram="ChemDraw 26.0.0.6599">
  <page id="p1" BoundingBox="0 0 540 720">
    <fragment id="vertical" BoundingBox="100 120 100 156">
      <n id="a1" p="100 120" Element="17"><t p="96 118" BoundingBox="94 112 102 124">Cl</t></n>
      <n id="a2" p="100 156"/>
      <b id="b1" B="a1" E="a2" Order="1"/>
    </fragment>
  </page>
</CDXML>`);

    const molecule = opened.document?.pages[0].objects[0] as MoleculeObject | undefined;

    expect(molecule?.atoms[0]?.x).toBeCloseTo(184);
    expect(molecule?.atoms[0]?.y).toBeCloseTo(109.33333333333334);
    expect(molecule?.atoms[1]?.x).toBeCloseTo(184);
    expect(molecule?.atoms[1]?.y).toBeCloseTo(157.33333333333334);
    expect(molecule?.atoms[0]?.labelOffset?.x).toBeCloseTo(2.666666666666657);
    expect(molecule?.atoms[0]?.labelOffset?.y).toBeCloseTo(-2.666666666666657);
    expect((molecule?.height ?? 0)).toBeGreaterThan(molecule?.width ?? 0);
  });

  it("imports a renamed ChemDraw CDXML file from the visible layer when ChemDraft payload tags are absent", () => {
    const opened = openChemDraftPayload(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd">
<CDXML CreationProgram="External CDXML Fixture">
  <page id="page_001" BoundingBox="0 0 792 612">
    <fragment id="1" BoundingBox="145.6553 124.875 224.6208 168.0677">
      <n id="2" p="157.6553 130.875"/>
      <n id="3" p="157.6553 147.375"/>
      <n id="4" p="173.2089 152.8828"/>
      <n id="5" p="183.5926 140.0599"/>
      <n id="6" p="199.1462 145.5677"/>
      <n id="7" p="199.1462 162.0677"/>
      <n id="8" p="212.6208 136.0448"/>
      <b id="9" B="2" E="3" Order="1"/>
      <b id="10" B="3" E="4" Order="1"/>
      <b id="11" B="4" E="5" Order="1"/>
      <b id="12" B="5" E="6" Order="1"/>
      <b id="13" B="6" E="7" Order="1"/>
      <b id="14" B="6" E="8" Order="1"/>
    </fragment>
  </page>
</CDXML>`);

    const molecule = opened.document?.pages[0].objects[0] as MoleculeObject | undefined;
    expect(opened.source).toBe("external-cdxml");
    expect(molecule?.atoms).toHaveLength(7);
    expect(molecule?.bonds).toHaveLength(6);
    expect(molecule?.atoms[0]?.element).toBe("C");
    expect(molecule?.atoms[0]?.x).toBeCloseTo(174.5);
    expect(molecule?.atoms[0]?.y).toBeCloseTo(210.20706666666667);
    expect(molecule?.atoms[5]?.element).toBe("C");
    expect(molecule?.atoms[5]?.x).toBeCloseTo(216.0896);
    expect(molecule?.atoms[5]?.y).toBeCloseTo(265.52826666666665);
    expect(molecule?.bonds[5]).toMatchObject({
      fromAtomId: "atom_005",
      toAtomId: "atom_007",
      order: "single"
    });
    expect(opened.warnings.map((item) => item.code)).toContain("cdxml.external_subset_imported");

    const exported = exportDocumentToCdxml(opened.document!);
    expect(exported.contents).toContain('p="157.6553 130.875"');
    expect(exported.contents).toContain('p="199.1462 162.0677"');
    expect(exported.contents).toContain('p="212.6208 136.0448"');
  });

  it("infers ring double-bond side from ChemDraw circular ordering", () => {
    const opened = openChemDraftPayload(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd">
<CDXML CreationProgram="ChemDraft Synthetic Fixture">
  <page id="p1" BoundingBox="0 0 540 720">
    <fragment id="ring" BoundingBox="80 80 170 170">
      <n id="a1" p="100 100"/>
      <n id="a2" p="136 100"/>
      <n id="a3" p="154 132"/>
      <n id="a4" p="136 164"/>
      <n id="a5" p="100 164"/>
      <n id="a6" p="82 132"/>
      <b id="b12" B="a1" E="a2" Order="2" BondCircularOrdering="b61 0 0 b23"/>
      <b id="b23" B="a2" E="a3"/>
      <b id="b34" B="a3" E="a4" Order="2" DoublePosition="Left"/>
      <b id="b45" B="a4" E="a5"/>
      <b id="b56" B="a5" E="a6"/>
      <b id="b61" B="a6" E="a1"/>
    </fragment>
  </page>
</CDXML>`);

    const molecule = opened.document?.pages[0].objects[0] as MoleculeObject | undefined;

    expect(molecule?.bonds[0]).toMatchObject({
      order: "double",
      display: { doubleBondSide: "right" }
    });
    expect(molecule?.bonds[2]).toMatchObject({
      order: "double",
      display: { doubleBondSide: "right" }
    });
  });

  it("keeps imported cyclic double-bond secondary lines inside the ring", () => {
    const opened = openChemDraftPayload(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd">
<CDXML CreationProgram="ChemDraft Synthetic Fixture">
  <page id="p1" BoundingBox="0 0 540 720">
    <fragment id="ring" BoundingBox="80 80 170 170">
      <n id="a1" p="100 100"/>
      <n id="a2" p="136 100"/>
      <n id="a3" p="154 132"/>
      <n id="a4" p="136 164"/>
      <n id="a5" p="100 164"/>
      <n id="a6" p="82 132"/>
      <b id="b12" B="a1" E="a2" Order="2"/>
      <b id="b23" B="a2" E="a3"/>
      <b id="b34" B="a3" E="a4" Order="2" DoublePosition="Left"/>
      <b id="b45" B="a4" E="a5"/>
      <b id="b56" B="a5" E="a6"/>
      <b id="b61" B="a6" E="a1"/>
    </fragment>
  </page>
</CDXML>`);

    const molecule = opened.document?.pages[0].objects[0] as MoleculeObject | undefined;

    expect(molecule?.bonds[0]).toMatchObject({
      order: "double",
      display: { doubleBondSide: "right" }
    });
    expect(molecule?.bonds[2]).toMatchObject({
      order: "double",
      display: { doubleBondSide: "right" }
    });
  });

  it("imports synthetic single and triple bond fixtures", () => {
    const single = openChemDraftPayload(cdxmlFixture("single-bond.cdxml"));
    const triple = openChemDraftPayload(cdxmlFixture("triple-bond.cdxml"));

    expect((single.document?.pages[0].objects[0] as MoleculeObject | undefined)?.bonds[0].order).toBe("single");
    expect((triple.document?.pages[0].objects[0] as MoleculeObject | undefined)?.bonds[0].order).toBe("triple");
    expect((triple.document?.pages[0].objects[0] as MoleculeObject | undefined)?.atoms[1].element).toBe("N");
  });

  it("imports aromatic and visible bond display fixture paths", () => {
    const aromatic = openChemDraftPayload(cdxmlFixture("aromatic-bond.cdxml"));
    const displays = openChemDraftPayload(cdxmlFixture("wedge-hash-dash-bold.cdxml"));
    const displayMolecule = displays.document?.pages[0].objects[0] as MoleculeObject | undefined;

    expect((aromatic.document?.pages[0].objects[0] as MoleculeObject | undefined)?.bonds[0].order).toBe("aromatic");
    expect(aromatic.warnings.map((item) => item.code)).toContain("cdxml.aromatic_bond_import_approximation");
    expect(displayMolecule?.bonds.map((bond) => bond.display?.bondStyle)).toEqual([
      "wedge",
      "hashed",
      "dashed",
      "bold"
    ]);
    expect(displays.warnings.map((item) => item.code)).not.toContain("cdxml.bond_display_unsupported");
  });

  it("imports ChemDraw wedge/hash stereo bonds with the narrow end kept at the stereocenter", () => {
    const opened = openChemDraftPayload(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd">
<CDXML CreationProgram="ChemDraft Synthetic Fixture">
  <page id="p1" BoundingBox="0 0 540 720">
    <fragment id="stereocenter">
      <n id="c0" p="150 150"/>
      <n id="n1" p="186 150"/>
      <n id="n2" p="114 150"/>
      <n id="n3" p="150 186"/>
      <b id="bw" B="c0" E="n1" Order="1" Display="WedgeBegin"/>
      <b id="bh" B="c0" E="n2" Order="1" Display="WedgedHashBegin"/>
      <b id="be" B="n3" E="c0" Order="1" Display="WedgeEnd"/>
    </fragment>
  </page>
</CDXML>`);

    const molecule = opened.document?.pages[0].objects[0] as MoleculeObject | undefined;

    // c0 (atom_001) is the stereocenter, so every wedge/hash narrow end (fromAtomId)
    // is atom_001, including WedgeEnd which imports with B/E swapped.
    expect(molecule?.bonds[0]).toMatchObject({
      fromAtomId: "atom_001",
      toAtomId: "atom_002",
      order: "single",
      display: { bondStyle: "wedge" }
    });
    expect(molecule?.bonds[1]).toMatchObject({
      fromAtomId: "atom_001",
      toAtomId: "atom_003",
      order: "single",
      display: { bondStyle: "hashed" }
    });
    expect(molecule?.bonds[2]).toMatchObject({
      fromAtomId: "atom_001",
      toAtomId: "atom_004",
      order: "single",
      display: { bondStyle: "wedge" }
    });
    const survivingWedges = molecule?.bonds.filter((bond) => bond.display?.bondStyle).length ?? 0;
    expect(survivingWedges).toBe(3);
    expect(opened.warnings.map((item) => item.code)).not.toContain("cdxml.bond_display_unsupported");
  });

  it("preserves CDXML atom R/S assignments as aggregate molecule stereochemistry", () => {
    const opened = openChemDraftPayload(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd">
<CDXML CreationProgram="ChemDraw 26.0.0.6599">
  <page id="p1" BoundingBox="0 0 540 720">
    <fragment id="rs-centers">
      <n id="c0" p="150 150" Geometry="Tetrahedral" AS="S"/>
      <n id="c1" p="186 150" Geometry="Tetrahedral" AS="R"/>
      <n id="n1" p="150 186" AS="N"/>
      <b id="bw" B="c0" E="n1" Order="1" Display="WedgeBegin"/>
      <b id="bh" B="c1" E="n1" Order="1" Display="WedgedHashBegin"/>
    </fragment>
  </page>
</CDXML>`);

    const molecule = opened.document?.pages[0].objects[0] as MoleculeObject | undefined;

    expect(molecule?.chemistry?.stereochemistry).toEqual(["atom_001:S", "atom_002:R"]);
    expect(molecule?.compatibility?.unknown.cdxmlAtomStereochemistryByAtomId).toEqual({
      atom_001: { assignment: "S", cdxmlAtomId: "c0", geometry: "Tetrahedral" },
      atom_002: { assignment: "R", cdxmlAtomId: "c1", geometry: "Tetrahedral" }
    });
    expect(molecule?.chemistry?.atomCount).toBe(3);
    expect(molecule?.chemistry?.bondCount).toBe(2);
    expect(opened.warnings.map((item) => item.code)).not.toContain("cdxml.bond_display_unsupported");
  });

  it("exports native wedge and hash bonds as ChemDraw Begin-variant Display values", () => {
    const document = documentWithObjects([
      {
        ...singleBondMolecule(),
        atoms: [
          { id: "atom_001", element: "C", x: 100, y: 100, formalCharge: 0 },
          { id: "atom_002", element: "C", x: 148, y: 100, formalCharge: 0 },
          { id: "atom_003", element: "O", x: 100, y: 148, formalCharge: 0 }
        ],
        bonds: [
          { id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single", display: { bondStyle: "wedge" } },
          { id: "bond_002", fromAtomId: "atom_001", toAtomId: "atom_003", order: "single", display: { bondStyle: "hashed" } }
        ]
      }
    ]);
    const result = exportDocumentToCdxml(document, { creationProgram: "Stereo Export Test" });

    expect(result.warnings).toEqual([]);
    expect(result.contents).toContain('Display="WedgeBegin"');
    expect(result.contents).toContain('Display="WedgedHashBegin"');
    expect(result.contents).not.toContain('Display="wedge"');
  });

  it("imports synthetic reciprocal CrossingBonds as native page crossing overrides", () => {
    const opened = openChemDraftPayload(cdxmlFixture("crossing-bonds.cdxml"));

    expect(opened.document?.pages[0].objects.map((object) => object.type)).toEqual([
      "molecule",
      "molecule",
      "graphic",
      "unknown-compatibility-object"
    ]);
    expect(opened.document?.pages[0].crossings).toEqual([{
      bonds: [
        { objectId: "cdxml_molecule_1_1", bondId: "bond_001" },
        { objectId: "cdxml_molecule_1_2", bondId: "bond_001" }
      ],
      front: { objectId: "cdxml_molecule_1_2", bondId: "bond_001" }
    }]);
    expect(opened.warnings.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "cdxml.object_import_unsupported"
      ])
    );
    expect(opened.warnings.map((item) => item.code)).not.toContain("cdxml.bond_display_unsupported");
  });

  it("keeps a BactVue-style visible subset fixture for integrated CDXML interop checks", () => {
    const opened = openChemDraftPayload(cdxmlFixture("bactvue-visible-subset.cdxml"));

    expect(opened.document?.pages[0].objects.map((object) => object.type)).toEqual([
      "text",
      "reaction-arrow",
      "molecule",
      "molecule",
      "molecule",
      "graphic",
      "unknown-compatibility-object"
    ]);
    expect((opened.document?.pages[0].objects[0] as TextObject | undefined)?.text).toBe("DIPEA, DMSO");
    expect((opened.document?.pages[0].objects[1] as ArrowObject | undefined)?.type).toBe("reaction-arrow");
    expect(opened.warnings.map((item) => item.code)).not.toContain("cdxml.bond_display_unsupported");
    expect(opened.warnings.map((item) => item.code)).toContain("cdxml.object_import_unsupported");
  });

  it("exports native crossing overrides as visible reciprocal CrossingBonds and coherent Z values", () => {
    const back = {
      ...singleBondMolecule(),
      id: "mol_back",
      atoms: [
        { id: "atom_001", element: "C", x: 100, y: 100, formalCharge: 0 },
        { id: "atom_002", element: "C", x: 180, y: 180, formalCharge: 0 }
      ]
    };
    const front = {
      ...singleBondMolecule(),
      id: "mol_front",
      atoms: [
        { id: "atom_001", element: "C", x: 180, y: 100, formalCharge: 0 },
        { id: "atom_002", element: "C", x: 100, y: 180, formalCharge: 0 }
      ]
    };
    const base = documentWithObjects([back, front]);
    const document = ChemDraftDocumentSchema.parse({
      ...base,
      pages: [{
        ...base.pages[0],
        crossings: [{
          bonds: [
            { objectId: "mol_back", bondId: "bond_001" },
            { objectId: "mol_front", bondId: "bond_001" }
          ],
          front: { objectId: "mol_front", bondId: "bond_001" }
        }]
      }]
    });
    const exported = exportDocumentToCdxml(document, { creationProgram: "Crossing Export Test" });

    expect(exported.contents).toContain("CrossingBonds=");
    expect(exported.contents).toContain('Z="1"');
    expect(exported.contents).toContain('Z="2"');
    expect(exported.contents).not.toContain("native-crossing-hit-target");
    expect(openChemDraftPayload(exported.contents).document?.pages[0].crossings).toEqual(document.pages[0].crossings);
  });

  it("imports synthetic text, plus text, molecule, and reaction arrow fixtures", () => {
    const textPlusMolecule = openChemDraftPayload(cdxmlFixture("text-plus-molecule.cdxml"));
    const reactionArrow = openChemDraftPayload(cdxmlFixture("reaction-arrow.cdxml"));

    expect(textPlusMolecule.document?.pages[0].objects.map((object) => object.type)).toEqual([
      "text",
      "text",
      "molecule"
    ]);
    expect((textPlusMolecule.document?.pages[0].objects[0] as TextObject | undefined)?.text).toBe("  reagent & label  ");
    expect((textPlusMolecule.document?.pages[0].objects[1] as TextObject | undefined)?.text).toBe("+");
    expect((reactionArrow.document?.pages[0].objects[0] as ArrowObject | undefined)?.type).toBe("reaction-arrow");
  });

  it("round-trips a resonance reaction arrow through CDXML", () => {
    const document = documentWithObjects([
      {
        id: "arrow_res",
        type: "reaction-arrow",
        x: 100,
        y: 88,
        width: 120,
        height: 24,
        rotation: 0,
        style: {},
        arrowKind: "resonance",
        start: { kind: "point", point: { x: 100, y: 100 } },
        end: { kind: "point", point: { x: 220, y: 100 } },
        labels: []
      }
    ]);
    const exported = exportDocumentToCdxml(document, { creationProgram: "Resonance Arrow Test" });

    expect(exported.contents).toContain('ArrowType="resonance"');
    const reopened = openChemDraftPayload(exported.contents);
    const arrow = reopened.document?.pages[0].objects.find(
      (object): object is ArrowObject => object.type === "reaction-arrow"
    );
    expect(arrow?.arrowKind).toBe("resonance");
    expect(arrow?.start).toEqual({ kind: "point", point: { x: 100, y: 100 } });
    expect(arrow?.end).toEqual({ kind: "point", point: { x: 220, y: 100 } });
  });

  it("preserves unsupported synthetic CDXML objects as unknown compatibility objects", () => {
    const opened = openChemDraftPayload(cdxmlFixture("unsupported-step.cdxml"));

    expect(opened.document?.pages[0].objects[0]).toMatchObject({
      type: "unknown-compatibility-object",
      sourceFormat: "cdxml",
      sourceObjectType: "step"
    });
    expect(opened.warnings.map((item) => item.code)).toContain("cdxml.object_import_unsupported");
  });
});

function documentWithObjects(objects: ChemDraftDocument["pages"][number]["objects"]): ChemDraftDocument {
  const base = createEmptyDocument({ title: "Round Trip", now: "2026-06-06T00:00:00.000Z" });
  return ChemDraftDocumentSchema.parse({
    ...base,
    pages: [
      {
        ...base.pages[0],
        objects
      }
    ],
    selection: {
      objectIds: objects.length > 0 ? [objects[0].id] : []
    }
  });
}

function singleBondMolecule(): MoleculeObject {
  return {
    id: "mol_001",
    type: "molecule",
    x: 92,
    y: 92,
    width: 72,
    height: 16,
    rotation: 0,
    style: {},
    structureFormat: "smiles",
    structure: "CO",
    atoms: [
      { id: "atom_001", element: "C", x: 100, y: 100, formalCharge: 0 },
      { id: "atom_002", element: "O", x: 148, y: 100, formalCharge: 0 }
    ],
    bonds: [{ id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" }],
    superatoms: [],
    rGroups: []
  };
}

function extractObjectTag(contents: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tagMatch = contents.match(new RegExp(`<objecttag[^>]*Name="${escapedName}"[^>]*(?:/>|>.*?</objecttag>)`, "s"));
  const valueMatch = tagMatch?.[0].match(/\sValue="([^"]*)"/);
  if (valueMatch) {
    return valueMatch[1];
  }
  const match = tagMatch?.[0].match(/>(.*?)<\/objecttag>/s);
  if (!match) {
    throw new Error(`Missing objecttag ${name}`);
  }
  return match[1];
}

function replaceObjectTag(contents: string, name: string, value: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return contents.replace(new RegExp(`(<objecttag[^>]*Name="${escapedName}"[^>]*Value=")[^"]*(")`, "s"), `$1${value}$2`);
}

function cdxmlFixture(name: string): string {
  const fixture = cdxmlFixtures[name];
  if (!fixture) {
    throw new Error(`Missing CDXML fixture ${name}`);
  }
  return fixture;
}
