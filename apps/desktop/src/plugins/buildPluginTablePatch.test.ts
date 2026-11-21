import { applyPatch, createEmptyDocument, createDocumentHistory, undo, redo, type ChemDraftDocument, type DocumentPatch } from "@chemdraft/chem-core";
import { TableSpecSchema } from "@chemdraft/document-workflow-core";
import type { AppliedPatchReceipt, PluginTableSpec } from "@chemdraft/plugin-api";
import type { PluginPatchApplicationRequest } from "@chemdraft/plugin-host";
import type { z } from "zod";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createPluginRuntime } from "./createPluginRuntime";
import { applyPluginDocumentPatch } from "./applyPluginDocumentPatch";
import { buildPluginTablePatch } from "./buildPluginTablePatch";
import { RESERVED_PLUGIN_OBJECT_IDS } from "./reservedObjectIds";

const spec: PluginTableSpec = { columns: [{ header: "Formula" }], rows: [["H2O"]] };

describe("plugin table preparation and runtime", () => {
  it("reserves only object ids when preparing many tables", () => {
    const before = RESERVED_PLUGIN_OBJECT_IDS.size;
    const document = createEmptyDocument();
    const ids = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const patch = buildPluginTablePatch(spec, document, []).patch as DocumentPatch;
      if (patch.op !== "addObject" || patch.object.type !== "table") throw new Error("Expected table");
      ids.add(patch.object.id);
      expect(patch.object.rows[0].id).toBe(`${patch.object.id}-r1`);
      expect(patch.object.columns[0].id).toBe(`${patch.object.id}-c1`);
    }
    expect(ids.size).toBe(30);
    expect(RESERVED_PLUGIN_OBJECT_IDS.size - before).toBe(30);
  });
  it("keeps the public input type aligned with the shared validator", () => {
    expectTypeOf<PluginTableSpec>().toEqualTypeOf<z.input<typeof TableSpecSchema>>();
  });
  it("centres an unselected table in the viewport", () => {
    const prepared = buildPluginTablePatch(spec, createEmptyDocument(), [], { x: 100, y: 200, width: 600, height: 400 });
    const patch = prepared.patch as DocumentPatch;
    if (patch.op !== "addObject") throw new Error("Expected table insertion");
    const table = patch.object;
    expect(table.x + table.width / 2).toBe(400);
    expect(table.y + table.height / 2).toBe(400);
  });
  it("commits beside the command selection with one labelled undo entry and selects the table", async () => {
    let document = createEmptyDocument();
    document = applyPatch(document, { op: "addObject", pageId: document.pages[0]!.id, object: {
      id: "caption", type: "text", x: 100, y: 200, width: 50, height: 50, rotation: 0, style: {}, text: "Caption", spans: []
    } });
    document = applyPatch(document, { op: "setSelection", pageId: document.pages[0]!.id, objectIds: ["caption"] });
    const before = document;
    const commits: { label: string; after: typeof document }[] = [];
    const applyDocumentPatch = vi.fn((request: PluginPatchApplicationRequest) => {
      const result = applyPluginDocumentPatch(document, request.patch);
      document = result.document;
      commits.push({ label: request.undoLabel, after: document });
      return result.receipt;
    });
    const runtime = createPluginRuntime({ getActiveDocument: () => document, applyDocumentPatch });
    runtime.registerPlugin({ id: "org.test.tables", name: "Tables", version: "1", apiVersion: "^0.1.18", entry: "plugin.js",
      permissions: ["document.write"], contributes: { commands: [{ id: "plugin.tables.insert", title: "Make table" }] }
    }, { commandHandlers: { "plugin.tables.insert": context => context.documents.insertTable!(spec) } });
    const receipt = await runtime.invokeCommand("plugin.tables.insert") as AppliedPatchReceipt;
    expect(applyDocumentPatch).toHaveBeenCalledOnce();
    expect(commits).toHaveLength(1);
    expect(commits[0]!.label).toBe("Insert table");
    expect(document.selection.objectIds).toEqual(receipt.objectIds);
    const table = document.pages[0]!.objects.find(object => object.id === receipt.objectIds[0])!;
    expect(table).toMatchObject({ type: "table", x: 162 });
    const history = { ...createDocumentHistory(before), past: [before], present: document };
    const restored = undo(history);
    expect(restored.present).toBe(before);
    expect(redo(restored).present).toBe(document);
  });
  it("places the table beside the selection's own page when a selected id also names an object on an earlier page", async () => {
    const caption = (y: number) => ({ id: "caption", type: "text" as const, x: 100, y, width: 50, height: 50, rotation: 0, style: {}, text: "Caption", spans: [] });
    const empty = createEmptyDocument();
    // Page A and page B each hold an object "caption"; the command's selection names page B's.
    const pageA = { ...empty.pages[0]!, id: "page_a", objects: [caption(200)] };
    const pageB = { ...empty.pages[0]!, id: "page_b", objects: [caption(400)] };
    let document: ChemDraftDocument = { ...empty, pages: [pageA, pageB], selection: { pageId: "page_b", objectIds: ["caption"] } };
    const applyDocumentPatch = vi.fn((request: PluginPatchApplicationRequest) => {
      const result = applyPluginDocumentPatch(document, request.patch);
      document = result.document;
      return result.receipt;
    });
    const runtime = createPluginRuntime({ getActiveDocument: () => document, applyDocumentPatch });
    runtime.registerPlugin({ id: "org.test.tables", name: "Tables", version: "1", apiVersion: "^0.1.18", entry: "plugin.js",
      permissions: ["document.write"], contributes: { commands: [{ id: "plugin.tables.insert", title: "Make table" }] }
    }, { commandHandlers: { "plugin.tables.insert": context => context.documents.insertTable!(spec) } });
    const receipt = await runtime.invokeCommand("plugin.tables.insert") as AppliedPatchReceipt;
    expect(document.pages[0]!.objects).toEqual(pageA.objects);
    const table = document.pages[1]!.objects.find(object => object.id === receipt.objectIds[0])!;
    // Beside page B's caption (x 100..150, centred on y 425), not on page A.
    expect(table).toMatchObject({ type: "table", x: 162 });
    expect(table.y + table.height / 2).toBe(425);
    expect(document.selection).toEqual({ pageId: "page_b", objectIds: receipt.objectIds });
  });
  it("anchors only on the page each reference names", () => {
    const caption = (y: number) => ({ id: "caption", type: "text" as const, x: 100, y, width: 50, height: 50, rotation: 0, style: {}, text: "Caption", spans: [] });
    const empty = createEmptyDocument();
    const document = { ...empty, pages: [{ ...empty.pages[0]!, id: "page_a", objects: [caption(200)] },
      { ...empty.pages[0]!, id: "page_b", objects: [caption(400)] }] };
    const patch = buildPluginTablePatch(spec, document, [{ pageId: "page_b", objectId: "caption" }]).patch as DocumentPatch;
    if (patch.op !== "addObject") throw new Error("Expected table insertion");
    expect(patch.pageId).toBe("page_b");
    expect(patch.object.y + patch.object.height / 2).toBe(425);
  });
});
