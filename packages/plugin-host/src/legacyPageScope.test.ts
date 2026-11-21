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
      'Plugin write refused: object "X" is selected on page "page-b", but the write would change the object with the same id on page "page-a".'
    );
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
