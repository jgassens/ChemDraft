import { applyPatch, createEmptyDocument, type DocumentPatch, type DocumentObject } from "@chemdraft/chem-core";
import type { PluginCommandContext, PluginSelectionSnapshot } from "@chemdraft/plugin-api";
import { describe, expect, it, vi } from "vitest";
import { PluginHost, writePatchOps, type PluginPatchApplicationRequest } from "./index";

const now = "2026-10-22T00:00:00.000Z";
const text = (id: string): DocumentObject => ({
  id, type: "text", x: 0, y: 0, width: 10, height: 10, rotation: 0, style: {}, text: id, spans: []
});
const snapshot = (objectIds: string[]): PluginSelectionSnapshot => ({ objectIds, molecules: [] });

function fixture(
  selectedIds: string[],
  run: (context: PluginCommandContext) => unknown | Promise<unknown>,
  getSelection?: () => PluginSelectionSnapshot | Promise<PluginSelectionSnapshot>
) {
  let document = createEmptyDocument({ now });
  const pageId = document.pages[0]!.id;
  document = applyPatch(document, { op: "batch", patches: ["mol_1", "mol_7"].map((id) => ({
    op: "addObject", pageId, object: text(id)
  })) }, { now });
  document = { ...document, selection: { pageId, objectIds: selectedIds } };
  const applyDocumentPatch = vi.fn((request: PluginPatchApplicationRequest) => {
    const patch = request.patch.patch as DocumentPatch;
    document = applyPatch(document, patch, { now });
    const objectIds = writePatchOps(patch).flatMap((op) =>
      op.op === "addObject" ? [op.object.id] : op.op === "addAnnotation" ? [op.annotation.id] : []
    ).filter((id) => document.pages.some((page) => page.objects.some((object) => object.id === id)));
    return { applied: true as const, objectIds };
  });
  const host = new PluginHost({
    getActiveDocument: () => document,
    getSelection: getSelection ?? (() => snapshot(selectedIds)),
    applyDocumentPatch
  });
  host.registerPlugin({
    id: "org.test.scope", name: "Scope", version: "0.0.1", apiVersion: "^0.1.8", entry: "plugin.js",
    permissions: ["document.write"],
    contributes: { commands: [{ id: "plugin.scope.run", title: "Run" }] }
  }, { commandHandlers: { "plugin.scope.run": run } });
  return { host, pageId, applyDocumentPatch, document: () => document };
}

describe("direct-write invocation scope", () => {
  it.each(["addObject", "addAnnotation"])("rejects a malformed %s batch with a validation error before applying anything", async op => {
    const f = fixture([], ctx => ctx.documents.applyPatch!({ reason: "malformed", patch: {
      op: "batch", patches: [
        { op: "addObject", pageId: "page_001", object: text("valid") },
        { op, pageId: "page_001" } as DocumentPatch
      ]
    } }));
    await expect(f.host.invokeCommand("plugin.scope.run")).rejects.toThrow(`Invalid ${op} patch`);
    expect(f.applyDocumentPatch).not.toHaveBeenCalled();
    expect(f.document().pages[0]!.objects).toHaveLength(2);
  });
  const operations: DocumentPatch[] = [
    { op: "updateObject", objectId: "mol_7", changes: { text: "changed" } },
    { op: "removeObject", objectId: "mol_7" },
    { op: "moveObject", objectId: "mol_7", x: 10, y: 20 },
    { op: "setObjectOrder", pageId: "page_001", objectIds: ["mol_7", "mol_1"] }
  ];
  it.each(operations)("allows $op only when every target was selected", async (op) => {
    const f = fixture(["mol_1", "mol_7"], (ctx) => ctx.documents.applyPatch!({
      reason: "selected edit", patch: op.op === "setObjectOrder" ? { ...op, pageId: f.pageId } : op
    }));
    await expect(f.host.invokeCommand("plugin.scope.run")).resolves.toMatchObject({ applied: true });
    expect(f.applyDocumentPatch).toHaveBeenCalledOnce();
    const denied = fixture(["mol_1"], (ctx) => ctx.documents.applyPatch!({ reason: "unselected edit", patch: op }));
    await expect(denied.host.invokeCommand("plugin.scope.run")).rejects.toThrow("mol_7 was not selected when the command started");
    expect(denied.applyDocumentPatch).not.toHaveBeenCalled();
  });

  it("checks every setObjectOrder target in order", async () => {
    const f = fixture(["mol_7"], (ctx) => ctx.documents.applyPatch!({ reason: "order", patch: operations[3]! }));
    await expect(f.host.invokeCommand("plugin.scope.run")).rejects.toThrow("mol_1 was not selected when the command started");
    expect(f.applyDocumentPatch).not.toHaveBeenCalled();
  });

  it("with nothing selected permits insertions and edits of its own accepted insertions", async () => {
    const f = fixture([], async (ctx) => {
      await ctx.documents.applyPatch!({ reason: "add", patch: { op: "addObject", pageId: f.pageId, object: text("new") } });
      await ctx.documents.applyPatch!({ reason: "edit insertion", patch: { op: "updateObject", objectId: "new", changes: { text: "edited" } } });
      await ctx.documents.applyPatch!({ reason: "annotation and move", patch: { op: "batch", patches: [
        { op: "addAnnotation", pageId: f.pageId, annotation: {
          id: "note", type: "annotation", x: 0, y: 0, width: 10, height: 10,
          rotation: 0, style: {}, targetObjectIds: [], message: "note"
        } },
        { op: "moveObject", objectId: "note", x: 1, y: 2 }
      ] } });
      await ctx.documents.applyPatch!({ reason: "remove insertion", patch: { op: "removeObject", objectId: "note" } });
      await expect(ctx.documents.applyPatch!({ reason: "existing", patch: operations[0]! }))
        .rejects.toThrow("mol_7 was not selected when the command started");
    });
    await f.host.invokeCommand("plugin.scope.run");
    expect(f.document().pages[0]!.objects.find((object) => object.id === "new")).toMatchObject({ text: "edited" });
    expect(f.applyDocumentPatch).toHaveBeenCalledTimes(4);
  });

  it("refuses a whole batch and does not grant scope for its rejected insertion", async () => {
    const f = fixture([], async (ctx) => {
      await expect(ctx.documents.applyPatch!({ reason: "atomic", patch: { op: "batch", patches: [
        { op: "addObject", pageId: f.pageId, object: text("new") }, operations[0]!
      ] } })).rejects.toThrow("mol_7 was not selected when the command started");
      await expect(ctx.documents.applyPatch!({ reason: "not inserted", patch: { op: "removeObject", objectId: "new" } }))
        .rejects.toThrow("new was not selected when the command started");
    });
    await f.host.invokeCommand("plugin.scope.run");
    expect(f.applyDocumentPatch).not.toHaveBeenCalled();
    expect(f.document().pages[0]!.objects).toHaveLength(2);
  });

  it("does not grow scope after an application failure, or carry it into another invocation", async () => {
    let first = true;
    const f = fixture([], async (ctx) => {
      if (first) {
        first = false;
        await expect(ctx.documents.applyPatch!({ reason: "bad insertion", patch: {
          op: "addObject", pageId: "missing", object: text("failed")
        } })).rejects.toThrow();
        await expect(ctx.documents.applyPatch!({ reason: "failed id", patch: { op: "removeObject", objectId: "failed" } }))
          .rejects.toThrow("failed was not selected");
        return ctx.documents.applyPatch!({ reason: "add", patch: { op: "addObject", pageId: f.pageId, object: text("new") } });
      }
      return ctx.documents.applyPatch!({ reason: "different invocation", patch: { op: "removeObject", objectId: "new" } });
    });
    await f.host.invokeCommand("plugin.scope.run");
    await expect(f.host.invokeCommand("plugin.scope.run")).rejects.toThrow("new was not selected");
  });

  it.each([false, true])("freezes the initial selection (Send override = %s)", async (override) => {
    const selectedIds = ["mol_1"];
    const getSelection = vi.fn(() => snapshot(selectedIds));
    const f = fixture(selectedIds, async (ctx) => {
      selectedIds.push("mol_7");
      await expect(ctx.documents.applyPatch!({ reason: "later selection", patch: operations[0]! }))
        .rejects.toThrow("mol_7 was not selected");
      return ctx.documents.applyPatch!({ reason: "initial selection", patch: { op: "removeObject", objectId: "mol_1" } });
    }, getSelection);
    await f.host.invokeCommand("plugin.scope.run", override ? { writeSelection: snapshot(["mol_1"]) } : {});
    expect(getSelection).not.toHaveBeenCalled();
    expect(f.document().pages[0]!.objects.map((object) => object.id)).toEqual(["mol_7"]);
  });

  it("snapshots an asynchronous document callback without reading plugin selection", async () => {
    const getSelection = vi.fn(async () => snapshot(["mol_7"]));
    const f = fixture(["mol_7"], (ctx) => ctx.documents.applyPatch!({ reason: "selected", patch: operations[0]! }), getSelection);
    const document = f.document();
    const host = new PluginHost({ getActiveDocument: async () => document, getSelection, applyDocumentPatch: f.applyDocumentPatch });
    host.registerPlugin(f.host.getPlugin("org.test.scope")!.manifest, {
      commandHandlers: { "plugin.scope.run": (ctx) => ctx.documents.applyPatch!({ reason: "selected", patch: operations[0]! }) }
    });
    await host.invokeCommand("plugin.scope.run");
    expect(getSelection).not.toHaveBeenCalled();
    expect(f.applyDocumentPatch).toHaveBeenCalledOnce();
  });

  it("honors Send's selection instead of the current document selection", async () => {
    const f = fixture(["mol_7"], async (ctx) => {
      await expect(ctx.documents.applyPatch!({ reason: "current selection", patch: operations[0]! }))
        .rejects.toThrow("mol_7 was not selected");
      return ctx.documents.applyPatch!({ reason: "Send selection", patch: { op: "removeObject", objectId: "mol_1" } });
    });
    await f.host.invokeCommand("plugin.scope.run", { writeSelection: snapshot(["mol_1"]) });
    expect(f.document().pages[0]!.objects.map(object => object.id)).toEqual(["mol_7"]);
  });
});
