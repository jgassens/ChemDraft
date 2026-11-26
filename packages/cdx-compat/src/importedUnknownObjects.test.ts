import { describe, expect, it } from "vitest";
import type { ChemDraftDocument, DocumentObject, GraphicObject, UnknownCompatibilityObject } from "@chemdraft/chem-core";
import { cdxmlFixtures } from "@chemdraft/fixtures";
import { cdxmlToCssPx } from "./coordinates";
import { readCdx, type CdxElement } from "./cdxBinary";
import { CdxmlEnvelopeCodecVersionV1, ChemDraftObjectTags, exportDocumentToCdx, exportDocumentToCdxml, importCdx, openChemDraftPayload, type ChemDraftOpenResult } from "./index";

function requireDocument(result: ChemDraftOpenResult): ChemDraftDocument {
  expect(result.document, JSON.stringify(result.warnings)).toBeDefined();
  return result.document!;
}

/** CDXML "left top right bottom" in points, as the page-space frame the importer should produce. */
function frame(left: number, top: number, right: number, bottom: number) {
  return { x: cdxmlToCssPx(left), y: cdxmlToCssPx(top), width: cdxmlToCssPx(right - left), height: cdxmlToCssPx(bottom - top) };
}

function frameOf(object: DocumentObject) {
  return { x: object.x, y: object.y, width: object.width, height: object.height };
}

// Group members stay flat on the page; a group lists them by id in childObjectIds.
function allObjects(objects: readonly DocumentObject[]): DocumentObject[] {
  return [...objects];
}

function unknownBySourceId(document: ChemDraftDocument, id: string): UnknownCompatibilityObject {
  const found = allObjects(document.pages[0].objects).find((object): object is UnknownCompatibilityObject =>
    object.type === "unknown-compatibility-object" && object.compatibility?.originalId === id);
  expect(found, `unknown object for source id ${id}`).toBeDefined();
  return found!;
}

function graphicBySourceId(document: ChemDraftDocument, id: string): GraphicObject {
  const found = allObjects(document.pages[0].objects).find((object): object is GraphicObject =>
    object.type === "graphic" && object.compatibility?.originalId === id);
  expect(found, `graphic for source id ${id}`).toBeDefined();
  return found!;
}

describe("unrecognised CDXML elements keep their source position", () => {
  const source = cdxmlFixtures["unknown-objects-in-group.cdxml"];

  it("places each unknown object at its BoundingBox instead of stacking it at the page origin", () => {
    const document = requireDocument(openChemDraftPayload(source));
    const bioshape = unknownBySourceId(document, "bs1");
    const cylinder = unknownBySourceId(document, "bs2");
    const embedded = unknownBySourceId(document, "eo1");
    expect(frameOf(bioshape)).toEqual(frame(300, 240, 360, 320));
    expect(frameOf(cylinder)).toEqual(frame(380, 250, 420, 300));
    expect(frameOf(embedded)).toEqual(frame(430, 260, 470, 290));
    for (const object of [bioshape, cylinder, embedded]) {
      expect(object.x).toBeGreaterThan(0);
      expect(object.y).toBeGreaterThan(0);
    }
  });

  it("keeps the enclosing group's frame on the figure rather than stretching it to the origin", () => {
    const document = requireDocument(openChemDraftPayload(source));
    const group = document.pages[0].objects.find(object => object.type === "group" && object.compatibility?.originalId === "g1");
    expect(group).toBeDefined();
    expect(group!.type === "group" && group!.childObjectIds).toHaveLength(4);
    // Every member lies at or right of x=300 pt and at or below y=240 pt.
    expect(group!.x).toBeGreaterThanOrEqual(cdxmlToCssPx(300) - 1e-6);
    expect(group!.y).toBeGreaterThanOrEqual(cdxmlToCssPx(240) - 1e-6);
    expect(group!.x + group!.width).toBeGreaterThanOrEqual(cdxmlToCssPx(470) - 1e-6);
  });

  it("warns once per unknown element and names it", () => {
    const result = openChemDraftPayload(source);
    const unsupported = result.warnings.filter(warning => warning.code === "cdxml.object_import_unsupported");
    expect(unsupported.map(warning => warning.message)).toEqual([
      'Imported unsupported CDXML object "bioshape" as an unknown compatibility object.',
      'Imported unsupported CDXML object "bioshape" as an unknown compatibility object.',
      'Imported unsupported CDXML object "embeddedobject" as an unknown compatibility object.'
    ]);
  });

  it("preserves the raw source element through a CDXML round trip", () => {
    const document = requireDocument(openChemDraftPayload(source));
    const before = ["bs1", "bs2", "eo1"].map(id => unknownBySourceId(document, id));
    // Unknown objects are not drawn in visible CDXML; the embedded native payload carries them.
    const reopened = requireDocument(openChemDraftPayload(exportDocumentToCdxml(document).contents));
    for (const original of before) {
      const after = unknownBySourceId(reopened, original.compatibility!.originalId!);
      expect(after.raw).toEqual(original.raw);
      expect(after.sourceObjectType).toBe(original.sourceObjectType);
      expect(frameOf(after)).toEqual(frameOf(original));
    }
    expect(before[2].raw).toMatchObject({ name: "embeddedobject", attributes: { id: "eo1", BoundingBox: "430 260 470 290" } });
  });

  it("falls back to p, then to the origin, when there is no usable BoundingBox", () => {
    const document = requireDocument(openChemDraftPayload(`<CDXML><page id="1" BoundingBox="0 0 612 792">
      <bioshape id="70" p="150 160"/>
      <bioshape id="71" BoundingBox="not a box"/>
    </page></CDXML>`));
    const atPoint = unknownBySourceId(document, "70");
    expect({ x: atPoint.x, y: atPoint.y }).toEqual({ x: cdxmlToCssPx(150), y: cdxmlToCssPx(160) });
    const malformed = unknownBySourceId(document, "71");
    expect(frameOf(malformed)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
});

describe("Symbol and Orbital graphics shown as placeholders", () => {
  const source = cdxmlFixtures["curve-type-and-symbols.cdxml"];

  it("warns at import, naming the graphic type", () => {
    const result = openChemDraftPayload(source);
    const placeholders = result.warnings.filter(warning => warning.code === "cdxml.graphic_placeholder");
    expect(placeholders).toHaveLength(2);
    expect(placeholders[0].message).toContain("Symbol");
    expect(placeholders[0].message).toContain("CirclePlus");
    expect(placeholders[0].message).toContain("placeholder");
    expect(placeholders[1].message).toContain("Orbital");
    expect(placeholders[1].message).toContain("placeholder");
  });

  it("does not change how they are represented", () => {
    const document = requireDocument(openChemDraftPayload(source));
    expect(graphicBySourceId(document, "g1").graphicKind).toBe("unknown");
    expect(graphicBySourceId(document, "g2").graphicKind).toBe("unknown");
  });

  it("does not warn for a lone pair, which is imported natively", () => {
    const result = openChemDraftPayload(`<CDXML><page id="1" BoundingBox="0 0 612 792">
      <graphic id="5" GraphicType="Symbol" SymbolType="LonePair" BoundingBox="100 100 104 96"/>
    </page></CDXML>`);
    expect(result.warnings.filter(warning => warning.code === "cdxml.graphic_placeholder")).toEqual([]);
  });
});

describe("legacy CurveType bitfield on <curve>", () => {
  const source = cdxmlFixtures["curve-type-and-symbols.cdxml"];

  it("takes closed and filled from CurveType when Closed and FillType are absent", () => {
    const document = requireDocument(openChemDraftPayload(source));
    const filled = graphicBySourceId(document, "c1");
    expect(filled.data.pathClosed).toBe(true);
    expect(filled.style.fillColor).toBe(filled.style.strokeColor);
    expect(filled.style.fillMode).toBe("solid");
    const closedOnly = graphicBySourceId(document, "c5");
    expect(closedOnly.data.pathClosed).toBe(true);
    expect(closedOnly.style.fillMode).toBeUndefined();
  });

  it("treats the shaded bit as FillType Shaded is treated: solid fill and an approximation warning", () => {
    const result = openChemDraftPayload(source);
    const shaded = graphicBySourceId(requireDocument(result), "c2");
    expect(shaded.data.pathClosed).toBe(true);
    expect(shaded.style.fillMode).toBe("solid");
    const fillWarnings = result.warnings.filter(warning => warning.code === "cdxml.curve_fill_type_approximation");
    expect(fillWarnings).toHaveLength(1);
    expect(fillWarnings[0].message).toContain('"c2"');
    expect(fillWarnings[0].message).toContain("CurveType");
  });

  it("lets explicit Closed and FillType attributes win over CurveType", () => {
    const document = requireDocument(openChemDraftPayload(source));
    const explicit = graphicBySourceId(document, "c3");
    expect(explicit.data.pathClosed).toBeUndefined();
    expect(explicit.style.fillColor).toBe("none");
    expect(explicit.style.fillMode).toBeUndefined();
  });

  it("warns once, naming the CurveType flags it does not honour", () => {
    const result = openChemDraftPayload(source);
    const ignored = result.warnings.filter(warning => warning.code === "cdxml.curve_type_flags_ignored");
    expect(ignored).toHaveLength(1);
    expect(ignored[0].message).toContain('"c4"');
    for (const flag of ["dashed", "bold", "doubled"]) expect(ignored[0].message).toContain(flag);
    expect(ignored[0].message).not.toContain("closed");
    expect(graphicBySourceId(requireDocument(result), "c4").data.pathClosed).toBe(true);
  });

  it("keeps the source CurveType and closed/filled state through a visible CDXML round trip", () => {
    const document = requireDocument(openChemDraftPayload(source));
    // No embedded payload, so the reopened curves are read back from the visible CDXML alone.
    const exported = exportDocumentToCdxml(document, { embedNativePayload: false }).contents;
    const reopened = requireDocument(openChemDraftPayload(exported));
    for (const id of ["c1", "c2", "c3", "c4", "c5"]) {
      const before = graphicBySourceId(document, id);
      const after = graphicBySourceId(reopened, id);
      expect(after.data.pathClosed, id).toBe(before.data.pathClosed);
      expect(after.style.fillMode, id).toBe(before.style.fillMode);
      expect(after.compatibility?.unknown.cdxmlCurveAttributes, id).toMatchObject({ CurveType: (before.compatibility?.unknown.cdxmlCurveAttributes as Record<string, string>).CurveType });
    }
  });

  // What the exporter writes, not only what reopening it yields: an unedited curve whose closed or
  // filled state came from CurveType alone must not gain Closed or FillType, and explicit ones stay.
  const expectedCurveAttributes: Record<string, { CurveType: string; Closed?: string; FillType?: string }> = {
    c1: { CurveType: "129" }, c2: { CurveType: "257" }, c3: { CurveType: "129", Closed: "no", FillType: "None" },
    c4: { CurveType: "519" }, c5: { CurveType: "1" }
  };
  const expectCurveAttributes = (curves: Map<string, Record<string, string>>, expectations = expectedCurveAttributes) => {
    for (const [id, expected] of Object.entries(expectations)) {
      const written = curves.get(id);
      expect(written, id).toBeDefined();
      expect(written!.CurveType, id).toBe(expected.CurveType);
      expect(written!.Closed, id).toBe(expected.Closed);
      expect(written!.FillType, id).toBe(expected.FillType);
    }
  };

  it("writes the source CurveType, and no Closed or FillType the source did not state, to visible CDXML", () => {
    const document = requireDocument(openChemDraftPayload(source));
    const exported = exportDocumentToCdxml(document, { embedNativePayload: false }).contents;
    const curves = new Map<string, Record<string, string>>();
    for (const match of exported.matchAll(/<curve\b([^>]*?)\/?>/g)) {
      const attributes = Object.fromEntries([...match[1].matchAll(/([A-Za-z0-9_]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]));
      curves.set(attributes.id, attributes);
    }
    // Exported ids are reallocated; map them back through the source CurvePoints, which are unique here.
    const bySourceId = new Map<string, Record<string, string>>();
    for (const element of cdxmlCurveElements(source)) {
      const written = [...curves.values()].find(attributes => attributes.CurvePoints === element.CurvePoints);
      if (written) bySourceId.set(element.id, written);
    }
    expectCurveAttributes(bySourceId);
  });

  it("writes the source CurveType, and no Closed or FillType the source did not state, to binary CDX", () => {
    const document = requireDocument(openChemDraftPayload(source));
    const bytes = exportDocumentToCdx(document, { embedNativePayload: false }).bytes;
    const curves = cdxElements(readCdx(bytes), "curve").map(element => element.attrs);
    expect(curves).toHaveLength(5);
    // Binary CDX stores CurvePoints as fixed-point pairs, so match curves by their order on the page.
    const ids = cdxmlCurveElements(source).map(element => element.id);
    // Binary Closed is a presence-only flag, so c3's explicit Closed="no" cannot be written; the
    // exporter clears CurveType's closed bit instead (129 -> 128) so the curve still reads as open.
    expectCurveAttributes(new Map(curves.map((attributes, index) => [ids[index], attributes])),
      { ...expectedCurveAttributes, c3: { CurveType: "128", FillType: "None" } });
    const reopenedCurves = requireDocument(importCdx(bytes)).pages[0].objects.filter((object): object is GraphicObject =>
      object.type === "graphic" && object.compatibility?.unknown.cdxmlElementName === "curve");
    expect(reopenedCurves).toHaveLength(5);
    ids.forEach((id, index) => {
      const before = graphicBySourceId(document, id);
      expect(reopenedCurves[index].data.pathClosed, id).toBe(before.data.pathClosed);
      expect(reopenedCurves[index].style.fillMode, id).toBe(before.style.fillMode);
    });
  });
});

function cdxmlCurveElements(xml: string): Array<Record<string, string>> {
  return [...xml.matchAll(/<curve\b([^>]*?)\/?>/g)].map(match =>
    Object.fromEntries([...match[1].matchAll(/([A-Za-z0-9_]+)="([^"]*)"/g)].map(([, name, value]) => [name, value])));
}

function cdxElements(node: CdxElement, name: string): CdxElement[] {
  return [...(node.name === name ? [node] : []), ...node.kids.flatMap(child => cdxElements(child, name))];
}

// Independent synthetic CDX records, built byte by byte as cdxRectangleFill.test.ts does.
const u16 = (value: number) => [value & 255, value >>> 8 & 255];
const u32 = (value: number) => [...u16(value), ...u16(value >>> 16)];
const property = (tag: number, data: number[]) => [...u16(tag), ...u16(data.length), ...data];
const object = (tag: number, id: number, ...children: number[][]) => [...u16(tag), ...u32(id), ...children.flat(), 0, 0];
// CurvePoints (0x0A23): a point count, then each point as y then x, 16.16 fixed.
const curvePoints = (points: Array<[number, number]>) =>
  [...u16(points.length), ...points.flatMap(([x, y]) => [...u32(y * 65536), ...u32(x * 65536)])];
const curve = (id: number, curveType: number) => object(0x8008, id,
  property(0x0a23, curvePoints([[100, 100], [120, 80], [140, 100], [120, 120]])),
  property(0x0a08, u16(curveType)));

describe("legacy CurveType bitfield in binary CDX", () => {
  it("honours closed and filled from CurveType on a binary curve", () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode("VjCD0100"), 4, 3, 2, 1, ...Array(10).fill(0),
      ...object(0x8000, 0, object(0x8001, 1, curve(10, 0x0081)))
    ]);
    const document = requireDocument(importCdx(bytes));
    const imported = graphicBySourceId(document, "10");
    expect(imported.data.pathClosed).toBe(true);
    expect(imported.style.fillMode).toBe("solid");
  });

  it("reads a high-bit CurveType, which the binary reader decodes as a negative i16, as unsigned bits", () => {
    // 0x8081 = closed | filled | undefined bit 0x8000; as a signed 16-bit value it is -32639.
    const bytes = new Uint8Array([
      ...new TextEncoder().encode("VjCD0100"), 4, 3, 2, 1, ...Array(10).fill(0),
      ...object(0x8000, 0, object(0x8001, 1, curve(11, 0x8081), curve(12, 0x8001)))
    ]);
    const result = importCdx(bytes);
    const document = requireDocument(result);
    const filled = graphicBySourceId(document, "11");
    expect((filled.compatibility?.unknown.cdxmlCurveAttributes as Record<string, string>).CurveType).toBe("-32639");
    expect(filled.data.pathClosed).toBe(true);
    expect(filled.style.fillMode).toBe("solid");
    // -32767 = 0x8001: closed, unfilled, plus the undefined high bit.
    const closed = graphicBySourceId(document, "12");
    expect((closed.compatibility?.unknown.cdxmlCurveAttributes as Record<string, string>).CurveType).toBe("-32767");
    expect(closed.data.pathClosed).toBe(true);
    expect(closed.style.fillMode).toBeUndefined();
    const ignored = result.warnings.filter(warning => warning.code === "cdxml.curve_type_flags_ignored");
    expect(ignored).toHaveLength(2);
    for (const warning of ignored) {
      expect(warning.message).toContain("unknown bit 0x8000");
      expect(warning.message).not.toContain("closed");
    }
  });
});

describe("unknown objects in binary CDX keep their raw source through the native payload", () => {
  const fixture = cdxmlFixtures["unknown-objects-in-group.cdxml"];

  it("round-trips raw bioshape and embeddedobject data through a binary CDX save", () => {
    const document = requireDocument(openChemDraftPayload(fixture));
    const before = ["bs1", "bs2", "eo1"].map(id => unknownBySourceId(document, id));
    const reopened = importCdx(exportDocumentToCdx(document, { embedNativePayload: true }).bytes);
    expect(reopened.source).toBe("native-payload");
    const after = requireDocument(reopened);
    for (const original of before) {
      const restored = unknownBySourceId(after, original.compatibility!.originalId!);
      expect(restored.raw).toEqual(original.raw);
      expect(restored.sourceObjectType).toBe(original.sourceObjectType);
      expect(frameOf(restored)).toEqual(frameOf(original));
    }
    expect(unknownBySourceId(after, "eo1").raw).toMatchObject({ name: "embeddedobject", attributes: { id: "eo1", BoundingBox: "430 260 470 290" } });
    expect(unknownBySourceId(after, "bs1").raw).toMatchObject({ name: "bioshape", attributes: { BioShapeType: "Immunoglobin" } });
  });
});

describe("unknown objects in a payload-stripped codec-v1 visible layer", () => {
  // Codec v1 wrote atom and text `p` (and fragment BoundingBox) y-first but every graphic BoundingBox
  // x-first, so the import transposes only the y-first half. A curve or graphic preserved as an
  // unknown object takes its frame from that x-first BoundingBox and must not be transposed.
  const v1 = (content: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd">
<CDXML CreationProgram="ChemDraft 0.1.0">
  <page id="p1" BoundingBox="0 0 792 612">
    <objecttag Name="${ChemDraftObjectTags.codecVersion}" Persistent="yes" TagType="String" Value="${CdxmlEnvelopeCodecVersionV1}"/>
    <fragment id="f1">
      <n id="a1" p="75 75"/>
      <n id="a2" p="75 111"/>
      <b id="b1" B="a1" E="a2" Order="1"/>
    </fragment>
    ${content}
  </page>
</CDXML>`;
  const expectTransposedAtoms = (document: ChemDraftDocument) => {
    const molecule = document.pages[0].objects.find(object => object.type === "molecule");
    expect(molecule?.type === "molecule" && molecule.atoms[1]?.x).toBeCloseTo(148);
    expect(molecule?.type === "molecule" && molecule.atoms[1]?.y).toBeCloseTo(100);
  };

  it("leaves an invalid curve at its own x-first BoundingBox", () => {
    const result = openChemDraftPayload(v1('<curve id="c9" BoundingBox="100 200 140 260" CurvePoints="bad"/>'));
    const document = requireDocument(result);
    expectTransposedAtoms(document);
    expect(result.warnings.map(warning => warning.code)).toContain("cdxml.curve_points_preserved");
    const curve = unknownBySourceId(document, "c9");
    expect(curve.sourceObjectType).toBe("curve");
    expect(frameOf(curve)).toEqual(frame(100, 200, 140, 260));
  });

  it("leaves an unsupported bracket graphic at its own x-first BoundingBox", () => {
    const result = openChemDraftPayload(v1('<graphic id="g9" GraphicType="Bracket" BracketType="Angle" BoundingBox="100 200 110 300"/>'));
    const document = requireDocument(result);
    expectTransposedAtoms(document);
    expect(result.warnings.map(warning => warning.code)).toContain("cdxml.bracket_type_preserved");
    const bracket = unknownBySourceId(document, "g9");
    expect(bracket.sourceObjectType).toBe("graphic");
    expect(frameOf(bracket)).toEqual(frame(100, 200, 110, 300));
  });
});
