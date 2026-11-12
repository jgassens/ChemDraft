import { describe, expect, it } from "vitest";
import { ChemDraftDocumentSchema as Released111DocumentSchema } from "./__fixtures__/v1.1.1/schemas";
import { createEmptyDocument, parseDocument, readDocument, readSerializedDocument, serializeDocument } from "./document";
import { minimumAppVersionForDocument, NativeDocumentFeatureVersions } from "./documentFeatures";
import { NativeStylePresets, stylePresetToObjectStyle } from "./styles";

const base = { id: "object", x: 0, y: 0, width: 30, height: 30, rotation: 0, style: {} };
const text = { ...base, type: "text", text: "THF", spans: [] };
const attachment = {
  kind: "conditions", parentObjectId: "arrow", side: "above",
  frame: { origin: { x: 0, y: 0 }, tangent: { x: 1, y: 0 }, normal: { x: 0, y: -1 }, length: 30 },
  offset: { x: 0, y: 20 }, placement: "manual"
};

function documentWithObject(object: unknown) {
  const document = createEmptyDocument({ now: "2026-11-09T00:00:00.000Z" });
  return parseDocument({ ...document, pages: [{ ...document.pages[0], objects: [object] }] });
}

describe("integrated 1.2 native document features", () => {
  it("keeps bracket identity snapshots in legacy open metadata without raising the minimum version", () => {
    const snapshot = { sourceId: "11", atomId: "a", element: "C",
      incidentBonds: [{ id: "b", fromAtomId: "a", toAtomId: "c", fromElement: "C", toElement: "O" }] };
    // No 1.2 pair fields: this isolates the new metadata's version rule.
    const bracket = { ...base, type: "bracket", bracketKind: "square", containedObjectIds: [],
      compatibility: { warnings: [], unknown: { cdxmlBracketAtomSnapshots: [snapshot] } } };
    const document = documentWithObject(bracket);
    const saved = JSON.parse(serializeDocument(document));
    expect(minimumAppVersionForDocument(document)).toBe("1.1.1");
    expect(saved).not.toHaveProperty("formatVersion");
    expect(saved).not.toHaveProperty("ignorableFields");
    expect(Released111DocumentSchema.parse(saved)).toEqual(document);
    expect(readSerializedDocument(JSON.stringify(saved)).document).toEqual(document);
    for (const invalid of [
      { ...snapshot, unexpected: true },
      { ...snapshot, element: "" },
      { ...snapshot, incidentBonds: [{ ...snapshot.incidentBonds[0], fromElement: undefined }] },
      { ...snapshot, incidentBonds: [{ ...snapshot.incidentBonds[0], unexpected: true }] }
    ]) {
      expect(() => documentWithObject({ ...bracket,
        compatibility: { warnings: [], unknown: { cdxmlBracketAtomSnapshots: [invalid] } } })).toThrow();
    }
    expect(documentWithObject({ ...bracket, compatibility: { warnings: [], unknown: {} } })).toBeDefined();
  });

  it.each(["atoms", "bonds"] as const)("versions %s import provenance that the strict 1.1.1 reader cannot preserve", field => {
    const molecule = { ...base, type: "molecule", structureFormat: "unknown", structure: "",
      atoms: [{ id: "a", element: "C", x: 0, y: 0, formalCharge: 0,
        ...(field === "atoms" ? { cdxmlSourceId: "11" } : {}) },
        { id: "b", element: "O", x: 22, y: 0, formalCharge: 0 }],
      bonds: [{ id: "bond", fromAtomId: "a", toAtomId: "b", order: "single",
        ...(field === "bonds" ? { cdxmlSourceId: "13" } : {}) }], superatoms: [], rGroups: [] };
    const document = documentWithObject(molecule);
    const saved = JSON.parse(serializeDocument(document));
    expect(saved).toMatchObject({ formatVersion: "1.2.0", minAppVersion: "1.2.0" });
    expect(saved).not.toHaveProperty("ignorableFields");
    expect(readSerializedDocument(JSON.stringify(saved)).document).toEqual(saved);
    const { formatVersion: _format, minAppVersion: _minimum, ...withoutHeader } = saved;
    expect(Released111DocumentSchema.safeParse(withoutHeader).success).toBe(false);
    const pattern = `pages.*.objects.*[type=molecule].${field}.*.cdxmlSourceId`;
    expect(() => readDocument({ ...saved, ignorableFields: [pattern] })).toThrow(/known field .* cannot be declared ignorable/);
  });

  it("persists explicit scheme abbreviation chemistry and requires a supporting reader", () => {
    const document = documentWithObject({ ...base, type: "molecule", structureFormat: "unknown", structure: "",
      atoms: [{ id: "salt", element: "NaOH", schemeAbbreviation: "NaOH", x: 0, y: 0, formalCharge: 0 }],
      bonds: [], superatoms: [], rGroups: [] });
    const saved = JSON.parse(serializeDocument(document));
    expect(saved.minAppVersion).toBe("1.2.0");
    expect(readDocument(saved).document.pages[0]!.objects[0]).toEqual(document.pages[0]!.objects[0]);
    expect(Released111DocumentSchema.safeParse(document).success).toBe(false);
    expect(() => readDocument({ ...saved, ignorableFields: ["pages.*.objects.*[type=molecule].atoms.*.schemeAbbreviation"] }))
      .toThrow(/known field .* cannot be declared ignorable/);
  });

  it.each([
    ["compatibility", {}],
    ["compatibility.sourceFormat", { sourceFormat: "cdxml" }],
    ["compatibility.originalId", { originalId: "source-page" }],
    ["compatibility.warnings", { warnings: [] }],
    ["compatibility.warnings.*.code", { warnings: [{ code: "source.warning", message: "Source warning" }] }],
    ["compatibility.warnings.*.message", { warnings: [{ code: "source.warning", message: "Source warning" }] }],
    ["compatibility.warnings.*.objectId", { warnings: [{ code: "source.warning", message: "Source warning", objectId: "source-object" }] }],
    ["compatibility.unknown", { unknown: { cdxmlPageAttributes: { WidthPages: "2", HeightPages: "1" } } }]
  ])("requires support for page %s, which the released strict page schema rejects", (field, compatibility) => {
    const document = createEmptyDocument({ now: "2026-11-09T00:00:00.000Z" });
    const parsed = parseDocument({ ...document, pages: [{ ...document.pages[0], compatibility }] });
    expect(Released111DocumentSchema.parse(document)).toEqual(document);
    expect(Released111DocumentSchema.safeParse(parsed).success).toBe(false);
    expect(NativeDocumentFeatureVersions[`field:pages.*.${field}`]).toEqual({
      introducedIn: "1.2.0", kind: "feature", ignorable: false
    });
    const saved = { ...parsed, formatVersion: "1.2.0", minAppVersion: "1.2.0" };
    expect(JSON.parse(serializeDocument(parsed))).toEqual(saved);
    expect(readDocument(saved).document).toEqual(saved);
    expect(() => readDocument({ ...saved, ignorableFields: [`pages.*.${field}`] }))
      .toThrow(/known field .* cannot be declared ignorable/);
  });

  it.each(["molecule", "superatom"] as const)(
    "requires support for %s expansion membership, which the released strict metadata schema rejects", type => {
      const metadata = { label: "Me", atomIds: ["carbon"] };
      const object = type === "molecule"
        ? { ...base, type, structureFormat: "unknown", structure: "",
          atoms: [{ id: "carbon", element: "C", x: 0, y: 0, formalCharge: 0 }],
          bonds: [], superatoms: [metadata], rGroups: [] }
        : { ...base, type, label: "Me", metadata };
      const document = documentWithObject(object);
      const saved = { ...document, formatVersion: "1.2.0", minAppVersion: "1.2.0" };
      expect(JSON.parse(serializeDocument(document))).toEqual(saved);
      expect(readDocument(saved).document).toEqual(saved);
      expect(Released111DocumentSchema.safeParse(document).success).toBe(false);
      const baseline = structuredClone(document);
      const group = baseline.pages[0]!.objects[0]!;
      if (group.type === "molecule") delete group.superatoms[0]!.atomIds;
      else if (group.type === "superatom") delete group.metadata.atomIds;
      expect(Released111DocumentSchema.parse(baseline)).toEqual(baseline);
      const field = type === "molecule" ? "superatoms.*.atomIds" : "metadata.atomIds";
      const pattern = `pages.*.objects.*[type=${type}].${field}`;
      expect(NativeDocumentFeatureVersions[`field:${pattern}`]).toEqual({
        introducedIn: "1.2.0", kind: "feature", ignorable: false
      });
      expect(() => readDocument({ ...saved, ignorableFields: [pattern] }))
        .toThrow(/known field .* cannot be declared ignorable/);
    }
  );

  it("classifies every bracket relation and usage enum as meaning-bearing", () => {
    const bracketFeatures = Object.entries(NativeDocumentFeatureVersions).filter(([token]) =>
      /^(field|value):pages\.\*\.objects\.\*\[type=bracket\]\.(side|pairId|repeatUnit|bracketUsage|repeatCount|crossingBondIds)(\.|=|$)/.test(token));
    expect(bracketFeatures).toHaveLength(14);
    for (const [token, feature] of bracketFeatures) {
      expect(feature, token).toEqual({ introducedIn: "1.2.0", kind: "feature", ignorable: false });
    }
  });

  it.each(NativeStylePresets)(
    "keeps $id in legacy open style metadata without requiring a newer reader", preset => {
      const style = stylePresetToObjectStyle(preset);
      const document = documentWithObject({ ...text, style });
      document.styles.drawing = style;
      document.styles.text = { stylePresetId: preset.id, color: "#12ab34" };
      const saved = JSON.parse(serializeDocument(document));
      expect(minimumAppVersionForDocument(document)).toBe("1.1.1");
      expect(saved).toEqual(document);
      expect(Released111DocumentSchema.parse(saved)).toEqual(document);
      expect(readDocument(saved).document).toEqual(document);
    }
  );

  it.each(NativeStylePresets)("versions $id on graphics, whose released style schema is strict", preset => {
    const document = documentWithObject({ ...base, type: "graphic", graphicKind: "rect",
      style: { stylePresetId: preset.id } });
    const saved = JSON.parse(serializeDocument(document));
    expect(saved).toEqual({ ...document, formatVersion: "1.2.0", minAppVersion: "1.2.0",
      ignorableFields: ["pages.*.objects.*[type=graphic].style.stylePresetId"] });
    expect(readDocument(saved).document).toEqual(saved);
    expect(Released111DocumentSchema.safeParse(saved).success).toBe(false);
    const { formatVersion: _format, minAppVersion: _minimum, ignorableFields: _ignorable, ...withoutHeader } = saved;
    expect(Released111DocumentSchema.safeParse(withoutHeader).success).toBe(false);
  });

  it.each([
    ["waveSmoothness", 0], ["waveSmoothness", 100], ["waveHeight", 0], ["waveHeight", 48],
    ["waveWidth", 4], ["waveWidth", 120]
  ] as const)("versions graphic %s=%s as display-only, including zero values", (setting, value) => {
    const document = documentWithObject({ ...base, type: "graphic", graphicKind: "path",
      data: { artPathKind: "wavy", lineStart: { x: 0, y: 0 }, lineEnd: { x: 30, y: 0 }, [setting]: value } });
    const contents = serializeDocument(document);
    const saved = JSON.parse(contents);
    expect(saved).toMatchObject({ formatVersion: "1.2.0", minAppVersion: "1.2.0",
      ignorableFields: [`pages.*.objects.*[type=graphic].data.${setting}`] });
    expect(readSerializedDocument(contents).warnings).toEqual([]);
    expect(serializeDocument(readSerializedDocument(contents).document)).toBe(contents);
    expect(Released111DocumentSchema.safeParse(saved).success).toBe(false);
  });

  it.each([
    ["electron-mark", { ...base, type: "electron-mark", markKind: "charge", charge: 1,
      anchor: { kind: "atom", objectId: "molecule", atomId: "n" }, atomAssociation: "explicit" }],
    ["floating electron-mark", { ...base, type: "electron-mark", markKind: "charge", charge: 1,
      anchor: { kind: "point", point: { x: 20, y: 20 } }, atomAssociation: "explicit" }],
    ["conditions label", { ...text, arrowAttachment: attachment }]
  ])("requires 1.2 support for the %s relation without declaring it ignorable", (_name, object) => {
    const document = documentWithObject(object);
    const contents = serializeDocument(document);
    const saved = JSON.parse(contents);
    expect(saved).toMatchObject({ formatVersion: "1.2.0", minAppVersion: "1.2.0" });
    expect(saved).not.toHaveProperty("ignorableFields");
    expect(saved.pages[0].objects[0]).toEqual(document.pages[0]!.objects[0]);
    expect(readSerializedDocument(contents).warnings).toEqual([]);
    expect(serializeDocument(readSerializedDocument(contents).document)).toBe(contents);
    expect(Released111DocumentSchema.safeParse(saved).success).toBe(false);
  });

  it.each([
    "pages.*.objects.*[type=electron-mark].atomAssociation",
    "pages.*.objects.*[type=text].arrowAttachment",
    "pages.*.objects.*[type=text].arrowAttachment.parentObjectId",
    "pages.*.objects.*[type=text].arrowAttachment.frame.normal.x",
    "pages.*.objects.*[type=molecule].bonds.*.display.bondStyle",
    "pages.*.objects.*[type=reaction].arrowObjectIds",
    "pages.*.objects.*[type=reaction].plusObjectIds",
    "pages.*.objects.*[type=bracket].side",
    "pages.*.objects.*[type=bracket].pairId",
    "pages.*.objects.*[type=bracket].repeatUnit",
    "pages.*.objects.*[type=bracket].bracketUsage",
    "pages.*.objects.*[type=bracket].repeatCount",
    "pages.*.objects.*[type=bracket].crossingBondIds",
    "pages.*.objects.*[type=bracket].crossingBondIds.*.objectId",
    "pages.*.objects.*[type=bracket].crossingBondIds.*.bondId"
  ])("refuses a file header that declares meaningful state ignorable: %s", pattern => {
    expect(() => readDocument({ ...createEmptyDocument(), formatVersion: "1.3.0", ignorableFields: [pattern] }))
      .toThrow(/known field .* cannot be declared ignorable/);
  });

  it("versions wavy stereochemistry, shared scheme links and complete bracket semantics without ignorable headers", () => {
    const molecule = { ...base, id: "molecule", type: "molecule", structureFormat: "unknown", structure: "",
      atoms: [{ id: "a", element: "C", x: 0, y: 0, formalCharge: 0 },
        { id: "b", element: "C", x: 22, y: 0, formalCharge: 0 }],
      bonds: [{ id: "bond", fromAtomId: "a", toAtomId: "b", order: "single", display: { bondStyle: "wavy" } }],
      superatoms: [], rGroups: [] };
    const reaction = { ...base, id: "reaction", type: "reaction", components: [{ role: "reactant", objectId: molecule.id }],
      conditionsTextObjectIds: [], arrowObjectIds: ["arrow"], plusObjectIds: ["plus"], mappingState: "absent" };
    const open = { ...base, id: "open", type: "bracket", bracketKind: "square", side: "open", pairId: "pair",
      repeatUnit: false, bracketUsage: "multiple", repeatCount: 3, containedObjectIds: [molecule.id],
      crossingBondIds: [{ objectId: molecule.id, bondId: "bond" }] };
    const close = { ...open, id: "close", x: 40, side: "close", label: "m" };
    const arrow = { ...base, id: "arrow", type: "graphic", graphicKind: "line", data: {} };
    const plus = { ...base, id: "plus", type: "plus" };
    // Exercise each addition alone as well as together, so another feature cannot hide a missing rule.
    for (const objects of [[molecule], [reaction, arrow, plus], [open, close], [molecule, reaction, arrow, plus, open, close]]) {
      const document = createEmptyDocument({ now: "2026-11-09T00:00:00.000Z" });
      const parsed = parseDocument({ ...document, pages: [{ ...document.pages[0], objects }] });
      const contents = serializeDocument(parsed);
      const saved = JSON.parse(contents);
      expect(saved).toMatchObject({ formatVersion: "1.2.0", minAppVersion: "1.2.0" });
      expect(saved).not.toHaveProperty("ignorableFields");
      expect(saved.pages[0].objects).toEqual(parsed.pages[0]!.objects);
      expect(readSerializedDocument(contents).warnings).toEqual([]);
      expect(serializeDocument(readSerializedDocument(contents).document)).toBe(contents);
      expect(Released111DocumentSchema.safeParse(saved).success).toBe(false);
    }
  });

  it("removes the version and ignorable headers when the last 1.2 feature is removed", () => {
    const document = documentWithObject({ ...text, arrowAttachment: attachment,
      style: { stylePresetId: "chemdraft.document" } });
    const read = readSerializedDocument(serializeDocument(document));
    const object = read.document.pages[0]!.objects[0]!;
    if (object.type !== "text") throw new Error("Expected conditions text");
    delete object.arrowAttachment;
    delete object.style.stylePresetId;
    expect(minimumAppVersionForDocument(read.document)).toBe("1.1.1");
    const saved = JSON.parse(serializeDocument(read.document));
    for (const field of ["formatVersion", "minAppVersion", "ignorableFields"]) expect(saved).not.toHaveProperty(field);
    expect(Released111DocumentSchema.safeParse(saved).success).toBe(true);
  });
});
