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
  CdxmlEnvelopeCodecVersionV1,
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
    expect(result.contents).toContain('p="111 75"');
    expect(canonicalVisibleCdxml(result.contents)).not.toContain("org.chemdraft/native-document");
  });

  it("exports visible CDXML page and atom coordinates in spec order (x then y)", () => {
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

    // A portrait Letter page is 612 wide x 792 tall; "left top right bottom" must say so, or every
    // spec-conforming reader (ChemDraw, RDKit, ChemAxon) sees the page as landscape.
    expect(result.contents).toContain('<page id="page_001" BoundingBox="0 0 612 792">');
    expect(result.contents).toContain('p="130.875 157.6553"');
    expect(result.contents).toContain('p="147.375 157.6553"');
    expect(result.contents).toContain('p="152.8828 173.2089"');
    // The y-first order ChemDraft wrote through codec v1 must not come back.
    expect(result.contents).not.toContain('p="157.6553 130.875"');
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
    expect(result.contents).toContain('ArrowType="FullHead"');
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
    // Centre (51.75, 66.75), r 18.75: angle 0 leaves the centre's y untouched, and a 270-degree
    // sweep lands straight above it — both only true when the pair reads "x y".
    expect(result.contents).toContain('Start="70.5 66.75"');
    expect(result.contents).toContain('End="51.75 48"');
    expect(result.warnings).toEqual([]);
  });

  it("imports CDXML arcs as circular native graphic arcs with radian angles", () => {
    const opened = openChemDraftPayload(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE CDXML SYSTEM "https://static.chemistry.revvitycloud.com/cdxml/CDXML.dtd">
<CDXML CreationProgram="Arc Import Test">
  <page id="20" BoundingBox="0 0 540 720">
    <graphic id="7" BoundingBox="30 45 73.5 88.5" GraphicType="Arc" AngularSize="270" Start="70.5 66.75" End="51.75 48"/>
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

  it("still opens codec-v1 envelopes ChemDraft already wrote", () => {
    // v1 is every .cdxml this app shipped before the coordinate order was corrected. Its embedded
    // payload is native JSON and was always right, so accepting the version is the whole migration:
    // drop v1 from the supported set and every existing document fails to open.
    const document = createEmptyDocument({ now: "2026-06-06T00:00:00.000Z" });
    const molecule = singleBondMolecule();
    const withMolecule: ChemDraftDocument = {
      ...document,
      pages: [{ ...document.pages[0], objects: [molecule] }]
    };
    const exported = exportDocumentToCdxml(withMolecule, { creationProgram: "V1 Compatibility" });
    const asV1 = replaceObjectTag(exported.contents, ChemDraftObjectTags.codecVersion, CdxmlEnvelopeCodecVersionV1);
    const opened = openChemDraftPayload(asV1);

    expect(opened.source).toBe("native-payload");
    expect(opened.warnings.map((item) => item.code)).not.toContain("cdxml.codec_version_unsupported");
    expect(opened.document?.pages[0].objects[0]).toEqual(molecule);
  });

  it("transposes the visible layer of a codec-v1 envelope whose payload is gone", () => {
    // A v1 file stripped of its payload leaves only a visible layer ChemDraft wrote y-first.
    // Reading it with the corrected parsers yields the exact transpose, so swapping back recovers
    // the true geometry: p="75 111" was authored as (x 111, y 75) — a horizontal bond.
    const opened = openChemDraftPayload(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd">
<CDXML CreationProgram="ChemDraft 0.1.0">
  <page id="p1" BoundingBox="0 0 792 612">
    <objecttag Name="${ChemDraftObjectTags.codecVersion}" Persistent="yes" TagType="String" Value="${CdxmlEnvelopeCodecVersionV1}"/>
    <fragment id="f1">
      <n id="a1" p="75 75"/>
      <n id="a2" p="75 111"/>
      <b id="b1" B="a1" E="a2" Order="1"/>
    </fragment>
  </page>
</CDXML>`);
    const molecule = opened.document?.pages[0].objects[0] as MoleculeObject | undefined;

    expect(molecule?.atoms).toHaveLength(2);
    expect(molecule?.atoms[0]?.x).toBeCloseTo(100);
    expect(molecule?.atoms[0]?.y).toBeCloseTo(100);
    expect(molecule?.atoms[1]?.x).toBeCloseTo(148);
    expect(molecule?.atoms[1]?.y).toBeCloseTo(100);
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

  it("imports CDXML p and BoundingBox coordinates in spec order (x then y)", () => {
    // Two fragments stacked vertically at the same x, with a label below both. Written in spec
    // order — "x y" points, "left top right bottom" boxes — so the imported layout must agree.
    const opened = openChemDraftPayload(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd">
<CDXML CreationProgram="ChemDraft Synthetic Fixture">
  <page id="p1" BoundingBox="0 0 540 720">
    <fragment id="top" BoundingBox="100 120 100 156">
      <n id="a1" p="100 120"/>
      <n id="a2" p="100 156"/>
      <b id="b1" B="a1" E="a2" Order="1"/>
    </fragment>
    <fragment id="bottom" BoundingBox="100 320 100 356">
      <n id="a3" p="100 320"/>
      <n id="a4" p="100 356"/>
      <b id="b2" B="a3" E="a4" Order="1"/>
    </fragment>
    <t id="label" p="100 520">vertical stack</t>
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

  it("imports ChemDraw CDXML faithfully — no rotation, no mirror", () => {
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

    // p="100 120" and p="100 156" are (x, y): a vertical bond at x=100, imported at the 4/3 scale.
    expect(molecule?.atoms[0]?.x).toBeCloseTo(133.33333333333334);
    expect(molecule?.atoms[0]?.y).toBeCloseTo(160);
    expect(molecule?.atoms[1]?.x).toBeCloseTo(133.33333333333334);
    expect(molecule?.atoms[1]?.y).toBeCloseTo(208);
    // The Cl label box "94 112 102 124" centres at (98, 118), up-and-LEFT of its atom at (100, 120).
    // The old CCW-90 compensation turned that into +x — the mirror, baked into the expectation.
    expect(molecule?.atoms[0]?.labelOffset?.x).toBeCloseTo(-2.666666666666657);
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
    // A real ChemDraw file: p="157.6553 130.875" is already (x, y), so the import is a plain 4/3
    // scale with no swap. The three round-trip assertions at the end of this test are the proof
    // that the reader and the writer agree on that order.
    expect(molecule?.atoms[0]?.element).toBe("C");
    expect(molecule?.atoms[0]?.x).toBeCloseTo(210.20706666666667);
    expect(molecule?.atoms[0]?.y).toBeCloseTo(174.5);
    expect(molecule?.atoms[5]?.element).toBe("C");
    expect(molecule?.atoms[5]?.x).toBeCloseTo(265.52826666666665);
    expect(molecule?.atoms[5]?.y).toBeCloseTo(216.0896);
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

    // Orientation pin: a1 p="100 100" and a2 p="136 100" share a y and run left-to-right. The
    // inward check below is mirror-invariant on its own, so the hexagon's pose is asserted here.
    expect(molecule?.atoms[0]?.y).toBeCloseTo(molecule?.atoms[1]?.y ?? Number.NaN);
    expect(molecule?.atoms[1]?.x).toBeGreaterThan(molecule?.atoms[0]?.x ?? Number.NaN);
    expect(molecule?.bonds[0].order).toBe("double");
    expect(molecule?.bonds[2].order).toBe("double");
    expectRingDoubleBondsPointInward(molecule);
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

    expect(molecule?.bonds[0].order).toBe("double");
    expect(molecule?.bonds[2].order).toBe("double");
    expectRingDoubleBondsPointInward(molecule);
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
      "graphic",
      "molecule",
      "molecule",
      "molecule",
      "graphic",
      "unknown-compatibility-object"
    ]);
    expect((opened.document?.pages[0].objects[0] as TextObject | undefined)?.text).toBe("DIPEA, DMSO");
    // The FullHead reaction arrow imports as an editable art arrow tagged with its chemical identity.
    expect((opened.document?.pages[0].objects[1] as GraphicObject | undefined)?.data.artToolId).toBe("reactionArrow");
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
    // A reaction (FullHead) arrow imports as an editable art arrow carrying its chemical identity.
    expect((reactionArrow.document?.pages[0].objects[0] as GraphicObject | undefined)?.data.artToolId).toBe("reactionArrow");
  });

  it("warns when brackets and curved art degrade on the way to CDXML", () => {
    const bracket = exportDocumentToCdxml(documentWithObjects([
      {
        id: "bracket_001",
        type: "bracket",
        x: 144, y: 126, width: 16, height: 64, rotation: 0, style: {},
        bracketKind: "curly",
        containedObjectIds: []
      }
    ]), { creationProgram: "T" });

    // The bracket still exports as a placeholder, but no longer silently.
    expect(bracket.contents).toContain('GraphicType="Unknown"');
    expect(bracket.warnings.map((warning) => warning.code)).toContain("cdxml.bracket_payload_only");

    const orbital = exportDocumentToCdxml(documentWithObjects([
      {
        id: "graphic_lobe",
        type: "graphic",
        x: 100, y: 100, width: 40, height: 60, rotation: 0,
        style: { strokeColor: "#000000", fillColor: "none" },
        graphicKind: "path",
        data: {
          artPathKind: "bezier",
          pathClosed: true,
          pathNodes: [
            { point: { x: 20, y: 56 } },
            { point: { x: 6, y: 16 } },
            { point: { x: 34, y: 16 } }
          ]
        }
      }
    ]), { creationProgram: "T" });

    // Bezier curves carry an artPathKind, so the older pathD-only check never fired for them.
    expect(orbital.contents).toContain('GraphicType="Unknown"');
    expect(orbital.warnings.map((warning) => warning.code)).toContain("cdxml.graphic_shape_payload_only");

    // A shape CDXML can represent stays quiet.
    const oval = exportDocumentToCdxml(documentWithObjects([
      {
        id: "graphic_oval",
        type: "graphic",
        x: 100, y: 100, width: 48, height: 48, rotation: 0,
        style: { strokeColor: "#000000" },
        graphicKind: "ellipse",
        data: {}
      }
    ]), { creationProgram: "T" });
    expect(oval.contents).toContain('GraphicType="Oval"');
    expect(oval.warnings.map((warning) => warning.code)).not.toContain("cdxml.graphic_shape_payload_only");
  });

  it("imports semantic reaction arrows with a frame that matches their endpoints", () => {
    // CDXRectangle is "left top right bottom" and CDXPoint2D is "x y". Reading either transposed
    // detaches the frame from the line: the arrow still draws between its endpoints, but selection
    // and transform geometry describe the mirrored shape. Assert the frame spans the endpoints.
    const arrowCdxml = (arrowType: string, horizontal: boolean) => {
      const box = horizontal ? "120 120 216 120" : "120 120 120 216";
      const start = "120 120";
      const end = horizontal ? "216 120" : "120 216";
      return `<?xml version="1.0" encoding="UTF-8"?>
<CDXML CreationProgram="Arrow Frame Test">
  <page id="1" BoundingBox="0 0 540 720">
    <graphic id="a1" GraphicType="Line" ArrowType="${arrowType}" BoundingBox="${box}" Start="${start}" End="${end}"/>
  </page>
</CDXML>`;
    };

    for (const arrowType of ["FullHead", "Resonance", "Equilibrium", "RetroSynthetic"]) {
      const horizontal = openChemDraftPayload(arrowCdxml(arrowType, true)).document?.pages[0].objects[0] as GraphicObject;
      expect(horizontal.width, `${arrowType} horizontal width`).toBeGreaterThan(horizontal.height);
      // The frame must span the endpoints it drew between, not their transpose.
      expect(horizontal.width).toBeCloseTo(Math.abs((horizontal.data.lineEnd?.x ?? 0) - (horizontal.data.lineStart?.x ?? 0)), 6);

      const vertical = openChemDraftPayload(arrowCdxml(arrowType, false)).document?.pages[0].objects[0] as GraphicObject;
      expect(vertical.height, `${arrowType} vertical height`).toBeGreaterThan(vertical.width);
      expect(vertical.height).toBeCloseTo(Math.abs((vertical.data.lineEnd?.y ?? 0) - (vertical.data.lineStart?.y ?? 0)), 6);
    }
  });

  it("imports a half-headed arrow as a fishhook, and says so", () => {
    // A single-barbed arrow moves ONE electron; a full head moves two. Importing HalfHead as a
    // reaction arrow asserted the wrong chemistry, and a re-export then wrote ArrowType="FullHead"
    // — laundering it with nothing said. The native fishhook head is the honest mapping, and the
    // handedness that native fishhooks do not carry is reported rather than silently dropped.
    const opened = openChemDraftPayload(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd">
<CDXML CreationProgram="Half Head Import Test">
  <page id="p1" BoundingBox="0 0 540 720">
    <graphic id="a1" GraphicType="Line" ArrowType="HalfHead" BoundingBox="120 120 216 120" Start="120 120" End="216 120"/>
  </page>
</CDXML>`);
    const arrow = opened.document?.pages[0].objects[0] as GraphicObject | undefined;

    expect(arrow?.data.artToolId).toBe("fishhookArrow");
    expect(arrow?.data.markerEnd).toMatchObject({ kind: "half-arrow" });
    expect(opened.warnings.map((item) => item.code)).toContain("cdxml.half_head_arrow_import_approximation");

    // And it must not be re-emitted as a full-headed reaction arrow.
    const exported = exportDocumentToCdxml(opened.document!);
    expect(exported.contents).not.toContain('ArrowType="FullHead"');
  });

  it("round-trips a half-headed arrow back out as ArrowType=\"HalfHead\"", () => {
    // Importing honestly is only half the job: exporting the fishhook as a plain line still loses
    // the arrow's chemical identity, so a ChemDraw file opened and re-saved came back as a
    // decorative stroke. HalfHead is a real CDXML spelling and the fishhook is exactly what it
    // means, so the pair must survive a full lap.
    const source = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd">
<CDXML CreationProgram="Half Head Round Trip">
  <page id="p1" BoundingBox="0 0 540 720">
    <graphic id="a1" GraphicType="Line" ArrowType="HalfHead" BoundingBox="120 120 216 120" Start="120 120" End="216 120"/>
  </page>
</CDXML>`;
    const opened = openChemDraftPayload(source);
    const exported = exportDocumentToCdxml(opened.document!);

    // The visible layer must say HalfHead — not FullHead (wrong chemistry) and not a bare line
    // (no chemistry). Check the visible <graphic>, since the embedded payload is JSON.
    const visibleGraphic = exported.contents
      .split("\n")
      .find((line) => line.includes("<graphic ") && line.includes("GraphicType=\"Line\""));
    expect(visibleGraphic).toBeDefined();
    expect(visibleGraphic).toContain('ArrowType="HalfHead"');

    // Reopening the export must land on the same fishhook, not drift a second time.
    const reopened = openChemDraftPayload(exported.contents);
    const arrow = reopened.document?.pages[0].objects[0] as GraphicObject | undefined;
    expect(arrow?.data.artToolId).toBe("fishhookArrow");
    expect(arrow?.data.markerEnd).toMatchObject({ kind: "half-arrow" });
  });

  it("reads a ChemDraw <arrow> frame consistently with its unambiguous 3D endpoints", () => {
    // Head3D/Tail3D are "x y z" in every CDX dialect, so they pin the arrow's true direction with
    // no convention to argue about. A real ChemDraw 26 document was inspected to settle this: its
    // arrow's BoundingBox agreed with its Head3D/Tail3D only when read left-top-right-bottom, and
    // its page box read portrait only when read x-first. This fixture is hand-authored to carry
    // the same discriminating shape — a horizontal arrow inside a thin band centred on its axis.
    const opened = openChemDraftPayload(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd">
<CDXML CreationProgram="ChemDraw Shaped Fixture">
  <page id="33" BoundingBox="0 0 540 720">
    <arrow id="34" BoundingBox="200 296 320 304" ArrowheadHead="Full" ArrowheadType="Solid" Head3D="320 300 0" Tail3D="200 300 0"/>
    <graphic id="35" GraphicType="Rectangle" BoundingBox="200 296 320 304"/>
  </page>
</CDXML>`);
    const arrow = opened.document?.pages[0].objects[0] as GraphicObject | undefined;
    const rectangle = opened.document?.pages[0].objects[1] as GraphicObject | undefined;

    // The arrow's frame is derived from Head3D/Tail3D: tail (200, 300) -> head (320, 300), so it
    // must import horizontal and 120 units long at the 4/3 scale.
    expect(arrow).toBeDefined();
    expect(arrow!.data.lineStart?.y).toBeCloseTo(arrow!.data.lineEnd?.y ?? Number.NaN, 6);
    expect((arrow!.data.lineEnd?.x ?? 0) - (arrow!.data.lineStart?.x ?? 0)).toBeCloseTo(120 * (4 / 3), 6);
    expect(arrow!.width).toBeGreaterThan(arrow!.height);

    // The rectangle's frame comes only from the BoundingBox, so it is what pins the box order:
    // "200 296 320 304" is a 120x8 band read left-top-right-bottom, and a 8x120 one transposed.
    expect(rectangle).toBeDefined();
    expect(rectangle!.width).toBeCloseTo(120 * (4 / 3), 6);
    expect(rectangle!.height).toBeCloseTo(8 * (4 / 3), 6);
    expect(rectangle!.x).toBeCloseTo(200 * (4 / 3), 6);
    expect(rectangle!.y).toBeCloseTo(296 * (4 / 3), 6);
  });

  it("reads a standalone <arrow>'s heads from ArrowheadHead/ArrowheadTail and writes them back", () => {
    // A standalone <arrow> carries neither GraphicType nor ArrowType, so keying the arrowhead off
    // those — the reaction-arrow spelling — dropped the head from every arrow ChemDraw writes: a
    // solid-headed arrow imported as a bare line. An <arrow>'s heads live in ArrowheadHead and
    // ArrowheadTail (which ends are headed) crossed with ArrowheadType (how they are drawn).
    const opened = openChemDraftPayload(cdxmlFixture("arrow-heads.cdxml"));
    const [solid, angle, half, doubleEnded, headless] = (opened.document?.pages[0].objects ?? []) as GraphicObject[];

    expect(solid.data.markerEnd).toEqual({ kind: "filled-arrow", sizePx: 16 });
    expect(solid.data.markerStart).toBeUndefined();
    expect(angle.data.markerEnd).toEqual({ kind: "open-arrow", sizePx: 16 });
    expect(half.data.markerEnd).toEqual({ kind: "half-arrow", sizePx: 14 });
    expect(doubleEnded.data.markerEnd).toEqual({ kind: "filled-arrow", sizePx: 16 });
    expect(doubleEnded.data.markerStart).toEqual({ kind: "filled-arrow", sizePx: 16 });

    // ArrowheadType with no ArrowheadHead is how ChemDraw writes a plain line arrow, so the type
    // alone must not conjure a head.
    expect(headless.data.markerEnd).toBeUndefined();
    expect(headless.data.markerStart).toBeUndefined();

    const exported = exportDocumentToCdxml(opened.document ?? documentWithObjects([]), {
      creationProgram: "Arrowhead Round Trip Test"
    });
    expect(exported.warnings).toEqual([]);
    expect(exported.contents).toContain('ArrowheadHead="Full" ArrowheadType="Solid"');
    expect(exported.contents).toContain('ArrowheadHead="Full" ArrowheadType="Angle"');
    expect(exported.contents).toContain('ArrowheadHead="HalfLeft" ArrowheadType="Solid"');
    expect(exported.contents).toContain('ArrowheadHead="Full" ArrowheadTail="Full" ArrowheadType="Solid"');

    // Close the loop through the reader — the writer's own arrows, read back as a foreign document,
    // must carry the same heads. Reopening the exported envelope would only prove the embedded
    // native payload survived, which says nothing about the visible layer other programs see.
    const arrows = exported.contents.match(/<arrow [^>]*\/>/g) ?? [];
    expect(arrows).toHaveLength(5);
    const reopened = openChemDraftPayload(`<?xml version="1.0" encoding="UTF-8"?>
<CDXML CreationProgram="Arrowhead Round Trip Test">
  <page id="p1" BoundingBox="0 0 612 792">
    ${arrows.join("\n    ")}
  </page>
</CDXML>`);
    const reopenedHeads = (reopened.document?.pages[0].objects ?? [])
      .map((object) => (object as GraphicObject).data.markerEnd?.kind);
    expect(reopenedHeads).toEqual(["filled-arrow", "open-arrow", "half-arrow", "filled-arrow", undefined]);
  });

  it("warns instead of inventing a CDXML spelling for decorative arrowheads", () => {
    // CDXML's arrowhead enum is full/half/unfilled and nothing else, so a dot or diamond head has no
    // spelling. Exporting it as a full head would claim the user drew something they didn't.
    const decorated = (kind: GraphicObject["data"]["markerEnd"]): ChemDraftDocument => documentWithObjects([
      {
        id: "art_decorated",
        type: "graphic",
        x: 100, y: 158, width: 120, height: 4, rotation: 0,
        style: { strokeColor: "#000000", strokeWidth: 2 },
        graphicKind: "line",
        data: { artPathKind: "line", lineStart: { x: 100, y: 160 }, lineEnd: { x: 220, y: 160 }, markerEnd: kind },
        compatibility: { sourceFormat: "cdxml", warnings: [], unknown: { cdxmlElementName: "arrow" } }
      } satisfies GraphicObject
    ]);

    const diamond = exportDocumentToCdxml(decorated({ kind: "diamond", sizePx: 16 }), { creationProgram: "T" });
    expect(diamond.warnings.map((warning) => warning.code)).toContain("cdxml.arrow_marker_payload_only");
    expect(diamond.contents).not.toContain("ArrowheadHead=");

    // An explicitly removed head is a faithful export, not a loss.
    const bare = exportDocumentToCdxml(decorated({ kind: "none" }), { creationProgram: "T" });
    expect(bare.warnings).toEqual([]);
  });

  it("keeps colour, dash, and head-loss warnings on semantic arrow export", () => {
    const arrow = (style: GraphicObject["style"], data: GraphicObject["data"]): ChemDraftDocument =>
      documentWithObjects([
        {
          id: "art_semantic",
          type: "graphic",
          x: 100, y: 88, width: 120, height: 24, rotation: 0,
          style,
          graphicKind: "path",
          data: { artPathKind: "line", artToolId: "reactionArrow", ...data }
        } satisfies GraphicObject
      ]);

    // Dash and colour reach standard CDXML instead of silently reopening as default solid black.
    const dashed = exportDocumentToCdxml(
      arrow({ strokeColor: "#ff0000", strokeWidth: 2, strokeDasharray: "6 6" }, { markerEnd: { kind: "filled-arrow", sizePx: 16 } }),
      { creationProgram: "T" }
    );
    expect(dashed.contents).toContain('LineType="Dashed"');
    expect(dashed.contents).toMatch(/<graphic[^>]*ArrowType="FullHead"[^>]*color="/);

    // A removed head cannot be said in standard CDXML — that must warn rather than export a lie.
    const headless = exportDocumentToCdxml(
      arrow({ strokeColor: "#000000", strokeWidth: 2 }, {}),
      { creationProgram: "T" }
    );
    expect(headless.warnings.map((warning) => warning.code)).toContain("cdxml.arrow_head_payload_only");

    // The ordinary case still exports clean.
    const plain = exportDocumentToCdxml(
      arrow({ strokeColor: "#000000", strokeWidth: 2 }, { markerEnd: { kind: "filled-arrow", sizePx: 16 } }),
      { creationProgram: "T" }
    );
    expect(plain.warnings.map((warning) => warning.code)).not.toContain("cdxml.arrow_head_payload_only");
  });

  it("writes real CDXML ArrowType spellings and reads foreign and legacy ones", () => {
    // The previous test asserted our own lowercase output against our own reader, so it passed
    // while real CDXML imported as "unknown". Assert the wire spellings directly.
    const arrowAt = (arrowKind: ArrowObject["arrowKind"]) => documentWithObjects([
      {
        id: "arrow_wire",
        type: "reaction-arrow",
        x: 100, y: 88, width: 120, height: 24, rotation: 0, style: {},
        arrowKind,
        start: { kind: "point", point: { x: 100, y: 100 } },
        end: { kind: "point", point: { x: 220, y: 100 } },
        labels: []
      }
    ]);

    expect(exportDocumentToCdxml(arrowAt("forward"), { creationProgram: "T" }).contents)
      .toContain('ArrowType="FullHead"');
    expect(exportDocumentToCdxml(arrowAt("resonance"), { creationProgram: "T" }).contents)
      .toContain('ArrowType="Resonance"');
    expect(exportDocumentToCdxml(arrowAt("equilibrium"), { creationProgram: "T" }).contents)
      .toContain('ArrowType="Equilibrium"');
    expect(exportDocumentToCdxml(arrowAt("retrosynthesis"), { creationProgram: "T" }).contents)
      .toContain('ArrowType="RetroSynthetic"');

    // Foreign CDXML — the spellings another program writes. `bactvue-visible-subset` is a real
    // third-party fixture already carrying ArrowType="FullHead"; substituting into it keeps the
    // reader on genuinely foreign input rather than on our own output.
    // The imported semantic arrow kind, regardless of representation: every named arrow kind now
    // arrive as tagged art arrows (graphic + artToolId), unknown as a legacy reaction-arrow object.
    const ART_ARROW_KINDS: Readonly<Record<string, ArrowObject["arrowKind"]>> = {
      reactionArrow: "forward",
      resonanceArrow: "resonance",
      equilibriumArrow: "equilibrium",
      retroArrow: "retrosynthesis"
    };
    const foreign = (arrowType: string) => {
      const cdxml = cdxmlFixture("bactvue-visible-subset.cdxml")
        .replace('ArrowType="FullHead"', `ArrowType="${arrowType}"`);
      const objects = openChemDraftPayload(cdxml).document?.pages[0].objects ?? [];
      const artArrow = objects.find(
        (object): object is GraphicObject =>
          object.type === "graphic" &&
          typeof object.data.artToolId === "string" &&
          object.data.artToolId in ART_ARROW_KINDS
      );
      if (artArrow) {
        return ART_ARROW_KINDS[artArrow.data.artToolId as string];
      }
      return objects.find((object): object is ArrowObject => object.type === "reaction-arrow")?.arrowKind;
    };

    expect(foreign("FullHead")).toBe("forward");
    // HalfHead is a single-barbed fishhook — one electron, not two — so it deliberately does NOT
    // land on "forward" any more. It has its own assertion below.
    expect(foreign("HalfHead")).toBeUndefined();
    expect(foreign("Resonance")).toBe("resonance");
    expect(foreign("Equilibrium")).toBe("equilibrium");
    expect(foreign("RetroSynthetic")).toBe("retrosynthesis");
    // Legacy ChemDraft output still reads, so documents this app already wrote survive.
    expect(foreign("forward")).toBe("forward");
    expect(foreign("retrosynthesis")).toBe("retrosynthesis");
    expect(foreign("Nonsense")).toBe("unknown");

    // An arrow whose type this build did not recognize on the way in must not acquire one on the
    // way out. Writing FullHead would turn "we could not tell" into a positive claim that the arrow
    // is a plain forward reaction arrow — and that claim survives every later round trip.
    const degraded = exportDocumentToCdxml(arrowAt("unknown"), { creationProgram: "T" });
    expect(degraded.contents).toContain('GraphicType="Line"');
    expect(degraded.contents).not.toContain("ArrowType=");
    expect(degraded.warnings.map((warning) => warning.code)).toContain("cdxml.arrow_type_unknown");
  });

  it("exports reaction/resonance art arrows as standard CDXML reaction arrows (interop half of the round trip)", () => {
    const marker = { kind: "filled-arrow" as const, sizePx: 10 };
    const artArrow = (artToolId: "reactionArrow" | "resonanceArrow", double: boolean): GraphicObject => ({
      id: `art_${artToolId}`,
      type: "graphic",
      x: 100,
      y: 158,
      width: 120,
      height: 4,
      rotation: 0,
      style: { strokeColor: "#111111", fillColor: "none", strokeWidth: 2, strokeLineCap: "butt" },
      graphicKind: "path",
      data: {
        artPathKind: "line",
        lineStart: { x: 100, y: 160 },
        lineEnd: { x: 220, y: 160 },
        markerEnd: marker,
        ...(double ? { markerStart: marker } : {}),
        artToolId
      }
    });

    // A reaction/resonance art arrow (rich editable object) emits the STANDARD reaction-arrow CDXML so
    // other programs read it as a reaction arrow — not as a generic <graphic>/<arrow>.
    const reactionCdxml = exportDocumentToCdxml(
      documentWithObjects([artArrow("reactionArrow", false)]),
      { creationProgram: "T" }
    ).contents;
    expect(reactionCdxml).toContain('GraphicType="Line"');
    expect(reactionCdxml).toContain('ArrowType="FullHead"');

    const resonanceCdxml = exportDocumentToCdxml(
      documentWithObjects([artArrow("resonanceArrow", true)]),
      { creationProgram: "T" }
    ).contents;
    expect(resonanceCdxml).toContain('ArrowType="Resonance"');
  });

  it("exports the preconfigured bold/dashed reaction arrow variants as forward reaction arrows", () => {
    const variantArrow = (artToolId: string, sizePx: number): GraphicObject => ({
      id: `art_${artToolId}`,
      type: "graphic",
      x: 100,
      y: 158,
      width: 120,
      height: 4,
      rotation: 0,
      style: { strokeColor: "#111111", fillColor: "none", strokeWidth: 2, strokeLineCap: "butt" },
      graphicKind: "path",
      data: {
        artPathKind: "line",
        lineStart: { x: 100, y: 160 },
        lineEnd: { x: 220, y: 160 },
        markerEnd: { kind: "filled-arrow", sizePx },
        artToolId
      }
    });

    for (const artToolId of ["reactionArrowBold", "reactionArrowDashed"]) {
      const cdxml = exportDocumentToCdxml(
        documentWithObjects([variantArrow(artToolId, artToolId === "reactionArrowBold" ? 24 : 16)]),
        { creationProgram: "T" }
      ).contents;
      expect(cdxml).toContain('GraphicType="Line"');
      expect(cdxml).toContain('ArrowType="FullHead"');
    }

    // A fishhook DOES have a standard spelling — HalfHead — and it is different chemistry from
    // FullHead, so it must be named rather than flattened to a generic graphic.
    const fishhookCdxml = exportDocumentToCdxml(
      documentWithObjects([{
        ...variantArrow("fishhookArrow", 16),
        data: {
          ...variantArrow("fishhookArrow", 16).data,
          markerEnd: { kind: "half-arrow", sizePx: 16 }
        }
      }]),
      { creationProgram: "T" }
    ).contents;
    expect(fishhookCdxml).toContain('ArrowType="HalfHead"');
    expect(fishhookCdxml).not.toContain('ArrowType="FullHead"');

    // A no-reaction arrow really has no CDXML equivalent — its crossed shaft is not in the
    // ArrowType enum at all — so it stays a generic graphic and round-trips via the payload.
    const noReactionCdxml = exportDocumentToCdxml(
      documentWithObjects([variantArrow("noReactionArrow", 16)]),
      { creationProgram: "T" }
    ).contents;
    expect(noReactionCdxml).not.toContain("ArrowType=");

    // Curved fishhooks stay graphics too: this exporter writes a Start/End pair, so naming one
    // would trade its curvature — the point of a curved pushing arrow — for a label.
    const curvedFishhookCdxml = exportDocumentToCdxml(
      documentWithObjects([variantArrow("fishhookCurved", 16)]),
      { creationProgram: "T" }
    ).contents;
    expect(curvedFishhookCdxml).not.toContain("ArrowType=");
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

    expect(exported.contents).toContain('ArrowType="Resonance"');
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

/**
 * Asserts every double bond in a single-ring molecule carries its secondary line toward the ring
 * interior, derived from the imported coordinates rather than a hard-coded "left"/"right". The
 * normal and the sign convention mirror `doubleBondSideTowardRingInterior` in the layout engine:
 * normal = (-dy, dx)/len, and "left" offsets toward +normal.
 */
function expectRingDoubleBondsPointInward(molecule: MoleculeObject | undefined): void {
  expect(molecule).toBeDefined();
  const atoms = molecule!.atoms;
  const centroidX = atoms.reduce((sum, atom) => sum + atom.x, 0) / atoms.length;
  const centroidY = atoms.reduce((sum, atom) => sum + atom.y, 0) / atoms.length;
  const atomById = new Map(atoms.map((atom) => [atom.id, atom]));
  const doubleBonds = molecule!.bonds.filter((bond) => bond.order === "double");
  expect(doubleBonds.length).toBeGreaterThan(0);
  for (const bond of doubleBonds) {
    const from = atomById.get(bond.fromAtomId);
    const to = atomById.get(bond.toAtomId);
    expect(from).toBeDefined();
    expect(to).toBeDefined();
    const dx = to!.x - from!.x;
    const dy = to!.y - from!.y;
    const length = Math.hypot(dx, dy);
    const dot =
      (centroidX - (from!.x + to!.x) / 2) * (-dy / length) +
      (centroidY - (from!.y + to!.y) / 2) * (dx / length);
    expect(Math.abs(dot)).toBeGreaterThan(1e-9);
    expect({ bond: bond.id, side: bond.display?.doubleBondSide }).toEqual({
      bond: bond.id,
      side: dot > 0 ? "left" : "right"
    });
  }
}

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
