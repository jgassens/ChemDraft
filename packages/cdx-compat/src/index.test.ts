import { describe, expect, it } from "vitest";
import {
  ChemDraftDocumentSchema,
  DocumentSchemaVersion,
  createEmptyDocument,
  serializeDocument,
  type ArrowObject,
  type ChemDraftDocument,
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
    expect(result.contents).toContain('p="111 75"');
    expect(canonicalVisibleCdxml(result.contents)).not.toContain("org.chemdraft/native-document");
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

  it("imports CDXML p and BoundingBox coordinates as horizontal-then-vertical", () => {
    const opened = openChemDraftPayload(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd">
<CDXML CreationProgram="ChemDraft Synthetic Fixture">
  <page id="p1" BoundingBox="0 0 540 720">
    <fragment id="top" BoundingBox="120 100 156 100">
      <n id="a1" p="120 100"/>
      <n id="a2" p="156 100"/>
      <b id="b1" B="a1" E="a2" Order="1"/>
    </fragment>
    <fragment id="bottom" BoundingBox="120 220 156 220">
      <n id="a3" p="120 220"/>
      <n id="a4" p="156 220"/>
      <b id="b2" B="a3" E="a4" Order="1"/>
    </fragment>
    <t id="label" p="120 300">vertical stack</t>
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

  it("infers ring double-bond side from ChemDraw circular ordering", () => {
    const opened = openChemDraftPayload(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd">
<CDXML CreationProgram="ChemDraft Synthetic Fixture">
  <page id="p1" BoundingBox="0 0 540 720">
    <fragment id="ring" BoundingBox="80 80 170 170">
      <n id="a1" p="100 100"/>
      <n id="a2" p="100 136"/>
      <n id="a3" p="132 154"/>
      <n id="a4" p="164 136"/>
      <n id="a5" p="164 100"/>
      <n id="a6" p="132 82"/>
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
      display: { doubleBondSide: "left" }
    });
  });

  it("imports synthetic single and triple bond fixtures", () => {
    const single = openChemDraftPayload(cdxmlFixture("single-bond.cdxml"));
    const triple = openChemDraftPayload(cdxmlFixture("triple-bond.cdxml"));

    expect((single.document?.pages[0].objects[0] as MoleculeObject | undefined)?.bonds[0].order).toBe("single");
    expect((triple.document?.pages[0].objects[0] as MoleculeObject | undefined)?.bonds[0].order).toBe("triple");
    expect((triple.document?.pages[0].objects[0] as MoleculeObject | undefined)?.atoms[1].element).toBe("N");
  });

  it("warns on aromatic and unsupported visible bond display fixture paths", () => {
    const aromatic = openChemDraftPayload(cdxmlFixture("aromatic-bond.cdxml"));
    const displays = openChemDraftPayload(cdxmlFixture("wedge-hash-dash-bold.cdxml"));

    expect((aromatic.document?.pages[0].objects[0] as MoleculeObject | undefined)?.bonds[0].order).toBe("aromatic");
    expect(aromatic.warnings.map((item) => item.code)).toContain("cdxml.aromatic_bond_import_approximation");
    expect(displays.warnings.filter((item) => item.code === "cdxml.bond_display_unsupported")).toHaveLength(4);
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
        "cdxml.bond_display_unsupported",
        "cdxml.object_import_unsupported"
      ])
    );
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
    expect(opened.warnings.filter((item) => item.code === "cdxml.bond_display_unsupported")).toHaveLength(5);
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
