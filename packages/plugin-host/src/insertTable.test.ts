import { applyPatch, createEmptyDocument, type DocumentPatch } from "@chemdraft/chem-core";
import { buildTableObject } from "@chemdraft/document-workflow-core";
import type { PluginCommandContext, PluginTableSpec } from "@chemdraft/plugin-api";
import { describe, expect, it, vi } from "vitest";
import { PluginHost, type PluginHostOptions, type PluginPatchApplicationRequest } from "./index";

const spec: PluginTableSpec = { columns: [{ header: "Formula" }], rows: [["H2O"]] };
function setup(run: (context: PluginCommandContext) => unknown, write = true, overrides: PluginHostOptions = {}, apiVersion = "^0.1.18") {
  let document = createEmptyDocument();
  let sequence = 0;
  const buildTablePatch = vi.fn((input: PluginTableSpec) => {
    const newId = (prefix: string) => `${prefix}_${++sequence}`;
    const { object } = buildTableObject(input, { id: newId("table"), x: 100, y: 100, newId });
    return { reason: "Insert table", patch: { op: "addObject" as const, pageId: document.pages[0]!.id, object } };
  });
  const applyDocumentPatch = vi.fn((request: PluginPatchApplicationRequest) => {
    document = applyPatch(document, request.patch.patch as DocumentPatch);
    const patch = request.patch.patch;
    return { applied: true as const, objectIds: patch.op === "addObject" ? [patch.object.id] : [] };
  });
  const host = new PluginHost({ getActiveDocument: () => document, buildTablePatch, applyDocumentPatch, ...overrides });
  host.registerPlugin({ id: "org.test.tables", name: "Tables", version: "1", apiVersion, entry: "plugin.js",
    permissions: write ? ["document.write"] : [], contributes: { commands: [{ id: "plugin.tables.insert", title: "Make table" }] }
  }, { commandHandlers: { "plugin.tables.insert": run } });
  return { host, buildTablePatch, applyDocumentPatch, document: () => document };
}

describe("command-scoped native table insertion", () => {
  it("exposes insertTable only to plugins declaring API 0.1.18 or newer", async () => {
    const old = setup(context => expect(context.documents.insertTable).toBeUndefined(), true, {}, "^0.1.17");
    const current = setup(context => expect(context.documents.insertTable).toBeTypeOf("function"));
    await old.host.invokeCommand("plugin.tables.insert");
    await current.host.invokeCommand("plugin.tables.insert");
  });
  it("omits the capability without document.write and uses the same permission error as applyPatch", async () => {
    const s = setup(context => expect(context.documents.insertTable).toBeUndefined(), false);
    await s.host.invokeCommand("plugin.tables.insert");
    await expect(s.host.insertTableForPlugin("org.test.tables", undefined, spec)).rejects.toThrow('requires permission "document.write"');
    expect(s.buildTablePatch).not.toHaveBeenCalled();
    expect(s.applyDocumentPatch).not.toHaveBeenCalled();
  });
  it("rejects calls outside the owning invocation, including a retained capability", async () => {
    let retained!: NonNullable<PluginCommandContext["documents"]["insertTable"]>;
    const s = setup(context => { retained = context.documents.insertTable!; });
    await s.host.invokeCommand("plugin.tables.insert");
    await expect(retained(spec)).rejects.toThrow(
      'may call documents.insertTable only while one of its own commands is executing.');
    await expect(s.host.createCommandContext("org.test.tables").documents.insertTable!(spec)).rejects.toThrow("only while one of its own commands");
    expect(s.buildTablePatch).not.toHaveBeenCalled();
  });
  it("uses one normal patch with the table label, receipt, and insertion scope", async () => {
    const s = setup(async context => {
      const receipt = await context.documents.insertTable!(spec);
      expect(receipt).toMatchObject({ applied: true, objectIds: [expect.any(String)] });
      expect(s.applyDocumentPatch).toHaveBeenCalledOnce();
      expect(s.applyDocumentPatch.mock.calls[0]![0]).toMatchObject({ undoLabel: "Insert table", patch: {
        reason: "Insert table", patch: { op: "addObject", object: { type: "table" } }
      } });
      // The inserted object joins this command's scope for ordinary later patch calls.
      await context.documents.applyPatch!({ reason: "Move inserted table", patch: {
        op: "moveObject", objectId: receipt.objectIds[0]!, x: 120, y: 140
      } });
    });
    await s.host.invokeCommand("plugin.tables.insert");
    expect(s.document().pages[0]!.objects[0]).toMatchObject({ type: "table", x: 120, y: 140 });
  });
  it("preserves typed validation errors naming the bad row before a patch reaches the host", async () => {
    const s = setup(context => context.documents.insertTable!({ columns: [{}, {}], rows: [["missing"]] }));
    await expect(s.host.invokeCommand("plugin.tables.insert")).rejects.toMatchObject({ name: "ZodError",
      issues: expect.arrayContaining([expect.objectContaining({ path: ["rows", 0], message: "Row 1 must have 2 columns" })]) });
    expect(s.applyDocumentPatch).not.toHaveBeenCalled();
  });
  it("rechecks the originating document before applying the built table", async () => {
    let documentKey = "original";
    const s = setup(context => { documentKey = "other"; return context.documents.insertTable!(spec); }, true,
      { getActiveDocumentKey: () => documentKey });
    await expect(s.host.invokeCommand("plugin.tables.insert")).rejects.toThrow("The document changed while the plugin was running");
    expect(s.applyDocumentPatch).not.toHaveBeenCalled();
  });
});
