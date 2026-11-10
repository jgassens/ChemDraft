import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ChemDraftDocumentSchema as Released111DocumentSchema,
  DocumentObjectSchema as Released111ObjectSchema } from "./__fixtures__/v1.1.1/schemas";
import { createEmptyDocument, deserializeDocument, parseDocument, readDocument, readSerializedDocument, serializeDocument } from "./document";
import { ChemDraftDocumentSchema, MoleculeBondSchema, type MoleculeObject } from "./schemas";
import { NativeDocumentReadError } from "./documentRead";
import {
  minimumAppVersionForDocument, minimumVersionForNativeFeatures, nativeSchemaInventory,
  NativeDocumentFeatureVersions, type NativeDocumentFeatureVersion
} from "./documentFeatures";
import { applyPatch } from "./patches";
import { CORPUS } from "./corpus";
import { snapshotChemicalIdentity } from "./identity";
import { compareNativeVersions } from "./nativeCompatibilityState";

function plainDocument() {
  const document = createEmptyDocument({ now: "2026-11-09T00:00:00.000Z" });
  document.pages[0]!.objects.push({
    id: "molecule", type: "molecule", x: 0, y: 0, width: 30, height: 30, rotation: 0,
    style: {}, structureFormat: "smiles", structure: "CO",
    atoms: [{ id: "c", element: "C", x: 0, y: 0, formalCharge: 0 },
      { id: "o", element: "O", x: 22, y: 0, formalCharge: 0 }],
    bonds: [{ id: "b", fromAtomId: "c", toAtomId: "o", order: "single" }],
    superatoms: [], rGroups: []
  });
  return document;
}

function futureDocument() {
  return { ...plainDocument(), formatVersion: "1.3.0", minAppVersion: "1.3.0" };
}

describe("native feature version registry", () => {
  it("requires an introduction entry for every field and enum/literal added since the frozen v1.1.1 schema", () => {
    const released = nativeSchemaInventory(Released111DocumentSchema);
    const current = nativeSchemaInventory(ChemDraftDocumentSchema);
    const additions = [...current].filter((token) => !released.has(token)).sort();
    expect(additions).toEqual(Object.entries(NativeDocumentFeatureVersions)
      .filter(([, feature]) => feature.schemaTracked !== false).map(([token]) => token).sort());
    for (const entry of Object.values(NativeDocumentFeatureVersions)) {
      expect(typeof entry.ignorable).toBe("boolean");
      if (entry.kind !== "feature") expect(entry.ignorable).toBe(false);
      expect(entry.introducedIn).toMatch(/^\d+\.\d+\.\d+$/);
      expect(compareNativeVersions(entry.introducedIn, "1.1.1")).toBeGreaterThan(0);
    }
  });

  it("detects a new nested field, enum value, and object variant that has no registry entry", () => {
    const old = z.object({ objects: z.array(z.discriminatedUnion("type", [
      z.object({ type: z.literal("molecule"), style: z.enum(["plain"]) })
    ])) });
    const next = z.object({ objects: z.array(z.discriminatedUnion("type", [
      z.object({ type: z.literal("molecule"), style: z.enum(["plain", "wavy"]), label: z.string().optional() }),
      z.object({ type: z.literal("new-object"), value: z.string() })
    ])) });
    const previous = nativeSchemaInventory(old);
    expect([...nativeSchemaInventory(next)].filter((token) => !previous.has(token))).toEqual(expect.arrayContaining([
      "value:objects.*[type=molecule].style=\"wavy\"", "field:objects.*[type=molecule].label",
      "field:objects.*[type=new-object].value", "value:objects.*[type=new-object].type=\"new-object\""
    ]));
  });

  it("proves every baseline-preservation exemption against the frozen reader's style schema", () => {
    const exemptions = Object.entries(NativeDocumentFeatureVersions).filter(([, feature]) => feature.preservedByBaseline);
    expect(exemptions).toHaveLength(15);
    const style = { stylePresetId: "chemdraft.acs1996", color: "#12ab34", bondLengthPx: 22 };
    for (const [token] of exemptions) {
      const match = /^field:pages\.\*\.objects\.\*\[type=([^\]]+)\]\.style\.stylePresetId$/.exec(token);
      expect(match, token).not.toBeNull();
      const kind = match![1]!;
      const released = Released111ObjectSchema.innerType().options.find(option => option.shape.type.value === kind)!;
      expect(released.shape.style.parse(style), token).toEqual(style);
    }
    const graphic = Released111ObjectSchema.innerType().options.find(option => option.shape.type.value === "graphic")!;
    expect(graphic.shape.style.safeParse({ stylePresetId: "chemdraft.acs1996" }).success).toBe(false);
  });

  it("computes the maximum introduction version from fields and enum values actually used", () => {
    // Synthetic extensions exercise the same registry evaluator used by the real writer. The
    // released baseline and this branch have identical drawing fields; future slices add entries.
    const schema = z.object({
      conditionsLabel: z.string().optional(),
      objects: z.array(z.discriminatedUnion("type", [z.object({ type: z.literal("molecule"),
        bondStyle: z.enum(["plain", "wavy", "new-wave"]), preset: z.enum(["default", "new-preset"]) })]))
    });
    const registry: Record<string, NativeDocumentFeatureVersion> = {
      "field:conditionsLabel": { introducedIn: "1.2.0", kind: "feature", ignorable: true },
      "value:objects.*[type=molecule].bondStyle=\"wavy\"": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
      "value:objects.*[type=molecule].bondStyle=\"new-wave\"": { introducedIn: "1.10.0", kind: "feature", ignorable: false },
      "value:objects.*[type=molecule].preset=\"new-preset\"": { introducedIn: "1.3.0", kind: "feature", ignorable: false }
    };
    const base = { objects: [{ type: "molecule", bondStyle: "plain", preset: "default" }] };
    const minimum = (value: unknown) => minimumVersionForNativeFeatures(schema, value, registry);
    expect(minimum(base)).toBe("1.1.1");
    expect(minimum({ ...base, conditionsLabel: "heat" })).toBe("1.2.0");
    expect(minimum({ objects: [{ ...base.objects[0], bondStyle: "wavy" }] })).toBe("1.2.0");
    expect(minimum({ objects: [{ ...base.objects[0], preset: "new-preset" }] })).toBe("1.3.0");
    expect(minimum({ conditionsLabel: "heat", objects: [{ ...base.objects[0], bondStyle: "new-wave", preset: "new-preset" }] }))
      .toBe("1.10.0");
  });

  it("writes plain 1.2 files without version fields and the released v1.1.1 schema accepts them", () => {
    const document = plainDocument();
    expect(minimumAppVersionForDocument(document)).toBe("1.1.1");
    const serialized = JSON.parse(serializeDocument(document));
    expect(serialized).not.toHaveProperty("formatVersion");
    expect(serialized).not.toHaveProperty("minAppVersion");
    expect(serialized).not.toHaveProperty("ignorableFields");
    expect(Released111DocumentSchema.parse(serialized)).toEqual(document);
    // Stronger than a blank-page proof: exercise every existing graph/stereo corpus entry too.
    for (const entry of CORPUS) {
      const corpusDocument = createEmptyDocument({ now: "2026-11-09T00:00:00.000Z" });
      corpusDocument.pages[0]!.objects.push(entry.mol);
      expect(Released111DocumentSchema.safeParse(JSON.parse(serializeDocument(corpusDocument))).success, entry.id).toBe(true);
    }
  });

  it("can version a new preset id inside open style metadata without treating all metadata as new", () => {
    const schema = z.object({ style: z.record(z.unknown()) });
    const registry: Record<string, NativeDocumentFeatureVersion> = {
      "value:style.stylePresetId=\"chemdraft.future\"": { introducedIn: "1.2.0", kind: "feature", ignorable: false, schemaTracked: false }
    };
    expect(minimumVersionForNativeFeatures(schema, { style: { stylePresetId: "chemdraft.synthetic" } }, registry)).toBe("1.1.1");
    expect(minimumVersionForNativeFeatures(schema, { style: { stylePresetId: "chemdraft.future" } }, registry)).toBe("1.2.0");
  });

  it("distinguishes literal types and enum values containing delimiters in feature rules", () => {
    const old = z.object({ version: z.literal(1) });
    const next = z.object({ version: z.union([z.literal(1), z.literal("1")]),
      style: z.enum(["plain", "wave=new.style"]).optional() });
    const oldTokens = nativeSchemaInventory(old);
    expect([...nativeSchemaInventory(next)].filter((token) => !oldTokens.has(token))).toContain('value:version="1"');
    const registry: Record<string, NativeDocumentFeatureVersion> = {
      'value:version="1"': { introducedIn: "1.2.0", kind: "feature", ignorable: false },
      'value:style="wave=new.style"': { introducedIn: "1.3.0", kind: "feature", ignorable: false }
    };
    expect(minimumVersionForNativeFeatures(next, { version: 1 }, registry)).toBe("1.1.1");
    expect(minimumVersionForNativeFeatures(next, { version: "1" }, registry)).toBe("1.2.0");
    expect(minimumVersionForNativeFeatures(next, { version: 1, style: "wave=new.style" }, registry)).toBe("1.3.0");
  });

  it("does not raise the minimum merely because a newer writer supplied an otherwise unused envelope", () => {
    const document = futureDocument();
    const read = readDocument(document);
    expect(read.warnings).toEqual([]);
    expect(JSON.parse(serializeDocument(read.document))).not.toHaveProperty("minAppVersion");
  });
});

describe("forward-compatible native reader", () => {
  it("preserves a synthetic 1.3 file's unknown fields and nested objects and gives named visual fallbacks", () => {
    const source = futureDocument();
    const molecule = source.pages[0]!.objects[0] as MoleculeObject;
    const raw = JSON.parse(JSON.stringify(source));
    raw.ignorableFields = ["pages.*.objects.*[type=molecule].atoms.*.visualDecoration",
      "pages.*.objects.*[type=molecule].bonds.*.display.visualDecoration"];
    raw.futureSettings = { nested: { enabled: true, values: [null, 3.14, "kept"] } };
    raw.pages[0].objects[0].atoms[0].visualDecoration = { position: "above", ornaments: ["a", "b"] };
    raw.pages[0].objects[0].bonds[0].display = { bondStyle: "future-wave", visualDecoration: { amplitude: 7 } };
    raw.pages[0].objects[0].style.stylePresetId = "chemdraft.future";
    const pristine = JSON.stringify(raw);
    const result = readSerializedDocument(pristine);
    expect(result.formatVersion).toBe("1.3.0");
    expect(result.minAppVersion).toBe("1.3.0");
    expect(minimumAppVersionForDocument(result.document)).toBe("1.3.0");
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "NATIVE_BOND_STYLE_FALLBACK",
      path: ["pages", 0, "objects", 0, "bonds", 0, "display", "bondStyle"], originalValue: "future-wave" }));
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "NATIVE_STYLE_PRESET_FALLBACK", originalValue: "chemdraft.future" }));
    const opened = result.document.pages[0]!.objects[0] as MoleculeObject;
    expect(opened.bonds[0]!.display?.bondStyle).toBeUndefined();
    expect(opened.style.stylePresetId).toBe("chemdraft.synthetic");
    expect(snapshotChemicalIdentity(opened).graph).toEqual(snapshotChemicalIdentity(molecule).graph);
    const expectedSaved = { ...raw, ignorableFields: [
      ...raw.ignorableFields,
      "pages.*.objects.*[type=molecule].style.stylePresetId"
    ] };
    expect(JSON.parse(serializeDocument(result.document))).toEqual(expectedSaved);
    expect(JSON.stringify(raw)).toBe(pristine);
    expect(parseDocument(result.document)).toEqual(result.document);
    expect(JSON.parse(serializeDocument(deserializeDocument(serializeDocument(result.document))))).toEqual(expectedSaved);
  });

  it("returns useful version defaults for released files", () => {
    expect(readDocument(plainDocument())).toMatchObject({ minAppVersion: "1.1.1", formatVersion: undefined, warnings: [] });
  });

  it.each([undefined, "1.1.1", "1.2.0"])("still opens main's visual enum cases with formatVersion %s", (formatVersion) => {
    // main 78f82a1e schemas.ts used degradingEnum(...).catch("unknown") for these classifiers,
    // without requiring a version envelope. Keep that legacy file-reading contract.
    const raw = JSON.parse(JSON.stringify(plainDocument()));
    if (formatVersion) raw.formatVersion = formatVersion;
    const base = { x: 0, y: 0, width: 30, height: 30, rotation: 0, style: {} };
    raw.pages[0].objects = [
      { ...base, id: "g", type: "graphic", graphicKind: "future-graphic", data: {} },
      { ...base, id: "b", type: "bracket", bracketKind: "future-bracket", containedObjectIds: [] },
      { ...base, id: "a", type: "reaction-arrow", arrowKind: "future-arrow", labels: [],
        start: { kind: "point", point: { x: 0, y: 0 } }, end: { kind: "point", point: { x: 30, y: 0 } } },
      { ...base, id: "t", type: "table", tableVersion: 1, headerRowCount: 0,
        columns: [{ id: "c", align: "future-align", width: { mode: "auto" } }],
        rows: [{ id: "r", cells: [{ text: "cell" }] }], tableStyle: { preset: "future-preset" } }
    ];
    const read = readDocument(raw);
    expect(read.warnings).toHaveLength(5);
    expect(read.warnings.every((warning) => warning.code === "NATIVE_VISUAL_ENUM_FALLBACK")).toBe(true);
    expect(read.document.pages[0]!.objects).toMatchObject([
      { graphicKind: "unknown" }, { bracketKind: "unknown" }, { arrowKind: "unknown" },
      { columns: [{ align: "unknown" }], tableStyle: { preset: "unknown" } }
    ]);
    expect(JSON.parse(serializeDocument(read.document)).pages[0].objects).toMatchObject(raw.pages[0].objects);
  });

  it("preserves known isotopes, radicals, charges, coordinates and stereo alongside future decoration", () => {
    const raw = JSON.parse(JSON.stringify(futureDocument()));
    const molecule = raw.pages[0].objects[0];
    molecule.atoms[0].isotope = 13;
    molecule.atoms[0].markRadicals = 1;
    molecule.atoms[1].formalCharge = -1;
    molecule.bonds[0].display = { bondStyle: "wedge" };
    raw.ignorableFields = ["pages.*.objects.*[type=molecule].visualDecoration"];
    molecule.visualDecoration = { symbol: "star" };
    const opened = readDocument(raw);
    expect(opened.document.pages[0]!.objects[0]).toMatchObject({ atoms: molecule.atoms, bonds: molecule.bonds });
    expect(JSON.parse(serializeDocument(opened.document))).toEqual(raw);
  });

  it("uses neutral fallbacks for future paint, markers and effects, preserving whole visual payloads", () => {
    const raw = JSON.parse(JSON.stringify(futureDocument()));
    raw.pages[0].objects.push({ id: "g", type: "graphic", graphicKind: "rect", x: 0, y: 0,
      width: 20, height: 20, rotation: 0,
      style: { fillPaint: { kind: "future-gradient", colors: ["red", "blue"], futureMesh: { rows: 3 } },
        visualEffects: [{ id: "future-effect", kind: "sparkles", strength: 4, futureSettings: { frequency: 7 } }] },
      data: { markerEnd: { kind: "future-head", sizePx: 12 } } });
    const result = readDocument(raw);
    expect(result.warnings.filter((warning) => warning.code === "NATIVE_VISUAL_ENUM_FALLBACK")).toHaveLength(3);
    expect(result.document.pages[0]!.objects[1]).toMatchObject({
      style: { fillPaint: { kind: "none" }, visualEffects: [{ kind: "shadow", opacity: 0 }] },
      data: { markerEnd: { kind: "none", sizePx: 12 } }
    });
    expect(JSON.parse(serializeDocument(result.document))).toEqual(raw);
  });

  it("falls back for a future document drawing preset while preserving its original identifier", () => {
    const raw = JSON.parse(JSON.stringify(futureDocument()));
    raw.styles.drawing = { stylePresetId: "chemdraft.future", bondLengthPx: 24 };
    const result = readDocument(raw);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "NATIVE_STYLE_PRESET_FALLBACK",
      path: ["styles", "drawing", "stylePresetId"], originalValue: "chemdraft.future" }));
    expect(result.document.styles.drawing).toEqual({ stylePresetId: "chemdraft.synthetic", bondLengthPx: 24 });
    expect(JSON.parse(serializeDocument(result.document))).toEqual(raw);
  });

  it("keeps preserved data with its object through cloning, patches, reordering and deletion", () => {
    const raw = JSON.parse(JSON.stringify(futureDocument()));
    raw.ignorableFields = ["pages.*.objects.*[type=molecule].visualDecoration"];
    raw.pages[0].objects[0].visualDecoration = { kept: 42 };
    raw.pages[0].objects.push({ ...raw.pages[0].objects[0], id: "other", visualDecoration: { kept: 7 } });
    const opened = readDocument(raw).document;
    const moved = applyPatch(opened, { op: "moveObject", objectId: "molecule", x: 88, y: 99 });
    const reordered = applyPatch(moved, { op: "reorderObject", objectId: "molecule", placement: "front" });
    const saved = JSON.parse(serializeDocument(reordered));
    expect(saved.pages[0].objects.find((object: { id: string }) => object.id === "molecule")).toMatchObject({ x: 88, y: 99, visualDecoration: { kept: 42 } });
    expect(saved.pages[0].objects.find((object: { id: string }) => object.id === "other")).toHaveProperty("visualDecoration", { kept: 7 });
    const removed = applyPatch(reordered, { op: "removeObject", objectId: "molecule" });
    expect(JSON.parse(serializeDocument(removed)).pages[0].objects).toHaveLength(1);
  });

  it("lets an explicit edit replace a degraded value rather than restoring its obsolete original", () => {
    const raw = JSON.parse(JSON.stringify(futureDocument()));
    raw.pages[0].objects[0].bonds[0].display = { bondStyle: "future-wave" };
    const opened = readDocument(raw).document;
    const molecule = opened.pages[0]!.objects[0] as MoleculeObject;
    const changed = applyPatch(opened, { op: "updateObject", objectId: molecule.id,
      changes: { bonds: molecule.bonds.map((bond) => ({ ...bond, display: { bondStyle: "dashed" } })) } });
    const saved = JSON.parse(serializeDocument(changed));
    expect(saved.pages[0].objects[0].bonds[0].display.bondStyle).toBe("dashed");
    expect(saved).not.toHaveProperty("minAppVersion");
  });

  it.each(["stereo"])("refuses an unknown chemical bond %s with a specific path and value", (key) => {
    const raw = JSON.parse(JSON.stringify(futureDocument()));
    raw.pages[0].objects[0].bonds[0][key] = "future-chemistry";
    try {
      readDocument(raw);
      expect.fail("Expected chemical feature refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(NativeDocumentReadError);
      expect(error).toMatchObject({ code: "NATIVE_UNSUPPORTED_CHEMISTRY",
        path: ["pages", 0, "objects", 0, "bonds", 0, key], originalValue: "future-chemistry" });
      expect((error as Error).message).toContain("chemical identity cannot be preserved");
    }
  });

  it.each([undefined, "1.2.0", "1.3.0"])("opens main's chemistry enum cases with warnings and preserves originals with version %s", version => {
    const base = { x: 0, y: 0, width: 30, height: 30, rotation: 0, style: {} };
    const point = { kind: "point", point: { x: 0, y: 0 } };
    const molecule = plainDocument().pages[0]!.objects[0] as MoleculeObject;
    const objects = [
      { ...molecule, structureFormat: "future-encoding" },
      { ...molecule, bonds: [{ ...molecule.bonds[0], order: "quadruple" }] },
      { ...molecule, superatoms: [{ label: "Me", expandedStructureFormat: "future-encoding" }] },
      { ...base, id: "r", type: "reaction", components: [], mappingState: "future-mapping" },
      { ...base, id: "a", type: "mechanism-arrow", source: point, target: point, arrowKind: "future-mechanism" },
      { ...base, id: "e", type: "electron-mark", anchor: point, markKind: "future-electrons" },
      { ...base, id: "s", type: "superatom", label: "Me", metadata: { label: "Me", expandedStructureFormat: "future-encoding" } }
    ];
    const suffixes = [["structureFormat"], ["bonds", 0, "order"], ["superatoms", 0, "expandedStructureFormat"],
      ["mappingState"], ["arrowKind"], ["markKind"], ["metadata", "expandedStructureFormat"]];
    for (const [index, object] of objects.entries()) {
      const raw = JSON.parse(JSON.stringify(plainDocument()));
      if (version) Object.assign(raw, { formatVersion: version, minAppVersion: version });
      raw.pages[0].objects = [object];
      const opened = readDocument(raw);
      const suffix = suffixes[index]!;
      const at = (value: unknown) => suffix.reduce<unknown>((current, key) => (current as Record<string | number, unknown>)[key], value);
      expect(opened.warnings).toEqual([expect.objectContaining({ code: "NATIVE_CHEMISTRY_ENUM_FALLBACK",
        path: ["pages", 0, "objects", 0, ...suffix], originalValue: at(object) })]);
      expect(at(opened.document.pages[0]!.objects[0])).toBe("unknown");
      const saved = JSON.parse(serializeDocument(opened.document));
      expect(saved.pages[0].objects[0]).toMatchObject(object);
      expect(at(readDocument(saved).document.pages[0]!.objects[0])).toBe("unknown");
    }
  });

  it.each([undefined, "1.3.0"])("still refuses unknown reaction roles and malformed enum types with version %s", version => {
    const base = { x: 0, y: 0, width: 30, height: 30, rotation: 0, style: {} };
    const point = { kind: "point", point: { x: 0, y: 0 } };
    const molecule = plainDocument().pages[0]!.objects[0] as MoleculeObject;
    const objects = [
      { ...molecule, structureFormat: 17 },
      { ...molecule, bonds: [{ ...molecule.bonds[0], order: null }] },
      { ...molecule, superatoms: [{ label: "Me", expandedStructureFormat: [] }] },
      { ...base, id: "r", type: "reaction", components: [], mappingState: false },
      { ...base, id: "r", type: "reaction", components: [{ objectId: "m", role: "future-role" }] },
      { ...base, id: "a", type: "mechanism-arrow", source: point, target: point, arrowKind: {} },
      { ...base, id: "e", type: "electron-mark", anchor: point, markKind: 3 },
      { ...base, id: "s", type: "superatom", label: "Me", metadata: { label: "Me", expandedStructureFormat: false } }
    ];
    for (const object of objects) {
      const raw = JSON.parse(JSON.stringify(plainDocument()));
      if (version) Object.assign(raw, { formatVersion: version, minAppVersion: version });
      raw.pages[0].objects = [object];
      expect(() => readDocument(raw)).toThrow();
    }
  });

  it.each(["kind", "type", "atomKind"])("refuses an unknown atom %s", (key) => {
    const raw = JSON.parse(JSON.stringify(futureDocument()));
    raw.pages[0].objects[0].atoms[0][key] = "future-atom";
    expect(() => readDocument(raw)).toThrow(/atoms\.0\..*: Unsupported atom kind "future-atom"/);
  });

  it.each(["radicalState", "atomicNumber", "stereochemistry", "isotopeMassNumber", "implicitHydrogenCount", "unfamiliarField"])("refuses unknown chemistry-bearing atom field %s", (key) => {
    const raw = JSON.parse(JSON.stringify(futureDocument()));
    raw.pages[0].objects[0].atoms[0][key] = "future-chemistry";
    expect(() => readDocument(raw)).toThrow(/Unsupported chemistry field.*chemical identity cannot be preserved/);
  });

  it.each([undefined, "1.3.0"])("fails closed for unknown chemistry fields with version %s", (version) => {
    const cases = [
      { path: ["atoms", 0, "isotopeMassNumber"], value: 13 },
      { path: ["atoms", 0, "implicitHydrogenCount"], value: 2 },
      { path: ["bonds", 0, "cisTrans"], value: "cis" },
      { path: ["bonds", 0, "display"], value: { cisTrans: "cis" }, suffix: ["cisTrans"] },
      { path: ["chemistry"], value: { futureStereo: { chirality: "R" } }, suffix: ["futureStereo"] },
      { path: ["sGroups"], value: [{ polymerKind: "future" }] },
      { path: ["rGroups"], value: [{ label: "R1", futureLogic: true }], suffix: [0, "futureLogic"] },
      { path: ["superatoms"], value: [{ label: "Me", futureCharge: 1 }], suffix: [0, "futureCharge"] }
    ];
    for (const { path, value, suffix = [] } of cases) {
      const raw = JSON.parse(JSON.stringify(plainDocument()));
      if (version) Object.assign(raw, { formatVersion: version, minAppVersion: version });
      const molecule = raw.pages[0].objects[0];
      let target = molecule;
      for (const key of path.slice(0, -1)) target = target[key];
      target[path.at(-1)!] = value;
      try {
        readDocument(raw);
        expect.fail(`Expected refusal for ${path.join(".")}`);
      } catch (error) {
        expect(error).toBeInstanceOf(NativeDocumentReadError);
        expect(error).toMatchObject({ code: "NATIVE_UNSUPPORTED_CHEMISTRY", path: ["pages", 0, "objects", 0, ...path, ...suffix] });
      }
    }
  });

  it("refuses unknown reaction role fields while preserving explicitly visual extensions", () => {
    const raw = JSON.parse(JSON.stringify(futureDocument()));
    raw.pages[0].objects.push({ id: "reaction", type: "reaction", x: 0, y: 0, width: 30, height: 30, rotation: 0,
      style: {}, components: [{ objectId: "molecule", role: "reactant", futureRole: "catalyst" }] });
    expect(() => readDocument(raw)).toThrow(/components\.0\.futureRole: Unsupported chemistry field/);
    delete raw.pages[0].objects[1].components[0].futureRole;
    raw.ignorableFields = ["pages.*.objects.*[type=reaction].components.*.visualDecoration"];
    raw.pages[0].objects[1].components[0].visualDecoration = { color: "red" };
    expect(JSON.parse(serializeDocument(readDocument(raw).document)).pages[0].objects[1].components[0])
      .toMatchObject({ role: "reactant", visualDecoration: { color: "red" } });
  });

  it("strict schemas never silently convert a chemical bond order, even outside the file reader", () => {
    expect(() => MoleculeBondSchema.parse({ id: "b", fromAtomId: "a", toAtomId: "c", order: "quadruple" })).toThrow();
  });

  it.each(["atomType", "coordinates", "bondStyle", "pageLayout", "version", "objectType"])("rejects malformed %s even with newer version metadata", (problem) => {
    const raw = JSON.parse(JSON.stringify(futureDocument()));
    const molecule = raw.pages[0].objects[0];
    if (problem === "atomType") molecule.atoms[0].element = 6;
    if (problem === "coordinates") molecule.atoms[0].x = "0";
    if (problem === "bondStyle") molecule.bonds[0].display = { bondStyle: 42 };
    if (problem === "pageLayout") raw.pages[0].layout.widthPx = 1;
    if (problem === "version") raw.minAppVersion = 13;
    if (problem === "objectType") molecule.type = "unknown-chemical-object";
    expect(() => readDocument(raw)).toThrow();
  });

  it("requires a newer version declaration before tolerating unknown input", () => {
    const raw = { ...plainDocument(), futureField: true };
    expect(() => readDocument(raw)).toThrow(/saved by a newer version/);
  });

  it("refuses an overflowing JSON number instead of silently changing preserved data to null", () => {
    const raw = { ...futureDocument(), futureNumber: "overflow" };
    const contents = JSON.stringify(raw).replace('"futureNumber":"overflow"', '"futureNumber":1e999');
    expect(() => readSerializedDocument(contents)).toThrow(/Native JSON numbers must be finite/);
  });

  it("does not expose a file-provided preservation sidecar as trusted internal state", () => {
    const raw = JSON.parse(JSON.stringify(futureDocument()));
    raw.compatibility.nativeExtensions = [{ kind: "field", path: ["title"], originalValue: "Injected" }];
    const result = readDocument(raw);
    expect(result.document.title).toBe("Untitled");
    expect(JSON.parse(serializeDocument(result.document))).toEqual(raw);
    delete raw.minAppVersion;
    delete raw.formatVersion;
    expect(() => readDocument(raw)).toThrow(/reserved for in-memory/);
  });

  it("preserves hostile-looking JSON keys as data without traversing or changing prototypes", () => {
    const raw = JSON.parse(JSON.stringify(futureDocument()));
    raw.pages[0].objects = [{ id: "text", type: "text", x: 0, y: 0, width: 20, height: 20, rotation: 0, style: {}, text: "safe", spans: [] }];
    Object.defineProperty(raw.pages[0].objects[0], "__proto__", { value: { future: "safe" }, enumerable: true });
    Object.defineProperty(raw.styles, "__proto__", { value: { future: "also safe" }, enumerable: true });
    const result = readDocument(raw);
    const saved = JSON.parse(serializeDocument(result.document));
    expect(Object.hasOwn(saved.pages[0].objects[0], "__proto__")).toBe(true);
    expect(saved.pages[0].objects[0].__proto__).toEqual({ future: "safe" });
    expect(Object.hasOwn(saved.styles, "__proto__")).toBe(true);
    expect(saved.styles.__proto__).toEqual({ future: "also safe" });
    expect(Object.hasOwn({}, "future")).toBe(false);
  });
});
