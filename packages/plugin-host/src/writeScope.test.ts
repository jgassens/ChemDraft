import { applyPatch, createEmptyDocument, type DocumentPatch, type DocumentObject, type ReactionObject } from "@chemdraft/chem-core";
import type { PluginCommandContext, PluginSelectionSnapshot } from "@chemdraft/plugin-api";
import { describe, expect, it, vi } from "vitest";
import { PluginHost, writePatchOps, type PluginPatchApplicationRequest } from "./index";

const now = "2026-10-22T00:00:00.000Z";
const text = (id: string): DocumentObject => ({
  id, type: "text", x: 0, y: 0, width: 10, height: 10, rotation: 0, style: {}, text: id, spans: []
});
const snapshot = (objectIds: string[]): PluginSelectionSnapshot => ({ objectIds, molecules: [] });
const reaction = (reference: "components" | "conditions" | "arrows" | "plusses" | "metadata"): ReactionObject => ({
  id: "step", type: "reaction", x: 0, y: 0, width: 100, height: 30, rotation: 0, style: {}, mappingState: "absent",
  components: reference === "components" ? [{ role: "agent", objectId: "mol_1" }] : [],
  conditionsTextObjectIds: reference === "conditions" ? ["mol_1"] : [],
  arrowObjectIds: reference === "arrows" ? ["mol_1"] : [],
  plusObjectIds: reference === "plusses" ? ["mol_1"] : [],
  ...(reference === "metadata" ? { compatibility: { warnings: [], unknown: {
    cdxmlStepReferences: { ReactionStepObjectsAboveArrow: ["mol_1"] }
  } } } : {})
});

function fixture(
  selectedIds: string[],
  run: (context: PluginCommandContext) => unknown | Promise<unknown>,
  getSelection?: () => PluginSelectionSnapshot | Promise<PluginSelectionSnapshot>,
  objects: DocumentObject[] = []
) {
  let document = createEmptyDocument({ now });
  const pageId = document.pages[0]!.id;
  document = applyPatch(document, { op: "batch", patches: [text("mol_1"), text("mol_7"), ...objects].map((object) => ({
    op: "addObject", pageId, object
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
  it("allows a colliding insertion followed by a selected removal through the embedding rebaser atomically (F2)", async () => {
    const f = fixture(["remove-me"], context => context.documents.applyPatch!({ reason: "Insert and remove", patch: {
      op: "batch", patches: [
        { op: "addObject", pageId: f.pageId, object: text("existing") },
        { op: "removeObject", objectId: "remove-me" }
      ]
    } }), undefined, [text("existing"), text("remove-me")]);
    const apply = f.applyDocumentPatch.getMockImplementation()!;
    // Model the embedding desktop's collision rebasing before its atomic core application.
    f.applyDocumentPatch.mockImplementation(request => apply({ ...request, patch: { ...request.patch, patch: {
      op: "batch", patches: writePatchOps(request.patch.patch as DocumentPatch).map(op =>
        op.op === "addObject" && op.object.id === "existing"
          ? { ...op, object: { ...op.object, id: "existing_copy" } } : op)
    } } }));

    await expect(f.host.invokeCommand("plugin.scope.run")).resolves.toEqual({ applied: true, objectIds: ["existing_copy"] });
    expect(f.applyDocumentPatch).toHaveBeenCalledTimes(1);
    expect(f.document().pages[0].objects).toEqual([
      text("mol_1"), text("mol_7"), text("existing"), { ...text("existing"), id: "existing_copy" }
    ]);
    expect(f.document().pages[0].objects.some(object => object.id === "remove-me")).toBe(false);
  });

  it("gives all writes one live signal per command and aborts it when the command ends", async () => {
    let index = 0;
    const f = fixture([], async ctx => {
      for (let i = 0; i < 2; i++) await ctx.documents.applyPatch!({ reason: "Insert", patch: {
        op: "addObject", pageId: f.pageId, object: text(`insert_${++index}`)
      } });
    });
    const apply = f.applyDocumentPatch.getMockImplementation()!;
    f.applyDocumentPatch.mockImplementation(request => {
      expect(request.signal?.aborted).toBe(false);
      return apply(request);
    });
    await f.host.invokeCommand("plugin.scope.run");
    const first = f.applyDocumentPatch.mock.calls[0]![0].signal!;
    expect(f.applyDocumentPatch.mock.calls[1]![0].signal).toBe(first);
    expect(first.aborted).toBe(true);
    await f.host.invokeCommand("plugin.scope.run");
    expect(f.applyDocumentPatch.mock.calls[2]![0].signal).not.toBe(first);
    expect(f.applyDocumentPatch.mock.calls[2]![0].signal?.aborted).toBe(true);
  });
  describe.each(["missing", "unavailable"] as const)("document provider %s", provider => {
    it.each([false, true])("applies patches without removals without reading the document (batch = %s)", async batch => {
      const f = fixture([], () => {});
      const getActiveDocument = vi.fn(() => undefined);
      const host = new PluginHost({
        ...(provider === "unavailable" ? { getActiveDocument } : {}),
        applyDocumentPatch: f.applyDocumentPatch
      });
      const patches: DocumentPatch[] = [
        { op: "addObject", pageId: f.pageId, object: text("new") },
        { op: "addAnnotation", pageId: f.pageId, annotation: {
          id: "note", type: "annotation", x: 0, y: 0, width: 10, height: 10,
          rotation: 0, style: {}, targetObjectIds: [], message: "note"
        } },
        { op: "updateObject", objectId: "mol_1", changes: { text: "edited" } },
        { op: "moveObject", objectId: "mol_1", x: 10, y: 20 },
        { op: "setObjectOrder", pageId: f.pageId, objectIds: ["mol_7", "mol_1", "new", "note"] }
      ];
      host.registerPlugin(f.host.getPlugin("org.test.scope")!.manifest, {
        commandHandlers: { "plugin.scope.run": async ctx => {
          for (const patch of batch ? [{ op: "batch" as const, patches }] : patches) {
            await ctx.documents.applyPatch!({ reason: "no removals", patch });
          }
        } }
      });
      // Explicit Send scope avoids the separate invocation-start selection read.
      await host.invokeCommand("plugin.scope.run", { writeSelection: snapshot(["mol_1", "mol_7"]) });
      expect(getActiveDocument).not.toHaveBeenCalled();
      expect(f.applyDocumentPatch).toHaveBeenCalledTimes(batch ? 1 : patches.length);
      expect(f.document().pages[0]!.objects.find(object => object.id === "mol_1"))
        .toMatchObject({ text: "edited", x: 10, y: 20 });
    });

    it.each([false, true])("refuses removals when their reaction scope cannot be checked (request scope = %s)", async requestScope => {
      const f = fixture([], () => {});
      const getActiveDocument = vi.fn(() => undefined);
      const host = new PluginHost({
        ...(provider === "unavailable" ? { getActiveDocument } : {}),
        applyDocumentPatch: f.applyDocumentPatch
      });
      const patch = { reason: "remove selected", patch: { op: "removeObject" as const, objectId: "mol_1" } };
      host.registerPlugin(f.host.getPlugin("org.test.scope")!.manifest, {
        commandHandlers: { "plugin.scope.run": ctx => requestScope
          ? host.applyPatchForPlugin("org.test.scope", undefined, patch, {
            objectIds: ["mol_1"], getDocument: () => undefined, apply: f.applyDocumentPatch
          })
          : ctx.documents.applyPatch!(patch) }
      });
      const before = f.document();
      await expect(host.invokeCommand("plugin.scope.run", { writeSelection: snapshot(["mol_1"]) }))
        .rejects.toThrow(`Plugin patch refused: no ${requestScope ? "request" : "active"} document is available to check reaction removal scope.`);
      expect(getActiveDocument).toHaveBeenCalledTimes(!requestScope && provider === "unavailable" ? 1 : 0);
      expect(f.applyDocumentPatch).not.toHaveBeenCalled();
      expect(f.document()).toBe(before);
    });
  });

  describe("fixed request document", () => {
    it.each([false, true])("checks the request's reaction cascade (reaction in scope = %s)", async inScope => {
      const f = fixture([], () => {}, undefined, [reaction("components")]);
      // The foreground tab has no removed object, so previewing it would miss the cascade.
      const foreground = createEmptyDocument({ now });
      const getActiveDocument = vi.fn(() => foreground);
      const getDocument = vi.fn(async () => f.document());
      const host = new PluginHost({ getActiveDocument });
      host.registerPlugin(f.host.getPlugin("org.test.scope")!.manifest, {
        commandHandlers: { "plugin.scope.run": () => host.applyPatchForPlugin("org.test.scope", undefined,
          { reason: "remove from request tab", patch: { op: "removeObject", objectId: "mol_1" } }, {
            objectIds: inScope ? ["mol_1", "step"] : ["mol_1"], getDocument, apply: f.applyDocumentPatch
          }) }
      });
      const before = f.document();
      const pending = host.invokeCommand("plugin.scope.run", { writeSelection: snapshot([]) });
      if (inScope) {
        await expect(pending).resolves.toMatchObject({ applied: true });
        expect(f.applyDocumentPatch).toHaveBeenCalledOnce();
        expect(f.document().pages[0]!.objects.find(object => object.id === "step")).toMatchObject({ components: [] });
        expect(f.document().pages[0]!.objects.some(object => object.id === "mol_1")).toBe(false);
      } else {
        await expect(pending).rejects.toThrow("removing mol_1 would change reaction step");
        expect(f.applyDocumentPatch).not.toHaveBeenCalled();
        expect(f.document()).toBe(before);
      }
      expect(getDocument).toHaveBeenCalledOnce();
      expect(getActiveDocument).not.toHaveBeenCalled();
      expect(foreground.pages[0]!.objects).toEqual([]);
    });

    it("does not fall back to the foreground when the request document is unavailable", async () => {
      const f = fixture([], () => {});
      const getActiveDocument = vi.fn(f.document);
      const getDocument = vi.fn(async () => undefined);
      const host = new PluginHost({ getActiveDocument });
      host.registerPlugin(f.host.getPlugin("org.test.scope")!.manifest, {
        commandHandlers: { "plugin.scope.run": () => host.applyPatchForPlugin("org.test.scope", undefined,
          { reason: "closed request tab", patch: { op: "removeObject", objectId: "mol_1" } }, {
            objectIds: ["mol_1"], getDocument, apply: f.applyDocumentPatch
          }) }
      });
      await expect(host.invokeCommand("plugin.scope.run", { writeSelection: snapshot([]) }))
        .rejects.toThrow("no request document is available to check reaction removal scope");
      expect(getDocument).toHaveBeenCalledOnce();
      expect(getActiveDocument).not.toHaveBeenCalled();
      expect(f.applyDocumentPatch).not.toHaveBeenCalled();
    });
  });

  describe.each(["components", "conditions", "arrows", "plusses", "metadata"] as const)("reaction %s references", reference => {
    it.each([false, true])("refuses an out-of-scope cascade atomically (batch = %s)", async batch => {
      const f = fixture(["mol_1", "mol_7"], async ctx => {
        const removal: DocumentPatch = { op: "removeObject", objectId: "mol_1" };
        await expect(ctx.documents.applyPatch!({ reason: "remove drawable", patch: batch ? {
          op: "batch", patches: [
            { op: "updateObject", objectId: "mol_7", changes: { text: "must not change" } },
            { op: "addObject", pageId: f.pageId, object: text("unaccepted") }, removal
          ]
        } : removal })).rejects.toThrow(
          "Plugin patch refused: removing mol_1 would change reaction step, which this command may not modify."
        );
        await expect(ctx.documents.applyPatch!({ reason: "rejected insertion", patch: {
          op: "removeObject", objectId: "unaccepted"
        } })).rejects.toThrow("unaccepted was not selected");
      }, undefined, [reaction(reference)]);
      const before = f.document();
      await f.host.invokeCommand("plugin.scope.run");
      expect(f.applyDocumentPatch).not.toHaveBeenCalled();
      expect(f.document()).toBe(before);
    });

    it.each(["selected", "inserted", "batch insertion"])("allows a cascade when the reaction is %s", async mode => {
      const step = reaction(reference);
      const f = fixture(mode === "selected" ? ["mol_1", "step"] : ["mol_1"], async ctx => {
        const insertion: DocumentPatch = { op: "addObject", pageId: f.pageId, object: step };
        if (mode === "inserted") await ctx.documents.applyPatch!({ reason: "insert reaction", patch: insertion });
        return ctx.documents.applyPatch!({ reason: "remove drawable", patch: {
          op: "batch", patches: [
            ...(mode === "batch insertion" ? [insertion] : []),
            { op: "removeObject", objectId: "mol_1" }
          ]
        } });
      }, undefined, mode === "selected" ? [step] : []);
      await expect(f.host.invokeCommand("plugin.scope.run")).resolves.toMatchObject({ applied: true });
      const objects = f.document().pages[0]!.objects;
      expect(objects.some(object => object.id === "mol_1")).toBe(false);
      expect(objects.find(object => object.id === "step")).toMatchObject({
        components: [], conditionsTextObjectIds: [], arrowObjectIds: [], plusObjectIds: [],
        ...(reference === "metadata" ? { compatibility: { unknown: {
          cdxmlStepReferences: { ReactionStepObjectsAboveArrow: [] }
        } } } : {})
      });
    });
  });

  it("does not authorize a cascade using a later insertion with the reaction's id", async () => {
    const f = fixture(["mol_1"], ctx => ctx.documents.applyPatch!({ reason: "later insertion", patch: {
      op: "batch", patches: [
        { op: "removeObject", objectId: "mol_1" },
        { op: "addObject", pageId: f.pageId, object: reaction("components") }
      ]
    } }), undefined, [reaction("components")]);
    await expect(f.host.invokeCommand("plugin.scope.run")).rejects.toThrow(
      "Plugin patch refused: removing mol_1 would change reaction step, which this command may not modify."
    );
    expect(f.applyDocumentPatch).not.toHaveBeenCalled();
  });

  it("accepts a native reaction referencing page drawables, including later batch insertions", async () => {
    const f = fixture([], ctx => ctx.documents.applyPatch!({ reason: "Insert synthetic reaction", patch: {
      op: "batch", patches: [
        { op: "addObject", pageId: f.pageId, object: {
          id: "step", type: "reaction", x: 0, y: 0, width: 100, height: 30, rotation: 0, style: {},
          components: [{ role: "reactant", objectId: "mol_1" }, { role: "product", objectId: "mol_7" }],
          conditionsTextObjectIds: ["conditions"], arrowObjectIds: ["arrow"], plusObjectIds: ["plus"], mappingState: "absent"
        } },
        { op: "addObject", pageId: f.pageId, object: {
          id: "arrow", type: "reaction-arrow", x: 30, y: 10, width: 40, height: 1, rotation: 0, style: {},
          arrowKind: "forward", start: { kind: "point", point: { x: 30, y: 10 } },
          end: { kind: "point", point: { x: 70, y: 10 } }, labels: []
        } },
        { op: "addObject", pageId: f.pageId, object: {
          id: "plus", type: "plus", x: 10, y: 10, width: 10, height: 10, rotation: 0, style: {}
        } },
        { op: "addObject", pageId: f.pageId, object: text("conditions") }
      ]
    } }));
    await expect(f.host.invokeCommand("plugin.scope.run")).resolves.toMatchObject({ applied: true });
    const objects = f.document().pages[0].objects;
    const reaction = objects.find(object => object.type === "reaction");
    expect(reaction).toMatchObject({ arrowObjectIds: ["arrow"], plusObjectIds: ["plus"] });
    if (reaction?.type !== "reaction") throw new Error("Expected reaction");
    for (const id of [...reaction.components.map(component => component.objectId), ...reaction.conditionsTextObjectIds,
      ...(reaction.arrowObjectIds ?? []), ...(reaction.plusObjectIds ?? [])]) {
      expect(objects.some(object => object.id === id), id).toBe(true);
    }
  });

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
