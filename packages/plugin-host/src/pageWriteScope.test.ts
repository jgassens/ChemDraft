import { applyPatch, createEmptyDocument, type ChemDraftDocument, type CrossingOverride,
  type DocumentPage, type MoleculeObject } from "@chemdraft/chem-core";
import { ProposedDocumentPatchSchema } from "@chemdraft/plugin-api";
import { describe, expect, it } from "vitest";
import { assertPluginDocumentWriteScope, assertPluginPatchWriteScope } from "./index";

const molecule = (id: string): MoleculeObject => ({ id, type: "molecule", structureFormat: "smiles", structure: "CC",
  atoms: [0, 1].map(i => ({ id: `a${i}`, element: "C", formalCharge: 0, x: 100 + i * 22, y: 100 })),
  bonds: [{ id: "bond", fromAtomId: "a0", toAtomId: "a1", order: "single" }],
  superatoms: [], rGroups: [], x: 92, y: 92, width: 38, height: 16, rotation: 0, style: {} });
const ref = (objectId: string) => ({ objectId, bondId: "bond" });
const crossing = (left = "selected", right = "protected"): CrossingOverride => ({
  bonds: [ref(left), ref(right)], front: ref(left)
});
function fixture(withCrossing = true) {
  const drawing = createEmptyDocument();
  drawing.pages[0]!.objects = [molecule("selected"), molecule("protected")];
  const pageId = drawing.pages[0]!.id;
  const before = withCrossing ? applyPatch(drawing, { op: "setCrossingOverride", pageId, crossing: crossing() }) : drawing;
  const proposed = ProposedDocumentPatchSchema.parse({ reason: "Move selected molecule", patch: {
    op: "updateObject", objectId: "selected", changes: { x: 150 }
  } });
  return { before, proposed, after: applyPatch(before, proposed.patch) };
}
const page = (document: ChemDraftDocument, changes: Partial<DocumentPage>): ChemDraftDocument =>
  ({ ...document, pages: [{ ...document.pages[0]!, ...changes }] });

describe("plugin page write scope", () => {
  it.each(["preflight", "final"] as const)("%s refuses pruning a crossing shared with an unselected molecule", guard => {
    const { before } = fixture();
    const proposed = ProposedDocumentPatchSchema.parse({ reason: "Delete selected bonds", patch: {
      op: "updateObject", objectId: "selected", changes: { bonds: [] }
    } });
    const after = applyPatch(before, proposed.patch);
    expect(before.pages[0]!.crossings).toHaveLength(1);
    expect(after.pages[0]!.crossings).toHaveLength(0);
    expect(() => guard === "preflight" ? assertPluginPatchWriteScope(before, proposed, ["selected"])
      : assertPluginDocumentWriteScope(before, after, proposed, ["selected"]))
      .toThrow(/Plugin write refused: crossing.*protected.*not selected/);
  });

  it.each(["add", "remove", "front", "clearance", "references"] as const)("refuses a final protected crossing %s", change => {
    const f = fixture(change !== "add");
    const original = f.before.pages[0]!.crossings[0] ?? crossing();
    const updated: CrossingOverride = change === "front" ? { ...original, front: ref("protected") }
      : change === "clearance" ? { ...original, clearancePx: 12 }
      : change === "references" ? { ...original, bonds: [ref("selected"), { ...ref("protected"), bondId: "other-bond" }] } : original;
    expect(() => assertPluginDocumentWriteScope(f.before, page(f.after, {
      crossings: change === "remove" ? [] : [updated]
    }), f.proposed, ["selected"]))
      .toThrow(/Plugin write refused: crossing.*protected.*not selected/);
  });

  it("allows removal, addition and edits of crossings when every referenced object is selected", () => {
    const f = fixture();
    for (const crossings of [[], [crossing()], [{ ...crossing(), front: ref("protected"), clearancePx: 12 }]]) {
      expect(() => assertPluginDocumentWriteScope(f.before, page(f.after, { crossings }), f.proposed,
        ["selected", "protected"])).not.toThrow();
    }
    const deletion = ProposedDocumentPatchSchema.parse({ reason: "Delete selected bonds", patch: {
      op: "updateObject", objectId: "selected", changes: { bonds: [] }
    } });
    expect(() => assertPluginPatchWriteScope(f.before, deletion, ["selected", "protected"])).not.toThrow();
  });

  it("allows crossings between selected objects and this command's rebased insertions", () => {
    const f = fixture(false);
    const proposed = ProposedDocumentPatchSchema.parse({ reason: "Insert molecule", patch: {
      op: "addObject", pageId: f.before.pages[0]!.id, object: molecule("inserted")
    } });
    const after = applyPatch(applyPatch(f.before, proposed.patch), { op: "setCrossingOverride",
      pageId: f.before.pages[0]!.id, crossing: crossing("selected", "inserted") });
    expect(() => assertPluginDocumentWriteScope(f.before, after, proposed, ["selected"])).not.toThrow();
    expect(() => assertPluginDocumentWriteScope(f.before, page(after, {
      crossings: [crossing("protected", "inserted")]
    }), proposed, ["selected"])).toThrow(/Plugin write refused: crossing.*protected.*not selected/);
  });

  it("protects crossing order and duplicate occurrences because the first matching override wins", () => {
    const f = fixture();
    const first = crossing(), second = { ...crossing(), clearancePx: 12 };
    const before = page(f.before, { crossings: [first, second] });
    expect(() => assertPluginDocumentWriteScope(before, page(f.after, { crossings: [second, first] }),
      f.proposed, ["selected"])).toThrow(/Plugin write refused: crossing.*protected/);
    expect(() => assertPluginDocumentWriteScope(before, page(f.after, { crossings: [second, second] }),
      f.proposed, ["selected"])).toThrow(/Plugin write refused: crossing.*protected/);
  });

  // Exhaustive at compile time: new Page fields must receive an explicit test and policy.
  const shellChanges = {
    id: "changed-page", width: 1234, height: 1234, margin: { top: 1, right: 2, bottom: 3, left: 4 },
    layout: { ...createEmptyDocument().pages[0]!.layout, orientation: "landscape" as const },
    compatibility: { sourceFormat: "cdxml" as const }
  } satisfies Record<Exclude<keyof DocumentPage, "objects" | "crossings">, unknown>;
  it.each(Object.entries(shellChanges))("protects page %s even when every object is in scope", (key, value) => {
    const f = fixture();
    expect(() => assertPluginDocumentWriteScope(f.before, page(f.after, { [key]: value }), f.proposed,
      ["selected", "protected"])).toThrow(new RegExp(`Plugin write refused: page.*${key}`));
  });

  it("protects page additions, removals and order", () => {
    const f = fixture();
    const extra = { ...f.before.pages[0]!, id: "second-page", objects: [], crossings: [] };
    const before = { ...f.before, pages: [...f.before.pages, extra] };
    for (const pages of [[...before.pages, { ...extra, id: "third-page" }], [before.pages[0]!], [...before.pages].reverse()]) {
      expect(() => assertPluginDocumentWriteScope(before, { ...before, pages }, f.proposed,
        ["selected", "protected"])).toThrow(/Plugin write refused: page/);
    }
  });

  it("compares resized page fields against the supplied page-fit baseline", () => {
    const f = fixture();
    const fitted = applyPatch(f.before, { op: "updatePageLayout", pageId: f.before.pages[0]!.id,
      layout: { ...f.before.pages[0]!.layout, presetId: "custom", widthPx: 1234, heightPx: 1234 } });
    const after = applyPatch(fitted, f.proposed.patch);
    expect(() => assertPluginDocumentWriteScope(fitted, after, f.proposed, ["selected"])).not.toThrow();
    expect(() => assertPluginDocumentWriteScope(f.before, after, f.proposed, ["selected"])).toThrow(/Plugin write refused: page.*width/);
  });
});
