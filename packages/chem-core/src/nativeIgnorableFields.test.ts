import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ChemDraftDocumentSchema as Released111DocumentSchema } from "./__fixtures__/v1.1.1/schemas";
import { createEmptyDocument, parseDocument, readDocument, serializeDocumentWithWarnings } from "./document";
import { ignorableFieldsForNativeFeatures, minimumVersionForNativeFeatures, type NativeDocumentFeatureVersion } from "./documentFeatures";
import { NativeDocumentReadError } from "./documentRead";
import type { MoleculeObject, ReactionObject } from "./schemas";

const atomHalo = "pages.*.objects.*[type=molecule].atoms.*.labelHalo";
const roleColor = "pages.*.objects.*[type=reaction].components.*.roleColor";
const base = { x: 0, y: 0, width: 30, height: 30, rotation: 0, style: {} };

function futureFile() {
  const raw = JSON.parse(JSON.stringify(createEmptyDocument()));
  Object.assign(raw, { formatVersion: "1.3.0", minAppVersion: "1.3.0", ignorableFields: [atomHalo] });
  raw.pages[0].objects.push({ ...base, id: "m", type: "molecule", structureFormat: "smiles", structure: "CO",
    atoms: [{ id: "c", element: "C", x: 0, y: 0, formalCharge: 0, labelHalo: { color: "blue", radius: 3 } },
      { id: "o", element: "O", x: 22, y: 0, formalCharge: 0 }],
    bonds: [{ id: "b", fromAtomId: "c", toAtomId: "o", order: "single" }], superatoms: [], rGroups: [] });
  return raw;
}

afterEach(() => vi.restoreAllMocks());

describe("self-described ignorable fields", () => {
  it("opens a synthetic 1.3 display-only atom addition, excludes it from the active model and round-trips it", () => {
    const raw = futureFile();
    const read = readDocument(raw);
    expect(read).toMatchObject({ formatVersion: "1.3.0", minAppVersion: "1.3.0" });
    expect(read.warnings).toEqual([expect.objectContaining({ code: "NATIVE_UNKNOWN_FIELD_PRESERVED",
      path: ["pages", 0, "objects", 0, "atoms", 0, "labelHalo"], originalValue: { color: "blue", radius: 3 } })]);
    expect((read.document.pages[0]!.objects[0] as MoleculeObject).atoms[0]).not.toHaveProperty("labelHalo");
    expect(parseDocument(read.document)).toEqual(read.document);
    const saved = serializeDocumentWithWarnings(read.document);
    expect(saved.warnings).toEqual([]);
    expect(JSON.parse(saved.contents)).toEqual(raw);
    expect(JSON.parse(serializeDocumentWithWarnings(readDocument(JSON.parse(saved.contents)).document).contents)).toEqual(raw);
  });

  it.each([undefined, [], ["pages.*.objects.*[type=reaction].atoms.*.labelHalo"],
    ["pages.*.objects.*[type=molecule].atoms.*.labelHalo.color"]])("refuses the same unknown atom field without a matching declaration: %j", patterns => {
    const raw = futureFile();
    raw.ignorableFields = patterns;
    expect(() => readDocument(raw)).toThrow(expect.objectContaining({ code: "NATIVE_UNSUPPORTED_CHEMISTRY",
      path: ["pages", 0, "objects", 0, "atoms", 0, "labelHalo"], originalValue: { color: "blue", radius: 3 } }));
    expect(() => readDocument(raw)).toThrow(/not declared in ignorableFields/);
  });

  it("requires a declaration even for the formerly special visualDecoration name", () => {
    const raw = futureFile();
    delete raw.pages[0].objects[0].atoms[0].labelHalo;
    raw.pages[0].objects[0].atoms[0].visualDecoration = true;
    expect(() => readDocument(raw)).toThrow(/Unsupported chemistry field "visualDecoration"/);
  });

  it.each(["atoms.*.formalCharge", "atoms.*.isotope", "atoms.*.labelLiteral", "atoms.*.labelBondSide.side",
    "bonds.*.order", "bonds.*.stereo", "structure", "atoms", "chemistry.totalCharge"])("rejects a header declaring known chemistry ignorable: %s", field => {
    const raw = futureFile();
    raw.ignorableFields = [`pages.*.objects.*[type=molecule].${field}`];
    expect(() => readDocument(raw)).toThrow(expect.objectContaining({ code: "NATIVE_INVALID_DOCUMENT",
      path: ["ignorableFields", 0], originalValue: raw.ignorableFields[0] }));
    expect(() => readDocument(raw)).toThrow(/Malformed ignorableFields header: known field/);
  });

  it.each(["pages.*.objects.*.atoms.*.formalCharge", "pages.*.objects.*[type=reaction].components.*.role",
    "formatVersion", "ignorableFields", "compatibility.nativeExtensions"])("rejects protected declarations even without a matching object/field in the payload: %s", pattern => {
    const raw = { ...createEmptyDocument(), formatVersion: "1.3.0", ignorableFields: [pattern] };
    expect(() => readDocument(raw)).toThrow(/Malformed ignorableFields header: known field/);
  });

  it.each([null, "not-an-array", [1], [""], ["pages..objects"], ["pages.**.labelHalo"],
    ["pages.*.objects.*.atoms.*"], ["pages.0.objects.0.labelHalo"], ["pages[].objects[molecule].labelHalo"]])("rejects malformed pattern syntax: %j", ignorableFields => {
    expect(() => readDocument({ ...createEmptyDocument(), formatVersion: "1.3.0", ignorableFields }))
      .toThrow(/Malformed ignorableFields header/);
  });

  it("accepts omitted discriminators but never treats * as an object-field wildcard", () => {
    const raw = futureFile();
    raw.ignorableFields = ["pages.*.objects.*.atoms.*.labelHalo"];
    expect(readDocument(raw).warnings).toHaveLength(1);
    raw.ignorableFields = ["pages.*.objects.*.*.labelHalo"];
    expect(() => readDocument(raw)).toThrow(/Unsupported chemistry field "labelHalo"/);
  });

  it("does not use the header to repair malformed known fields", () => {
    const raw = futureFile();
    raw.pages[0].objects[0].atoms[0].element = 6;
    expect(() => readDocument(raw)).toThrow(NativeDocumentReadError);
  });

  it("drops unused declarations and omits all headers once no post-1.1.1 feature remains", () => {
    const raw = futureFile();
    raw.ignorableFields.push("pages.*.objects.*[type=molecule].unusedDecoration");
    const read = readDocument(raw);
    expect(JSON.parse(serializeDocumentWithWarnings(read.document).contents).ignorableFields).toEqual([atomHalo]);
    read.document.pages[0]!.objects = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const plain = JSON.parse(serializeDocumentWithWarnings(read.document).contents);
    for (const field of ["formatVersion", "minAppVersion", "ignorableFields"]) expect(plain).not.toHaveProperty(field);
    expect(Released111DocumentSchema.safeParse(plain).success).toBe(true);
  });

  it.each(["insert", "delete", "reorder"])("retains atom display data by identity after %s", edit => {
    const read = readDocument(futureFile());
    const molecule = read.document.pages[0]!.objects[0] as MoleculeObject;
    if (edit === "insert") molecule.atoms.unshift({ id: "n", element: "N", x: -22, y: 0, formalCharge: 0 });
    if (edit === "delete") molecule.atoms.splice(0, 1);
    if (edit === "reorder") molecule.atoms.reverse();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const saved = JSON.parse(serializeDocumentWithWarnings(parseDocument(read.document)).contents);
    const atoms = saved.pages[0].objects[0].atoms;
    expect(atoms.find((atom: { id: string }) => atom.id === "c")?.labelHalo)
      .toEqual(edit === "delete" ? undefined : { color: "blue", radius: 3 });
    expect(atoms.filter((atom: { id: string }) => atom.id !== "c").every((atom: object) => !Object.hasOwn(atom, "labelHalo"))).toBe(true);
    expect(saved.ignorableFields).toEqual(edit === "delete" ? undefined : [atomHalo]);
  });

  it.each(["insert", "delete", "reorder", "edit"])("drops listed reaction-component display data after an identity-free array %s", edit => {
    const raw = futureFile();
    raw.ignorableFields = [roleColor];
    raw.pages[0].objects = [{ ...base, id: "r", type: "reaction", components: [
      { objectId: "a", role: "reactant", roleColor: "red" }, { objectId: "b", role: "product", roleColor: "blue" }
    ], mappingState: "unknown", conditionsTextObjectIds: [] }];
    const read = readDocument(raw);
    expect(JSON.parse(serializeDocumentWithWarnings(read.document).contents).pages[0].objects[0]).toEqual(raw.pages[0].objects[0]);
    const components = (read.document.pages[0]!.objects[0] as ReactionObject).components;
    if (edit === "insert") components.unshift({ objectId: "new", role: "agent" });
    if (edit === "delete") components.splice(0, 1);
    if (edit === "reorder") components.reverse();
    if (edit === "edit") components[0]!.role = "agent";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const saved = serializeDocumentWithWarnings(parseDocument(read.document));
    expect(saved.warnings).toEqual([expect.objectContaining({ code: "NATIVE_EXTENSION_DATA_DROPPED" })]);
    expect(saved.contents).not.toContain("roleColor");
    expect(JSON.parse(saved.contents)).not.toHaveProperty("ignorableFields");
  });
});

describe("feature safety declarations", () => {
  it("derives the header from only registered, present, display-only feature fields", () => {
    const schema = z.object({ halo: z.string().optional(), charge: z.number().optional(),
      style: z.enum(["plain", "future"]).optional() });
    const registry: Record<string, NativeDocumentFeatureVersion> = {
      "field:halo": { introducedIn: "1.3.0", kind: "feature", ignorable: true },
      "field:charge": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
      'value:style="future"': { introducedIn: "1.3.0", kind: "feature", ignorable: true }
    };
    expect(ignorableFieldsForNativeFeatures({}, registry)).toEqual([]);
    expect(ignorableFieldsForNativeFeatures({ charge: 1, style: "future" }, registry)).toEqual([]);
    expect(ignorableFieldsForNativeFeatures({ halo: "blue", charge: 1 }, registry)).toEqual(["halo"]);
    expect(minimumVersionForNativeFeatures(schema, { halo: "blue" }, registry)).toBe("1.3.0");
    expect(minimumVersionForNativeFeatures(schema, { charge: 1 }, registry)).toBe("1.2.0");
  });

  it("rejects a registered addition that omits its safety declaration", () => {
    const undeclared = { "field:halo": { introducedIn: "1.3.0", kind: "feature" } };
    expect(() => minimumVersionForNativeFeatures(z.object({ halo: z.string().optional() }), {},
      undeclared as unknown as Record<string, NativeDocumentFeatureVersion>)).toThrow(/must declare ignorable: field:halo/);
  });
});
