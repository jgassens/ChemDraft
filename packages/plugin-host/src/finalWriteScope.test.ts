import { applyPatch, createEmptyDocument, type ChemDraftDocument, type DocumentObject } from "@chemdraft/chem-core";
import { ProposedDocumentPatchSchema } from "@chemdraft/plugin-api";
import { describe, expect, it } from "vitest";
import { assertPluginDocumentWriteScope, rebasePluginPatch } from "./index";

const text = (id: string, value = id): DocumentObject => ({ id, type: "text", text: value, spans: [],
  x: 100, y: 100, width: 60, height: 20, rotation: 0, style: {} });
function fixture() {
  const before = createEmptyDocument();
  before.pages[0]!.objects = [text("protected"), text("selected")];
  const proposed = ProposedDocumentPatchSchema.parse({ reason: "Insert text", patch: {
    op: "addObject", pageId: before.pages[0]!.id, object: text("inserted")
  } });
  const after = applyPatch(before, proposed.patch);
  return { before, after, proposed, check: (final: ChemDraftDocument, scope = ["selected"]) =>
    assertPluginDocumentWriteScope(before, final, proposed, scope) };
}
const objects = (document: ChemDraftDocument, values: DocumentObject[]): ChemDraftDocument =>
  ({ ...document, pages: [{ ...document.pages[0]!, objects: values }] });

describe("final plugin document write scope", () => {
  it("allows patch insertions and selected edits, ignoring key insertion order", () => {
    const f = fixture();
    const protectedObject = Object.fromEntries(Object.entries(f.after.pages[0]!.objects[0]!).reverse()) as DocumentObject;
    expect(() => f.check(objects(f.after, [protectedObject, text("selected", "Edited"), text("inserted", "Normalized")]))).not.toThrow();
  });

  it.each([
    { text: "Changed" }, { x: 123 }, { style: { color: "#ff0000" } }
  ])("rejects an out-of-scope final object change %j", changes => {
    const f = fixture();
    expect(() => f.check(objects(f.after, f.after.pages[0]!.objects.map(object => object.id === "protected"
      ? { ...object, ...changes } as DocumentObject : object)))).toThrow(/Plugin write refused: text "protected" was changed/);
  });

  it("rejects removal and derived additions, including an extra occurrence of an existing id", () => {
    const f = fixture();
    expect(() => f.check(objects(f.after, f.after.pages[0]!.objects.slice(1)))).toThrow('text "protected" was removed');
    for (const id of ["derived", "protected"]) {
      expect(() => f.check(objects(f.after, [...f.after.pages[0]!.objects, text(id)]))).toThrow(`text "${id}" was added outside`);
    }
  });

  it("rejects moving an unchanged protected object to another page", () => {
    const f = fixture();
    const [protectedObject, ...rest] = f.after.pages[0]!.objects;
    expect(() => f.check({ ...f.after, pages: [{ ...f.after.pages[0]!, objects: rest },
      { ...f.after.pages[0]!, id: "another-page", objects: [protectedObject!] }] })).toThrow('text "protected" was moved to another page');
  });

  it.each(["edit", "remove"] as const)("does not hide a duplicate id's first %s behind an unchanged last occurrence", operation => {
    const f = fixture();
    const first = text("duplicate", "First"), second = text("duplicate", "Second");
    const before = objects(f.before, [first, second]);
    const after = objects(before, operation === "edit" ? [text("duplicate", "Changed"), second] : [second]);
    expect(() => assertPluginDocumentWriteScope(before, after, f.proposed, [])).toThrow(/Plugin write refused: text "duplicate"/);
  });

  it("does not authorize an existing object using an insertion with its id", () => {
    const f = fixture();
    const proposed = ProposedDocumentPatchSchema.parse({ reason: "Colliding insertion", patch: {
      op: "addObject", pageId: f.before.pages[0]!.id, object: text("protected", "New")
    } });
    const rebased = rebasePluginPatch(f.before, proposed);
    const after = applyPatch(f.before, rebased.patch);
    expect(() => assertPluginDocumentWriteScope(f.before, after, proposed, [])).not.toThrow();
    const changed = objects(after, after.pages[0]!.objects.map(object => object.id === "protected" ? text("protected", "Changed") : object));
    expect(() => assertPluginDocumentWriteScope(f.before, changed, proposed, [])).toThrow('text "protected" was changed');
  });

  it("protects every final field, including regenerated bracket chemistry warnings", () => {
    const f = fixture();
    const molecule: DocumentObject = { id: "molecule", type: "molecule", structureFormat: "smiles", structure: "C",
      atoms: [], bonds: [], superatoms: [], rGroups: [], x: 100, y: 100, width: 20, height: 20, rotation: 0, style: {},
      chemistry: { formula: "CH4", averageMass: 16, atomCount: 1, bondCount: 0, totalCharge: 0, isotopeLabels: [], stereochemistry: [], warnings: [] } };
    const before = objects(f.before, [molecule]);
    const after = objects(before, [{ ...molecule, chemistry: { ...molecule.chemistry!, warnings: [
      { code: "chemistry.bracket_multiplier", message: "Context changed" }
    ] } }]);
    expect(() => assertPluginDocumentWriteScope(before, after, f.proposed, [])).toThrow('molecule "molecule" was changed (chemistry)');
  });
});
