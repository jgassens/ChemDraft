import { applyPatch, createEmptyDocument, toEngineDocument, type ChemDraftDocument, type DocumentObject, type MoleculeObject } from "@chemdraft/chem-core";
import { describe, expect, it, vi } from "vitest";
import { assertPluginDocumentWriteScope, assertPluginPatchWriteScope, PluginHost, type PluginPatchApplicationRequest } from "./index";

const now = "2026-11-21T00:00:00.000Z";
const molecule = (id: string, x: number): MoleculeObject => ({
  id, type: "molecule", x, y: 0, width: 30, height: 20, rotation: 0, style: {},
  structureFormat: "smiles", structure: "CC",
  atoms: [{ id: "a1", element: "C", x, y: 0, formalCharge: 0 }, { id: "a2", element: "C", x: x + 30, y: 0, formalCharge: 0 }],
  bonds: [{ id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "single" }], superatoms: [], rGroups: []
});
const text = (id: string): DocumentObject => ({
  id, type: "text", x: 0, y: 0, width: 10, height: 10, rotation: 0, style: {}, text: "Page B", spans: []
});

/** An imported document whose id "X" names a molecule on page A and a text object on page B. */
function twoPageDocument(): ChemDraftDocument {
  const empty = createEmptyDocument({ now });
  const pageA = { ...empty.pages[0]!, id: "page-a", objects: [molecule("X", 0)] };
  const pageB = { ...empty.pages[0]!, id: "page-b", objects: [text("X")] };
  return toEngineDocument({ ...empty, pages: [pageA, pageB], selection: { pageId: "page-b", objectIds: ["X"] } });
}

function legacyHost(document: ChemDraftDocument) {
  let current = document;
  // Mirrors the desktop host: preflight, apply, then the final scope check at the history boundary.
  const applyDocumentPatch = vi.fn((request: PluginPatchApplicationRequest) => {
    const before = current;
    assertPluginPatchWriteScope(before, request.patch, request.writeScopeObjectIds, undefined, undefined, request.writeScopePages);
    const after = applyPatch(before, request.patch.patch, { now });
    assertPluginDocumentWriteScope(before, after, request.patch, request.writeScopeObjectIds, request.writeScopePages);
    current = after;
    return { applied: true as const, objectIds: [] };
  });
  const host = new PluginHost({ getActiveDocument: () => current, applyDocumentPatch });
  host.registerPlugin({ id: "org.test.pages", name: "Pages", version: "0.0.1", apiVersion: "^0.1.8", entry: "plugin.js",
    permissions: ["document.write"], contributes: { commands: [{ id: "plugin.pages.run", title: "Run" }] }
  }, { commandHandlers: { "plugin.pages.run": ctx => ctx.documents.applyPatch!({ reason: "Move the selected object", patch: {
    op: "updateObject", objectId: "X", changes: { x: 500 }
  } }) } });
  return { host, applyDocumentPatch, document: () => current };
}

describe("legacy direct writes are scoped by page and id", () => {
  it("never changes a same-id molecule on another page than the selection", async () => {
    const original = twoPageDocument();
    const f = legacyHost(original);
    await expect(f.host.invokeCommand("plugin.pages.run")).rejects.toThrow(
      `Plugin write refused: the change was not applied. The object you selected on page 2 shares its internal ID with an object on page 1, so ChemDraft can't tell which one to change safely. To edit it, make the change by hand, or copy the object and paste it as a new object, then try again.`
    );
    const refusal = await f.host.invokeCommand("plugin.pages.run").then(() => "", (error: Error) => error.message);
    expect(refusal).toContain("Plugin write refused:");
    expect(refusal).not.toMatch(/delete/i);
    expect(refusal).not.toMatch(/page-[abc]/);
    expect(f.applyDocumentPatch).not.toHaveBeenCalled();
    expect(f.document().pages[0]!.objects[0]).toEqual(original.pages[0]!.objects[0]);
  });

  it("still writes the selected object when its id is unique", async () => {
    const original = twoPageDocument();
    const unique = { ...original, pages: [original.pages[0]!, { ...original.pages[1]!, objects: [] }],
      selection: { pageId: "page-a", objectIds: ["X"] } };
    const f = legacyHost(unique);
    await expect(f.host.invokeCommand("plugin.pages.run")).resolves.toMatchObject({ applied: true });
    expect(f.document().pages[0]!.objects[0]).toMatchObject({ id: "X", x: 500 });
  });

  it("final check refuses a change to a same-id object outside the selected page", () => {
    const before = twoPageDocument();
    const proposed = { reason: "Move", warnings: [], requiresUserApproval: true as const,
      patch: { op: "updateObject" as const, objectId: "X", changes: { x: 500 } } };
    const after = applyPatch(before, proposed.patch, { now });
    expect(() => assertPluginDocumentWriteScope(before, after, proposed, ["X"], new Map([["X", "page-b"]])))
      .toThrow('Plugin write refused: molecule "X" was changed (x), but was not selected when the command started.');
    // Bare-id scope (request-bound and table callers) keeps its existing meaning.
    expect(() => assertPluginDocumentWriteScope(before, after, proposed, ["X"])).not.toThrow();
  });
});

/** A legacy host whose command waits for `release` before writing, so the test can edit the document
 * while the command is pending, exactly as a user can while a plugin works. */
function pendingHost(document: ChemDraftDocument) {
  let current = document;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const applyDocumentPatch = vi.fn((request: PluginPatchApplicationRequest) => {
    const before = current;
    assertPluginPatchWriteScope(before, request.patch, request.writeScopeObjectIds, undefined, undefined, request.writeScopePages);
    const after = applyPatch(before, request.patch.patch, { now });
    assertPluginDocumentWriteScope(before, after, request.patch, request.writeScopeObjectIds, request.writeScopePages);
    current = after;
    return { applied: true as const, objectIds: [] };
  });
  const host = new PluginHost({ getActiveDocument: () => current, applyDocumentPatch });
  host.registerPlugin({ id: "org.test.pending", name: "Pending", version: "0.0.1", apiVersion: "^0.1.8", entry: "plugin.js",
    permissions: ["document.write"], contributes: { commands: [{ id: "plugin.pending.run", title: "Run" }] }
  }, { commandHandlers: { "plugin.pending.run": async ctx => {
    await held;
    return ctx.documents.applyPatch!({ reason: "Move the selected object", patch: { op: "updateObject", objectId: "X", changes: { x: 500 } } });
  } } });
  return { host, applyDocumentPatch, release, document: () => current, edit: (next: ChemDraftDocument) => { current = next; } };
}

describe("legacy page binding follows the Send-time selection", () => {
  it("allows a write to a uniquely identified selected object that moved to another page while the command was pending", async () => {
    const empty = createEmptyDocument({ now });
    const pageA = { ...empty.pages[0]!, id: "page-a", objects: [] };
    const pageB = { ...empty.pages[0]!, id: "page-b", objects: [molecule("X", 0)] };
    const f = pendingHost(toEngineDocument({ ...empty, pages: [pageA, pageB], selection: { pageId: "page-b", objectIds: ["X"] } }));
    const pending = f.host.invokeCommand("plugin.pending.run");
    await Promise.resolve();
    // The user moves X from page B to page A; X is still the only object with that id.
    const current = f.document();
    f.edit({ ...current, pages: [{ ...current.pages[0]!, objects: [current.pages[1]!.objects[0]!] }, { ...current.pages[1]!, objects: [] }] });
    f.release();
    await expect(pending).resolves.toMatchObject({ applied: true });
    expect(f.document().pages[0]!.objects[0]).toMatchObject({ id: "X", x: 500 });
    expect(f.document().pages[1]!.objects).toEqual([]);
  });

  it("still refuses when the moved object's id now also names another object", async () => {
    const empty = createEmptyDocument({ now });
    const pageA = { ...empty.pages[0]!, id: "page-a", objects: [] };
    const pageB = { ...empty.pages[0]!, id: "page-b", objects: [molecule("X", 0)] };
    const pageC = { ...empty.pages[0]!, id: "page-c", objects: [text("X")] };
    const f = pendingHost(toEngineDocument({ ...empty, pages: [pageA, pageB, pageC], selection: { pageId: "page-b", objectIds: ["X"] } }));
    const pending = f.host.invokeCommand("plugin.pending.run");
    await Promise.resolve();
    const current = f.document();
    f.edit({ ...current, pages: [{ ...current.pages[0]!, objects: [current.pages[1]!.objects[0]!] }, { ...current.pages[1]!, objects: [] }, current.pages[2]!] });
    const edited = f.document();
    f.release();
    await expect(pending).rejects.toThrow(
      `Plugin write refused: the change was not applied. The object you selected on page 2 is no longer there, and its internal ID now matches objects on page 1 and page 3, so ChemDraft can't tell which one to change safely. To edit it, make the change by hand, or copy the object and paste it as a new object, then try again.`);
    expect(f.document()).toBe(edited);
  });

  it("binds a Send-time selection override to the override's page, not the live selection's page", async () => {
    // Send selected page B's "X"; the live selection has since moved to page A, which also has an "X".
    const original = { ...twoPageDocument(), selection: { pageId: "page-a", objectIds: ["X"] } };
    const f = legacyHost(original);
    await expect(f.host.invokeCommand("plugin.pages.run", { writeSelection: { objectIds: ["X"], molecules: [], pageId: "page-b" } })).rejects.toThrow(
      `Plugin write refused: the change was not applied. The object you selected on page 2 shares its internal ID with an object on page 1, so ChemDraft can't tell which one to change safely. To edit it, make the change by hand, or copy the object and paste it as a new object, then try again.`
    );
    expect(f.applyDocumentPatch).not.toHaveBeenCalled();
    expect(f.document().pages[0]!.objects[0]).toEqual(original.pages[0]!.objects[0]);
  });

  it("leaves an override id out of write scope when it names objects on several pages and no page was given", async () => {
    const original = { ...twoPageDocument(), selection: { pageId: "page-a", objectIds: ["X"] } };
    const f = legacyHost(original);
    await expect(f.host.invokeCommand("plugin.pages.run", { writeSelection: { objectIds: ["X"], molecules: [] } }))
      .rejects.toThrow("X was not selected when the command started");
    expect(f.document().pages[0]!.objects[0]).toEqual(original.pages[0]!.objects[0]);
  });
});
