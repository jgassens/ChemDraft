import { applyPatch, createEmptyDocument, DocumentObjectSchema, type BondRef, type CrossingOverride, type DocumentPatch } from "@chemdraft/chem-core";
import type { PluginCommandContext } from "@chemdraft/plugin-api";
import { describe, expect, it, vi } from "vitest";
import { PluginHost, type PluginPatchApplicationRequest } from "./index";

const molecule = (id: string, bondId = "bond") => DocumentObjectSchema.parse({
  id, type: "molecule", x: 50, y: 50, width: 30, height: 30,
  structureFormat: "smiles", structure: "CC",
  atoms: [{ id: "a", element: "C", x: 50, y: 50 }, { id: "b", element: "C", x: 80, y: 80 }],
  bonds: [{ id: bondId, fromAtomId: "a", toAtomId: "b", order: "single" }]
});
const bonds: [BondRef, BondRef] = [{ objectId: "first", bondId: "bond" }, { objectId: "second", bondId: "bond" }];
function fixture(initialRefs: readonly BondRef[] = bonds, initialCrossings: CrossingOverride[] = []) {
  let document = createEmptyDocument();
  const pageId = document.pages[0]!.id;
  document = applyPatch(document, { op: "batch", patches: initialRefs.map(ref => ({ op: "addObject", pageId, object: molecule(ref.objectId, ref.bondId) })) });
  for (const crossing of initialCrossings) document = applyPatch(document, { op: "setCrossingOverride", pageId, crossing });
  const before = structuredClone(document);
  let context!: PluginCommandContext;
  let release!: () => void;
  const apply = vi.fn((application: PluginPatchApplicationRequest) => {
    document = applyPatch(document, application.patch.patch);
    return { applied: true as const, objectIds: ["first", "second"] };
  });
  const getActiveDocument = vi.fn((): typeof document | undefined => document);
  const host = new PluginHost({ getActiveDocument, applyDocumentPatch: apply });
  const pluginId = "org.test.crossings";
  host.registerPlugin({ id: pluginId, name: "Crossings", version: "0.0.1", apiVersion: "^0.1.14", entry: "plugin.js",
    permissions: ["document.write"], contributes: { commands: [{ id: "plugin.crossings.run", title: "Run" }] }
  }, { commandHandlers: { "plugin.crossings.run": ctx => {
    context = ctx;
    return new Promise<void>(resolve => { release = resolve; });
  } } });
  const pending = host.invokeCommand("plugin.crossings.run");
  const patch = (op: "setCrossingOverride" | "clearCrossingOverride"): DocumentPatch => op === "setCrossingOverride"
    ? { op, pageId, crossing: { bonds, front: bonds[0] } } : { op, pageId, bonds };
  const write = (patch: DocumentPatch, objectIds = ["first", "second"], assistantTransactionId: string | undefined = "request") =>
    host.applyPatchForPlugin(pluginId, undefined, { patch, reason: "Crossing", requiresUserApproval: true },
      { objectIds, assistantTransactionId, apply });
  return { host, before, pageId, apply, patch, write, getActiveDocument, document: () => document,
    context: () => context, finish: async () => { release(); await pending; } };
}

describe("assistant crossing write scope", () => {
  it.each([false, true])("sets and clears in-scope crossings in the transaction (batch: %s)", async batch => {
    const s = fixture();
    try {
      const wrap = (patch: DocumentPatch): DocumentPatch => batch ? { op: "batch", patches: [patch] } : patch;
      await s.write(wrap(s.patch("setCrossingOverride")));
      expect(s.document().pages[0]!.crossings).toEqual([{ bonds, front: bonds[0] }]);
      await s.write(wrap(s.patch("clearCrossingOverride")));
      expect(s.document().pages[0]!.crossings).toEqual([]);
      expect(s.apply).toHaveBeenCalledTimes(2);
    } finally { await s.finish(); }
  });

  for (const op of ["setCrossingOverride", "clearCrossingOverride"] as const) {
    it.each(["first", "second"])(`${op} refuses either out-of-scope owner (%s), atomically`, async outside => {
      const s = fixture();
      try {
        const patch: DocumentPatch = { op: "batch", patches: [
          { op: "addObject", pageId: s.pageId, object: molecule("new") }, s.patch(op)
        ] };
        await expect(s.write(patch, bonds.map(ref => ref.objectId).filter(id => id !== outside))).rejects.toThrow(`${outside} was not selected`);
        expect(s.apply).not.toHaveBeenCalled();
        expect(s.document()).toEqual(s.before);
        await expect(s.write({ op: "removeObject", objectId: "new" }, [])).rejects.toThrow("new was not selected");
      } finally { await s.finish(); }
    });

    it(`${op} cannot overwrite or delete an outside crossing through delimiter aliases`, async () => {
      const scoped: [BondRef, BondRef] = [{ objectId: "a", bondId: "x::b" }, { objectId: "c", bondId: "d" }];
      const outside = { objectId: "a::x", bondId: "b" };
      const existing: CrossingOverride = { bonds: [outside, scoped[1]], front: outside, clearancePx: 7 };
      const s = fixture([...scoped, outside], [existing]);
      try {
        const patch: DocumentPatch = op === "setCrossingOverride"
          ? { op, pageId: s.pageId, crossing: { bonds: scoped, front: scoped[0] } }
          : { op, pageId: s.pageId, bonds: scoped };
        await s.write(patch, ["a", "c"]);
        expect(s.document().pages[0]!.crossings).toContainEqual(existing);
        expect(s.document().pages[0]!.crossings).toHaveLength(op === "setCrossingOverride" ? 2 : 1);
        expect(s.document().pages[0]!.objects).toEqual(s.before.pages[0]!.objects);
      } finally { await s.finish(); }
    });

    it(`${op} refuses an existing outside crossing before applying any part of a batch`, async () => {
      const existing: CrossingOverride = { bonds, front: bonds[0] };
      const s = fixture(bonds, [existing]);
      try {
        await expect(s.write({ op: "batch", patches: [
          { op: "addObject", pageId: s.pageId, object: molecule("new") }, s.patch(op)
        ] }, ["first"])).rejects.toThrow("second was not selected");
        expect(s.apply).not.toHaveBeenCalled();
        expect(s.document()).toEqual(s.before);
      } finally { await s.finish(); }
    });

    it(`${op} refuses writes when existing crossing owners cannot be checked`, async () => {
      const s = fixture();
      try {
        s.getActiveDocument.mockReturnValue(undefined);
        await expect(s.write(s.patch(op))).rejects.toThrow("without an active document");
        expect(s.apply).not.toHaveBeenCalled();
        expect(s.document()).toEqual(s.before);
      } finally { await s.finish(); }
    });

    it(`${op} refuses ordinary command writes, unattested host writes, and writes after the command ends`, async () => {
      const s = fixture();
      try {
        await expect(s.context().documents.applyPatch!({ patch: s.patch(op), reason: "Ordinary command" })).rejects.toThrow("assistant request transaction");
        await expect(s.write(s.patch(op), undefined, "")).rejects.toThrow("assistant request transaction");
        await s.finish();
        await expect(s.write(s.patch(op))).rejects.toThrow("own commands");
        expect(s.apply).not.toHaveBeenCalled();
      } finally { await s.finish(); }
    });
  }

  it("checks existing crossing owners in the request's own document, not the active tab's", async () => {
    const existing: CrossingOverride = { bonds, front: bonds[0] };
    const s = fixture(bonds, [existing]);
    try {
      const requestDocument = s.document();
      s.getActiveDocument.mockReturnValue(createEmptyDocument());
      s.getActiveDocument.mockClear();
      const write = (getDocument: () => typeof requestDocument | undefined) => s.host.applyPatchForPlugin("org.test.crossings", undefined,
        { patch: s.patch("clearCrossingOverride"), reason: "Crossing", requiresUserApproval: true },
        { objectIds: ["first"], assistantTransactionId: "request", getDocument, apply: s.apply });
      await expect(write(() => requestDocument)).rejects.toThrow("second was not selected");
      await expect(write(() => undefined)).rejects.toThrow("without an active document");
      expect(s.getActiveDocument).not.toHaveBeenCalled();
      expect(s.apply).not.toHaveBeenCalled();
      expect(s.document()).toEqual(s.before);
    } finally { await s.finish(); }
  });

  it("admits earlier batch insertions but refuses a crossing preceding its insertion", async () => {
    const s = fixture();
    try {
      const refs: [BondRef, BondRef] = [bonds[0], { objectId: "new", bondId: "bond" }];
      const addition: DocumentPatch = { op: "addObject", pageId: s.pageId, object: molecule("new") };
      const crossing: DocumentPatch = { op: "setCrossingOverride", pageId: s.pageId, crossing: { bonds: refs, front: refs[1] } };
      await expect(s.write({ op: "batch", patches: [crossing, addition] }, ["first"])).rejects.toThrow("new was not selected");
      expect(s.document()).toEqual(s.before);
      await s.write({ op: "batch", patches: [addition, crossing] }, ["first"]);
      expect(s.document().pages[0]!.crossings).toEqual([{ bonds: refs, front: refs[1] }]);
      expect(s.apply).toHaveBeenCalledOnce();
    } finally { await s.finish(); }
  });

  it.each([
    { op: "setCrossingOverride", crossing: { bonds: [bonds[0]], front: bonds[0] } },
    { op: "setCrossingOverride", crossing: { bonds, front: { objectId: "third", bondId: "bond" } } },
    { op: "setCrossingOverride", crossing: {
      bonds: [{ objectId: "a", bondId: "x::b" }, { objectId: "c", bondId: "d" }],
      front: { objectId: "a::x", bondId: "b" }
    } },
    { op: "clearCrossingOverride", bonds: [bonds[0], bonds[0]] },
    { op: "clearCrossingOverride" }
  ])("refuses malformed crossing references before the transaction sink (%j)", async malformed => {
    const s = fixture();
    try {
      await expect(s.write({ op: "batch", patches: [
        { op: "addObject", pageId: s.pageId, object: molecule("new") },
        { ...malformed, pageId: s.pageId } as DocumentPatch
      ] })).rejects.toThrow(`Invalid ${malformed.op} patch`);
      expect(s.apply).not.toHaveBeenCalled();
      expect(s.document()).toEqual(s.before);
    } finally { await s.finish(); }
  });
});
