import { describe, expect, it } from "vitest";
import { type DocumentObject } from "@chemdraft/chem-core";
import { CDX_NATIVE_ENVELOPE_ATTRIBUTE, readCdx } from "./cdxBinary";
import { exportDocumentToCdx, exportDocumentToCdxml, importCdx, openChemDraftPayload } from "./index";

// Synthetic source: the molecule remains drawable when the two unknown objects are omitted.
const source = `<CDXML><page id="1" BoundingBox="0 0 612 792">
  <fragment id="10">
    <n id="11" p="20 20" Element="6"/><n id="12" p="40 20" Element="6"/>
    <b id="13" B="11" E="12" Order="1"/>
  </fragment>
  <scheme id="52"/><spectrum id="57"/>
</page></CDXML>`;

describe("unknown compatibility object export warnings", () => {
  it.each(["CDX without payload", "CDX with payload", "CDXML"] as const)("counts objects with duplicate or missing original ids in %s", route => {
    const document = openChemDraftPayload(source).document!;
    const unknown = document.pages[0].objects.find(object => object.type === "unknown-compatibility-object")!;
    const unknownObjects = Array.from({ length: 4 }, (_, index) => ({
      ...structuredClone(unknown),
      id: `unknown_${index}`,
      compatibility: { sourceFormat: "cdxml" as const, warnings: [], unknown: {},
        ...(index < 2 ? { originalId: "52" } : {}) }
    }));
    document.pages[0].objects = unknownObjects;
    const embedded = route !== "CDX without payload";
    const exported = route === "CDXML"
      ? exportDocumentToCdxml(document)
      : exportDocumentToCdx(document, { embedNativePayload: embedded });
    expect(exported.warnings).toEqual([
      ...unknownObjects.map((object, index) => ({
        code: "cdxml.object_export_unsupported",
        sourceObjectId: object.id,
        message: `Unrecognized <scheme> object ${index < 2 ? "52" : object.id} from the original file ${embedded
          ? "is kept in the embedded ChemDraft data but is not drawn in this file."
          : "was not saved: this file has no embedded ChemDraft data."}`
      })),
      ...(embedded ? [] : [{
        code: "cdxml.unknown_objects_not_saved",
        message: "4 unrecognized objects from the original file were not saved (ids 52, unknown_2, unknown_3)."
      }])
    ]);
  });

  it.each(["CDX without payload", "CDX with payload", "CDXML"] as const)("names the original objects in %s", route => {
    const imported = openChemDraftPayload(source);
    expect(imported.document).toBeDefined();
    const document = imported.document!;
    const objects = document.pages[0].objects;
    expect(objects).toHaveLength(3);
    const unknownObjects = objects.filter(object => object.type === "unknown-compatibility-object");
    expect(unknownObjects.map(object => [object.type, object.compatibility?.originalId])).toEqual([
      ["unknown-compatibility-object", "52"], ["unknown-compatibility-object", "57"]
    ]);

    const embedded = route !== "CDX without payload";
    const exported = route === "CDXML"
      ? exportDocumentToCdxml(document)
      : exportDocumentToCdx(document, { embedNativePayload: embedded });
    const outcome = embedded
      ? "is kept in the embedded ChemDraft data but is not drawn in this file."
      : "was not saved: this file has no embedded ChemDraft data.";
    expect(exported.warnings).toEqual([
      {
        code: "cdxml.object_export_unsupported",
        sourceObjectId: unknownObjects[0].id,
        message: `Unrecognized <scheme> object 52 from the original file ${outcome}`
      },
      {
        code: "cdxml.object_export_unsupported",
        sourceObjectId: unknownObjects[1].id,
        message: `Unrecognized <spectrum> object 57 from the original file ${outcome}`
      },
      ...(embedded ? [] : [{
        code: "cdxml.unknown_objects_not_saved",
        message: "2 unrecognized objects from the original file were not saved (ids 52, 57)."
      }])
    ]);
    const reopened = "bytes" in exported ? importCdx(exported.bytes) : openChemDraftPayload(exported.contents);
    expect(reopened.document, JSON.stringify(reopened.warnings)).toBeDefined();
    const molecule = reopened.document!.pages[0].objects.find(object => object.type === "molecule");
    expect(molecule).toBeDefined();
    expect(molecule!.atoms.map(atom => atom.element)).toEqual(["C", "C"]);
    expect(molecule!.bonds).toHaveLength(1);
    expect(molecule!.bonds[0]).toMatchObject({
      fromAtomId: molecule!.atoms[0].id,
      toAtomId: molecule!.atoms[1].id,
      order: "single"
    });
    if (embedded) {
      expect(reopened.source).toBe("native-payload");
      expect(reopened.document).toEqual({
        ...JSON.parse(JSON.stringify(document)), formatVersion: "1.2.0", minAppVersion: "1.2.0"
      });
    } else {
      expect(reopened.source).toBe("external-cdxml");
      expect(reopened.document!.pages[0].objects).toHaveLength(1);
    }
  });
});

describe("native object export warnings", () => {
  const base = { x: 60, y: 20, width: 30, height: 40, rotation: 0, style: {} };
  const cases: { object: DocumentObject; code: string; embedded: string; omitted: string; visibleBracket?: boolean }[] = [
    {
      object: { ...base, id: "bracket_1", type: "bracket", bracketKind: "curly", containedObjectIds: [] },
      code: "cdxml.bracket_geometry_approximated",
      embedded: "Bracket ID has unsupported curly shape, rotation or tilt; its glyph is approximated by an axis-aligned square bounding box.",
      omitted: "Bracket ID has unsupported curly shape, rotation or tilt; its glyph is approximated by an axis-aligned square bounding box.",
      visibleBracket: true
    },
    {
      object: { ...base, id: "mechanism_1", type: "mechanism-arrow", arrowKind: "full-headed",
        source: { kind: "point", point: { x: 60, y: 20 } }, target: { kind: "point", point: { x: 90, y: 60 } },
        controlPoints: [], warnings: [] },
      code: "cdxml.mechanism_payload_only",
      embedded: "Editable mechanism-arrow object ID remains in the embedded ChemDraft payload until CDXML mapping is implemented.",
      omitted: "Editable mechanism-arrow object ID was not saved: this file has no embedded ChemDraft data."
    },
    {
      object: { ...base, id: "electron_1", type: "electron-mark", markKind: "lone-pair",
        anchor: { kind: "point", point: { x: 60, y: 20 } } },
      code: "cdxml.electron_mark_appearance_payload_only",
      embedded: "CDXML export: electron mark ID, including its position, size (30 × 40), thickness (1.5) and rotation (0°), is preserved only in the embedded ChemDraft payload; no visible CDXML symbol is written.",
      omitted: "CDXML export: electron mark ID, including its position, size (30 × 40), thickness (1.5) and rotation (0°), was not saved: this file has no embedded ChemDraft data."
    },
    {
      object: { ...base, id: "annotation_1", type: "annotation", targetObjectIds: [], message: "Synthetic note" },
      code: "cdxml.object_export_unsupported",
      embedded: 'Object ID of type "annotation" remains available through the embedded ChemDraft payload but is not yet visible CDXML.',
      omitted: 'Object ID of type "annotation" was not saved: this file has no embedded ChemDraft data.'
    }
  ];

  for (const testCase of cases) {
    it.each(["CDX without payload", "CDX with payload", "CDXML"] as const)(`describes ${testCase.object.type} in %s`, route => {
      const embedded = route !== "CDX without payload";
      const binary = route !== "CDXML";
      for (const originalId of [undefined, "72"]) {
        const document = openChemDraftPayload(source).document!;
        document.pages[0].objects = document.pages[0].objects.filter(object => object.type === "molecule");
        const object = structuredClone(testCase.object);
        if (originalId) object.compatibility = { sourceFormat: "cdxml", originalId, warnings: [], unknown: {} };
        document.pages[0].objects.push(object);
        const id = originalId ?? object.id;
        const exported = binary
          ? exportDocumentToCdx(document, { embedNativePayload: embedded })
          : exportDocumentToCdxml(document);
        let message = (embedded ? testCase.embedded : testCase.omitted).replace("ID", testCase.visibleBracket ? object.id : id);
        if (binary) {
          message = message.replaceAll("CDXML", "CDX");
        }
        expect(exported.warnings).toEqual([
          { code: testCase.code, sourceObjectId: object.id,
            message },
          ...(!embedded && !testCase.visibleBracket ? [{ code: "cdxml.unknown_objects_not_saved",
            message: `1 object was not saved (ids ${id}).` }] : [])
        ]);
        if ("bytes" in exported) {
          const visible = readCdx(exported.bytes);
          expect(Boolean(visible.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE])).toBe(embedded);
          const graphics = visible.kids.find(child => child.name === "page")!.kids.filter(child => child.name === "graphic");
          expect(graphics).toEqual(testCase.visibleBracket ? [expect.objectContaining({
            attrs: expect.objectContaining({ GraphicType: "Bracket", BracketType: "Square" })
          })] : []);
        } else if (testCase.visibleBracket) {
          expect(exported.contents).toContain('GraphicType="Bracket"');
          expect(exported.contents).toContain('BracketType="Square"');
        }
        const reopened = "bytes" in exported ? importCdx(exported.bytes) : openChemDraftPayload(exported.contents);
        expect(reopened.document, JSON.stringify(reopened.warnings)).toBeDefined();
        const molecule = reopened.document!.pages[0].objects.find(object => object.type === "molecule")!;
        expect(molecule.atoms.map(atom => atom.element)).toEqual(["C", "C"]);
        expect(molecule.bonds).toHaveLength(1);
        if (embedded) expect(reopened.document).toEqual({
          ...JSON.parse(JSON.stringify(document)), formatVersion: "1.2.0", minAppVersion: "1.2.0"
        });
        else {
          expect(reopened.document!.pages[0].objects.map(candidate => candidate.type))
            .toEqual(testCase.visibleBracket ? ["molecule", "bracket"] : ["molecule"]);
          if (testCase.visibleBracket) expect(reopened.document!.pages[0].objects[1]).toMatchObject({
            type: "bracket", bracketKind: "square", x: 60, y: 20, width: 30, height: 40, rotation: 0
          });
          expect(molecule.bonds[0]).toMatchObject({
            fromAtomId: molecule.atoms[0].id, toAtomId: molecule.atoms[1].id, order: "single"
          });
        }
      }
    });
  }

  it("reopens payload-less CDX with the molecule intact and a visible square approximation of a curly bracket", () => {
    const document = openChemDraftPayload(source).document!;
    document.pages[0].objects = document.pages[0].objects.filter(object => object.type === "molecule");
    document.pages[0].objects.push(structuredClone(cases[0].object));
    const exported = exportDocumentToCdx(document, { embedNativePayload: false });
    expect(exported.warnings).toEqual([
      { code: "cdxml.bracket_geometry_approximated", sourceObjectId: "bracket_1",
        message: "Bracket bracket_1 has unsupported curly shape, rotation or tilt; its glyph is approximated by an axis-aligned square bounding box." }
    ]);
    const reopened = importCdx(exported.bytes);
    expect(reopened.source).toBe("external-cdxml");
    expect(reopened.warnings.map(warning => warning.code)).toEqual([
      "cdxml.external_subset_imported",
      "cdxml.structure_string_not_derived"
    ]);
    expect(reopened.document!.pages[0].objects.map(object => object.type)).toEqual(["molecule", "bracket"]);
    expect(reopened.document!.pages[0].objects[1]).toMatchObject({
      type: "bracket", bracketKind: "square", x: 60, y: 20, width: 30, height: 40, rotation: 0
    });
    const molecule = reopened.document!.pages[0].objects[0];
    if (molecule.type !== "molecule") throw new Error("Expected surviving molecule");
    expect(molecule.atoms.map(atom => atom.element)).toEqual(["C", "C"]);
    expect(molecule.bonds).toEqual([
      expect.objectContaining({ fromAtomId: molecule.atoms[0].id, toAtomId: molecule.atoms[1].id, order: "single" })
    ]);
  });

  it("counts mixed dropped objects, deduplicates ids and caps the summary at 20 ids", () => {
    const document = openChemDraftPayload(source).document!;
    const unknown = document.pages[0].objects.find(object => object.type === "unknown-compatibility-object")!;
    document.pages[0].objects = document.pages[0].objects.filter(object => object.type === "molecule");
    for (let index = 0; index < 22; index++) {
      document.pages[0].objects.push({ ...structuredClone(unknown), id: `unknown_${index}`,
        compatibility: { sourceFormat: "cdxml", originalId: String(index + 100), warnings: [], unknown: {} } });
    }
    document.pages[0].objects.push({ ...base, id: "note", type: "annotation", message: "Synthetic note", targetObjectIds: [],
      compatibility: { sourceFormat: "cdxml", originalId: "100", warnings: [], unknown: {} } });
    const exported = exportDocumentToCdx(document, { embedNativePayload: false });
    const unknownWarnings = (embedded: boolean) => Array.from({ length: 22 }, (_, index) => ({
      code: "cdxml.object_export_unsupported", sourceObjectId: `unknown_${index}`,
      message: `Unrecognized <scheme> object ${index + 100} from the original file ${embedded
        ? "is kept in the embedded ChemDraft data but is not drawn in this file."
        : "was not saved: this file has no embedded ChemDraft data."}`
    }));
    expect(exported.warnings).toEqual([
      ...unknownWarnings(false),
      { code: "cdxml.object_export_unsupported", sourceObjectId: "note",
        message: 'Object 100 of type "annotation" was not saved: this file has no embedded ChemDraft data.' },
      { code: "cdxml.unknown_objects_not_saved",
        message: `23 objects were not saved (ids ${Array.from({ length: 20 }, (_, index) => index + 100).join(", ")} … and 2 more).` }
    ]);
    const embedded = exportDocumentToCdx(document, { embedNativePayload: true });
    expect(embedded.warnings).toEqual([
      ...unknownWarnings(true),
      { code: "cdxml.object_export_unsupported", sourceObjectId: "note",
        message: 'Object 100 of type "annotation" remains available through the embedded ChemDraft payload but is not yet visible CDX.' }
    ]);
  });
});
