import {
  applyPatch,
  createDocumentHistory,
  createEmptyDocument,
  DocumentObjectSchema,
  redo,
  undo,
  type DocumentHistory,
  type DocumentObject,
  type MoleculeObject
} from "@chemdraft/chem-core";
import { ProposedDocumentPatchSchema, type NormalizedProposedDocumentPatch } from "@chemdraft/plugin-api";
import { PluginHost } from "@chemdraft/plugin-host";
import { describe, expect, it, vi } from "vitest";

import {
  applyAcceptedPluginProposal,
  applyPluginDocumentPatch,
  createPluginWriteGate,
  rebaseProposedInsertion
} from "./applyPluginDocumentPatch";

function moleculeObject(): MoleculeObject {
  return {
    id: "mol_direct",
    type: "molecule",
    x: 80,
    y: 96,
    width: 160,
    height: 120,
    rotation: 0,
    style: {},
    structureFormat: "smiles",
    structure: "c1ccccc1",
    atoms: [],
    bonds: [],
    superatoms: [],
    rGroups: []
  };
}

describe("desktop direct plugin patch application", () => {
  it.each([undefined, { x: 300, y: 400, width: 200, height: 200 }])("preserves authored on-page geometry with viewport %j", bounds => {
    const document = createEmptyDocument();
    const page = document.pages[0];
    const object = moleculeObject();
    const result = applyPluginDocumentPatch(document, ProposedDocumentPatchSchema.parse({ reason: "placed insertion", patch: {
      op: "addObject", pageId: page.id, object
    } }), { insertionTarget: { pageId: page.id, bounds } });
    expect(result.document.pages[0].objects[0]).toEqual(object);
    expect(result.document.selection.objectIds).toEqual([object.id]);
  });

  it("leaves Orthonym-style name text below its existing molecule with a measured viewport", () => {
    let document = createEmptyDocument();
    const pageId = document.pages[0].id;
    const molecule = moleculeObject();
    document = applyPatch(document, { op: "addObject", pageId, object: molecule });
    const text = DocumentObjectSchema.parse({ id: "name", type: "text", x: molecule.x,
      y: molecule.y + molecule.height + 12, width: 160, height: 20, text: "benzene" });
    const result = applyPluginDocumentPatch(document, ProposedDocumentPatchSchema.parse({ reason: "Insert Name as Text", patch: {
      op: "addObject", pageId, object: text
    } }), { insertionTarget: { pageId, bounds: { x: 400, y: 500, width: 200, height: 200 } } });
    expect(result.document.pages[0].objects).toEqual([molecule, text]);
    expect(result.document.selection.objectIds).toEqual([text.id]);
  });

  function moleculeWithUndersizedFrame(x: number, y: number): MoleculeObject {
    return { ...moleculeObject(), x, y, width: 40, height: 40,
      atoms: [
        { id: "a1", element: "C", x: x - 8, y: y - 16, formalCharge: 0 },
        { id: "a2", element: "O", x: x + 48, y: y + 56, formalCharge: -1 }
      ],
      bonds: [{ id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "single" }]
    };
  }

  describe.each(["frame inside", "frame outside", "fully outside"] as const)("placement with %s and atoms beyond the frame", mode => {
    it.each(["left", "top", "right", "bottom"] as const)("brings the atom extents inside the %s page edge", edge => {
      const document = createEmptyDocument();
      const page = document.pages[0];
      const offset = mode === "frame inside" ? 0 : mode === "frame outside" ? 10 : 200;
      const x = edge === "left" ? -offset : edge === "right" ? page.width - 40 + offset : 100;
      const y = edge === "top" ? -offset : edge === "bottom" ? page.height - 40 + offset : 100;
      const object = moleculeWithUndersizedFrame(x, y);
      const result = applyPluginDocumentPatch(document, ProposedDocumentPatchSchema.parse({ reason: "inconsistent molecule frame", patch: {
        op: "addObject", pageId: page.id, object
      } }), { insertionTarget: { pageId: page.id,
        bounds: { x: page.width - 20, y: page.height - 20, width: 40, height: 40 } } });
      const inserted = result.document.pages[0].objects[0] as MoleculeObject;
      const dx = inserted.x - object.x;
      const dy = inserted.y - object.y;
      expect(inserted).toEqual({ ...object, x: object.x + dx, y: object.y + dy,
        atoms: object.atoms.map(atom => ({ ...atom, x: atom.x + dx, y: atom.y + dy })) });
      expect(inserted.x).toBeGreaterThanOrEqual(0);
      expect(inserted.y).toBeGreaterThanOrEqual(0);
      expect(inserted.x + inserted.width).toBeLessThanOrEqual(page.width);
      expect(inserted.y + inserted.height).toBeLessThanOrEqual(page.height);
      for (const atom of inserted.atoms) {
        expect(atom.x).toBeGreaterThanOrEqual(0);
        expect(atom.y).toBeGreaterThanOrEqual(0);
        expect(atom.x).toBeLessThanOrEqual(page.width);
        expect(atom.y).toBeLessThanOrEqual(page.height);
      }
      if (mode === "fully outside") {
        // The viewport target clamps the union, including atoms, at the bottom-right edge.
        expect(inserted.atoms[1]).toMatchObject({ x: page.width, y: page.height });
      } else {
        const atom = inserted.atoms[edge === "left" || edge === "top" ? 0 : 1];
        const axis = edge === "left" || edge === "right" ? "x" : "y";
        expect(atom[axis]).toBe(edge === "right" ? page.width : edge === "bottom" ? page.height : 0);
        expect(axis === "x" ? dy : dx).toBe(0);
      }
      expect(result.document.selection.objectIds).toEqual([object.id]);
    });
  });

  it("leaves an in-page molecule untouched even when its atoms extend beyond its frame", () => {
    const document = createEmptyDocument();
    const page = document.pages[0];
    const object = moleculeWithUndersizedFrame(100, 100);
    const result = applyPluginDocumentPatch(document, ProposedDocumentPatchSchema.parse({ reason: "in-page atoms", patch: {
      op: "addObject", pageId: page.id, object
    } }), { insertionTarget: { pageId: page.id, bounds: { x: 300, y: 400, width: 200, height: 200 } } });
    expect(result.document.pages[0].objects).toEqual([object]);
  });

  it.each([
    { type: "electron-mark", markKind: "charge", charge: 1,
      anchor: { kind: "atom", objectId: "mol_direct", atomId: "a1" } },
    { type: "reaction-arrow", arrowKind: "forward", start: { kind: "object", objectId: "mol_direct" },
      end: { kind: "point", point: { x: -20, y: 10 } } },
    { type: "mechanism-arrow", arrowKind: "full-headed", source: { kind: "atom", objectId: "mol_direct", atomId: "a1" },
      target: { kind: "point", point: { x: -20, y: 10 } }, controlPoints: [{ x: -30, y: 5 }] },
    { type: "annotation", targetObjectIds: ["mol_direct"], message: "existing molecule" },
    { type: "group", childObjectIds: ["mol_direct"] },
    { type: "bracket", bracketKind: "square", containedObjectIds: ["mol_direct"] },
    { type: "reaction", components: [{ role: "reactant", objectId: "mol_direct" }] },
    { type: "superatom", label: "R", metadata: { label: "R", attachmentPoints: [{ kind: "object", objectId: "mol_direct" }] } },
    { type: "r-group-label", label: "R", display: { label: "R", attachmentPoints: [{ kind: "object", objectId: "mol_direct" }] } }
  ])("keeps an off-page group attached to an existing object through $type unmoved", fields => {
    let document = createEmptyDocument();
    const page = document.pages[0];
    document = applyPatch(document, { op: "addObject", pageId: page.id, object: {
      ...moleculeObject(), atoms: [{ id: "a1", element: "C", x: 100, y: 110, formalCharge: 0 }]
    } });
    const anchored = DocumentObjectSchema.parse({ id: "anchored", x: -40, y: -10, width: 10, height: 10, ...fields });
    // Oversized companions must also stay put: an anchored group never needs automatic placement.
    const companion = { ...moleculeObject(), id: "companion", x: -80, y: -60, width: page.width + 1 };
    const proposed = ProposedDocumentPatchSchema.parse({ reason: "anchored insertion", patch: { op: "batch", patches: [
      { op: "addObject", pageId: page.id, object: companion },
      { op: "addObject", pageId: page.id, object: anchored }
    ] } });
    const result = applyPluginDocumentPatch(document, proposed, {
      insertionTarget: { pageId: page.id, bounds: { x: 300, y: 400, width: 200, height: 200 } }
    });
    expect(result.document.pages[0].objects).toEqual([...document.pages[0].objects, companion, anchored]);
    expect(result.document.selection.objectIds).toEqual([companion.id, anchored.id]);
  });

  it("places a fully off-page batch together on each run and clamps its viewport target inside the page", () => {
    let document = createEmptyDocument();
    const page = document.pages[0];
    const patch = ProposedDocumentPatchSchema.parse({ reason: "flattened complex", patch: { op: "batch", patches: [0, 1].map(i => ({
      op: "addObject", pageId: page.id, object: { ...moleculeObject(), id: `complex_${i}`, x: -400 + i * 180, y: -200 }
    })) } });
    for (let run = 0; run < 2; run++) {
      const oldObjects = [...document.pages[0].objects];
      const result = applyPluginDocumentPatch(document, patch, {
        insertionTarget: { pageId: page.id, bounds: { x: page.width - 20, y: page.height - 20, width: 40, height: 40 } }
      });
      const objects = result.document.pages[0].objects.filter(object => result.receipt.objectIds.includes(object.id));
      expect(objects).toHaveLength(2);
      expect(objects[0]).toMatchObject({ x: page.width - 340, y: page.height - 120 });
      expect(objects[1]).toMatchObject({ x: page.width - 160, y: page.height - 120 });
      expect(objects[1].x - objects[0].x).toBe(180);
      for (const object of objects) {
        expect(object.x).toBeGreaterThanOrEqual(0);
        expect(object.y).toBeGreaterThanOrEqual(0);
        expect(object.x + object.width).toBeLessThanOrEqual(page.width);
        expect(object.y + object.height).toBeLessThanOrEqual(page.height);
      }
      expect(result.document.selection.objectIds).toEqual(result.receipt.objectIds);
      expect(result.document.pages[0].objects.slice(0, oldObjects.length)).toEqual(oldObjects);
      document = result.document;
    }
  });

  it.each([
    { x: -30, y: 50, dx: 30, dy: 0 },
    { x: 50, y: -25, dx: 0, dy: 25 },
    { x: -30, y: -25, dx: 30, dy: 25 },
    { x: -310, y: -100, dx: -30, dy: -20, fromBottomRight: true }
  ])("minimally nudges a partly off-page group from ($x, $y)", ({ x, y, dx, dy, fromBottomRight }) => {
    const document = createEmptyDocument();
    const page = document.pages[0];
    if (fromBottomRight) { x += page.width; y += page.height; }
    const objects = [0, 1].map(i => ({ ...moleculeObject(), id: `part_${i}`, x: x + i * 180, y }));
    const result = applyPluginDocumentPatch(document, ProposedDocumentPatchSchema.parse({ reason: "partial batch", patch: {
      op: "batch", patches: objects.map(object => ({ op: "addObject", pageId: page.id, object }))
    } }), { insertionTarget: { pageId: page.id, bounds: { x: 400, y: 500, width: 200, height: 200 } } });
    expect(result.document.pages[0].objects).toEqual(objects.map(object => ({ ...object, x: object.x + dx, y: object.y + dy })));
    expect(result.document.selection.objectIds).toEqual(objects.map(object => object.id));
  });

  it.each([
    { x: -200, y: 50 }, { x: 900, y: 50 }, { x: 50, y: -200 }, { x: 50, y: 1300 }
  ])("centres a group fully outside the page from ($x, $y) in the visible viewport", ({ x, y }) => {
    const document = createEmptyDocument();
    const page = document.pages[0];
    const result = applyPluginDocumentPatch(document, ProposedDocumentPatchSchema.parse({ reason: "outside insertion", patch: {
      op: "addObject", pageId: page.id, object: { ...moleculeObject(), x, y }
    } }), { insertionTarget: { pageId: page.id, bounds: { x: 300, y: 400, width: 200, height: 200 } } });
    expect(result.document.pages[0].objects[0]).toMatchObject({ x: 320, y: 440 });
  });

  it.each(["superatom", "r-group-label"] as const)("rebases colliding %s attachment points and places the batch", type => {
    let document = createEmptyDocument();
    const pageId = document.pages[0].id;
    const molecule = { ...moleculeObject(), x: -200, y: -200,
      atoms: [{ id: "a1", element: "C", x: -180, y: -180, formalCharge: 0 }] };
    const anchor = { kind: "atom", objectId: molecule.id, atomId: "a1" };
    const label = DocumentObjectSchema.parse({ id: "label", type, label: "R", x: -180, y: -180, width: 10, height: 10,
      ...(type === "superatom" ? { metadata: { label: "R", attachmentPoints: [anchor] } } :
        { display: { label: "R", attachmentPoints: [anchor] } }) });
    for (const object of [moleculeObject(), label]) document = applyPatch(document, { op: "addObject", pageId, object });
    const result = applyPluginDocumentPatch(document, ProposedDocumentPatchSchema.parse({ reason: "attached labels", patch: {
      op: "batch", patches: [molecule, label].map(object => ({ op: "addObject", pageId, object }))
    } }), { insertionTarget: { pageId, bounds: { x: 300, y: 400, width: 200, height: 200 } } });
    const [, , inserted, insertedLabel] = result.document.pages[0].objects;
    expect(result.document.pages[0].objects.slice(0, 2)).toEqual(document.pages[0].objects);
    expect(inserted.id).not.toBe(molecule.id);
    expect(insertedLabel.id).not.toBe(label.id);
    expect(inserted).toMatchObject({ x: 320, y: 440, atoms: [{ id: "a1", x: 340, y: 460 }] });
    expect(insertedLabel).toMatchObject({ x: 340, y: 460,
      [type === "superatom" ? "metadata" : "display"]: { attachmentPoints: [{ ...anchor, objectId: inserted.id }] } });
    expect(result.document.selection.objectIds).toEqual([inserted.id, insertedLabel.id]);
  });

  it("moves anchors to objects inserted in the same batch together, after rebasing colliding ids", () => {
    let document = createEmptyDocument();
    const page = document.pages[0];
    document = applyPatch(document, { op: "addObject", pageId: page.id, object: moleculeObject() });
    const molecule = { ...moleculeObject(), x: -80, y: -60,
      atoms: [{ id: "a1", element: "C", x: -20, y: -10, formalCharge: 1 }] };
    const charge = DocumentObjectSchema.parse({ id: "charge", type: "electron-mark", markKind: "charge",
      charge: 1, x: -15, y: -15, width: 10, height: 10,
      anchor: { kind: "atom", objectId: molecule.id, atomId: "a1" } });
    const result = applyPluginDocumentPatch(document, ProposedDocumentPatchSchema.parse({ reason: "new anchored molecule", patch: {
      op: "batch", patches: [
        { op: "addObject", pageId: page.id, object: molecule },
        { op: "addObject", pageId: page.id, object: charge }
      ]
    } }));
    const [existing, inserted, mark] = result.document.pages[0].objects;
    expect(existing).toEqual(document.pages[0].objects[0]);
    expect(inserted.id).not.toBe(molecule.id);
    expect(inserted.x).toBeGreaterThanOrEqual(0);
    expect(inserted.y).toBeGreaterThanOrEqual(0);
    expect(mark.x - inserted.x).toBe(charge.x - molecule.x);
    expect(mark.y - inserted.y).toBe(charge.y - molecule.y);
    expect(mark).toMatchObject({ anchor: { kind: "atom", objectId: inserted.id, atomId: "a1" } });
  });

  it("places insertion-only batches on their target page, including a non-first page", () => {
    let document = createEmptyDocument();
    document = { ...document, pages: [...document.pages, { ...document.pages[0], id: "second", objects: [] }] };
    const result = applyPluginDocumentPatch(document, ProposedDocumentPatchSchema.parse({ reason: "second page", patch: {
      op: "addObject", pageId: "second", object: { ...moleculeObject(), x: -80, y: -60 }
    } }));
    expect(result.document.pages[0].objects).toEqual([]);
    expect(result.document.pages[1].objects[0]).toMatchObject({ x: 0, y: 0 });
    expect(result.document.selection).toMatchObject({ pageId: "second", objectIds: result.receipt.objectIds });
  });

  it("refuses an off-page oversized batch atomically instead of clipping or rescaling a complex", () => {
    const document = createEmptyDocument();
    const page = document.pages[0];
    expect(() => applyPluginDocumentPatch(document, ProposedDocumentPatchSchema.parse({ reason: "oversize", patch: {
      op: "batch", patches: [
        { op: "addObject", pageId: page.id, object: { ...moleculeObject(), id: "would_fit" } },
        { op: "addObject", pageId: page.id, object: { ...moleculeObject(), x: -10, width: page.width + 1 } }
      ]
    } }))).toThrow("Plugin insertion is larger than the page");
    expect(document.pages[0].objects).toEqual([]);
  });

  it("rebases a direct batch and grants scope only for its actual inserted ids", async () => {
    let document = createEmptyDocument();
    const pageId = document.pages[0].id;
    document = applyPatch(document, { op: "addObject", pageId, object: moleculeObject() });
    const host = new PluginHost({
      getSelection: () => ({ objectIds: [], molecules: [] }),
      applyDocumentPatch: (request) => {
        const result = applyPluginDocumentPatch(document, request.patch);
        document = result.document;
        return result.receipt;
      }
    });
    host.registerPlugin({
      id: "org.test.rebase", name: "Rebase", version: "0.0.1", apiVersion: "^0.1.8", entry: "plugin.js",
      permissions: ["document.write"], contributes: { commands: [{ id: "plugin.rebase.run", title: "Run" }] }
    }, { commandHandlers: { "plugin.rebase.run": async (context) => {
      const receipt = await context.documents.applyPatch!({ reason: "insert and edit", patch: { op: "batch", patches: [
        { op: "addObject", pageId, object: moleculeObject() },
        { op: "updateObject", objectId: "mol_direct", changes: { x: 12 } }
      ] } });
      const [insertedId] = receipt.objectIds;
      expect(insertedId).not.toBe("mol_direct");
      await expect(context.documents.applyPatch!({ reason: "existing object", patch: {
        op: "removeObject", objectId: "mol_direct"
      } })).rejects.toThrow("mol_direct was not selected when the command started");
      return context.documents.applyPatch!({ reason: "inserted object", patch: {
        op: "updateObject", objectId: insertedId!, changes: { x: 34 }
      } });
    } } });
    const receipt = await host.invokeCommand<{ objectIds: string[] }>("plugin.rebase.run");
    expect(document.pages[0].objects[0]).toMatchObject({ id: "mol_direct", x: 80 });
    expect(document.pages[0].objects[1]).toMatchObject({ id: receipt.objectIds[0], x: 34 });
    expect(document.selection.objectIds).toEqual(receipt.objectIds);
  });

  it("keeps a missing page on a direct write an atomic failure", () => {
    const document = createEmptyDocument();
    expect(() => applyPluginDocumentPatch(document, ProposedDocumentPatchSchema.parse({ reason: "missing page", patch: {
      op: "batch", patches: [
        { op: "addObject", pageId: document.pages[0].id, object: moleculeObject() },
        { op: "addObject", pageId: "missing", object: moleculeObject() }
      ]
    } }))).toThrow(/page "missing" does not exist/);
    expect(document.pages[0].objects).toEqual([]);
  });

  it("selects every surviving insertion and edit in a batch, excluding removals", () => {
    let document = createEmptyDocument();
    const pageId = document.pages[0].id;
    for (const id of ["edit", "move", "remove", "unchanged"]) {
      document = applyPatch(document, { op: "addObject", pageId, object: { ...moleculeObject(), id } });
    }
    const result = applyPluginDocumentPatch(document, ProposedDocumentPatchSchema.parse({ reason: "batch", patch: {
      op: "batch", patches: [
        { op: "addObject", pageId, object: { ...moleculeObject(), id: "insert" } },
        { op: "updateObject", objectId: "edit", changes: { style: { color: "#ff0000" } } },
        { op: "moveObject", objectId: "move", x: 50, y: 60 },
        { op: "addObject", pageId, object: { ...moleculeObject(), id: "temporary" } },
        { op: "removeObject", objectId: "temporary" },
        { op: "updateObject", objectId: "remove", changes: { x: 10 } },
        { op: "removeObject", objectId: "remove" }
      ]
    } }));
    expect(result.receipt.objectIds).toEqual(["edit", "move", "insert"]);
    expect(result.document.selection.objectIds).toEqual(result.receipt.objectIds);
    expect(document.pages[0].objects.map((object) => object.id)).toEqual(["edit", "move", "remove", "unchanged"]);
  });

  it("clears selection for a deletion-only patch", () => {
    let document = createEmptyDocument();
    const pageId = document.pages[0].id;
    document = applyPatch(document, { op: "addObject", pageId, object: moleculeObject() });
    document = applyPatch(document, { op: "setSelection", objectIds: ["mol_direct"] });
    const result = applyPluginDocumentPatch(document, ProposedDocumentPatchSchema.parse({
      reason: "delete", patch: { op: "removeObject", objectId: "mol_direct" }
    }));
    expect(result.receipt.objectIds).toEqual([]);
    expect(result.document.selection.objectIds).toEqual([]);
  });

  it("minimally nudges a partial batch in one labelled undo entry and queues no proposal review", async () => {
    const now = "2026-09-24T15:00:00.000Z";
    let history: DocumentHistory = createDocumentHistory(createEmptyDocument({ now }));
    const proposalChanged = vi.fn();
    const committedLabels: string[] = [];
    const host = new PluginHost({
      getActiveDocument: () => history.present,
      onProposedPatchesChanged: proposalChanged,
      applyDocumentPatch: (request) => {
        const applied = applyPluginDocumentPatch(history.present, request.patch, { now,
          insertionTarget: { pageId: history.present.pages[0].id, bounds: { x: 300, y: 400, width: 200, height: 200 } }
        });
        history = {
          past: [...history.past, history.present],
          present: applied.document,
          future: []
        };
        committedLabels.push(request.undoLabel);
        return applied.receipt;
      }
    });
    host.registerPlugin(
      {
        id: "org.test.desktop-direct-write",
        name: "Name to Structure",
        version: "0.0.1",
        apiVersion: "^0.1.4",
        entry: "dist/plugin.js",
        permissions: ["document.write"],
        contributes: {
          commands: [
            {
              id: "plugin.desktopDirectWrite.insert",
              title: "Insert Named Structure",
              requiredPermissions: ["document.write"]
            }
          ]
        }
      },
      {
        commandHandlers: {
          "plugin.desktopDirectWrite.insert": (context) =>
            context.documents.applyPatch!({
              reason: "deterministic result for user-supplied name",
              patch: {
                op: "batch",
                patches: [0, 1].map(i => ({ op: "addObject", pageId: history.present.pages[0].id,
                  object: { ...moleculeObject(), id: `part_${i}`, x: -30 + i * 180, y: 60 } }))
              }
            })
        }
      }
    );

    await expect(host.invokeCommand("plugin.desktopDirectWrite.insert")).resolves.toEqual({
      applied: true,
      objectIds: ["part_0", "part_1"]
    });
    expect(history.past).toHaveLength(1);
    expect(history.present.pages[0].objects.map(({ x, y }) => ({ x, y }))).toEqual([{ x: 0, y: 60 }, { x: 180, y: 60 }]);
    expect(history.present.selection.objectIds).toEqual(["part_0", "part_1"]);
    expect(committedLabels).toEqual(["Name to Structure: Insert Named Structure"]);
    expect(host.listProposedPatches("pending")).toHaveLength(0);
    expect(proposalChanged).not.toHaveBeenCalled();
    const committed = history.present;
    history = undo(history);
    expect(history.present.pages[0].objects).toEqual([]);
    history = redo(history);
    expect(history.present).toBe(committed);
    expect(committedLabels).toHaveLength(1);
  });
});

describe("accepting a proposal into a document it was not laid out for", () => {
  const now = "2026-09-27T12:00:00.000Z";

  function recognizedMolecule(id: string): MoleculeObject {
    return {
      ...moleculeObject(),
      id,
      x: 100,
      y: 100,
      width: 40,
      height: 20,
      structureFormat: "molfile-v2000",
      structure: "recognized molfile",
      atoms: [
        { id: "a1", element: "C", x: 110, y: 110, formalCharge: 0 },
        { id: "a2", element: "O", x: 130, y: 110, formalCharge: -1 }
      ] as MoleculeObject["atoms"],
      bonds: [{ id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "double" }] as MoleculeObject["bonds"]
    };
  }

  function proposal(pageId: string, object: MoleculeObject): NormalizedProposedDocumentPatch {
    return ProposedDocumentPatchSchema.parse({
      patch: { op: "addObject", pageId, object },
      reason: "Insert the locally recognized structure after review."
    });
  }

  function documentWith(objectIds: string[]) {
    let document = createEmptyDocument({ now });
    for (const id of objectIds) {
      document = applyPatch(document, { op: "addObject", pageId: document.pages[0].id, object: { ...moleculeObject(), id } }, { now });
    }
    return document;
  }

  it("rebases colliding batch insertions and remaps only later targets, preserving chemistry", () => {
    const document = documentWith(["mol_001", "mol_002"]);
    const pageId = document.pages[0].id;
    const source = recognizedMolecule("mol_001");
    const proposed = ProposedDocumentPatchSchema.parse({ reason: "batch", patch: { op: "batch", patches: [
      { op: "updateObject", objectId: "mol_001", changes: { x: 12 } },
      { op: "addObject", pageId, object: source },
      { op: "updateObject", objectId: "mol_001", changes: { id: "mol_001", style: { color: "#ff0000" } } },
      { op: "moveObject", objectId: "mol_001", x: 30, y: 40 },
      { op: "addObject", pageId, object: recognizedMolecule("mol_002") },
      { op: "removeObject", objectId: "mol_002" },
      // The first allocator must leave this name free for the later insertion.
      { op: "addObject", pageId, object: recognizedMolecule("mol_004") }
    ] } });
    const rebased = rebaseProposedInsertion(document, proposed);
    if (rebased.patch.op !== "batch") throw new Error("Expected batch");
    const insertion = rebased.patch.patches[1];
    if (insertion?.op !== "addObject") throw new Error("Expected insertion");
    const newId = insertion.object.id;
    expect(newId).not.toBe("mol_001");
    expect(newId).not.toBe("mol_004");
    expect(rebased.patch.patches[0]).toMatchObject({ objectId: "mol_001" });
    expect(rebased.patch.patches[2]).toMatchObject({ objectId: newId, changes: { id: newId } });
    expect(rebased.patch.patches[3]).toMatchObject({ objectId: newId });
    const result = applyAcceptedPluginProposal(document, proposed, { now });
    expect(result.document.pages[0].objects.find((object) => object.id === "mol_001")).toMatchObject({ x: 12 });
    expect(result.document.pages[0].objects.find((object) => object.id === "mol_002")).toBe(document.pages[0].objects[1]);
    const inserted = result.document.pages[0].objects.find((object) => object.id === newId);
    expect(inserted).toMatchObject({ x: 30, y: 40, atoms: source.atoms, bonds: source.bonds, structure: source.structure });
    expect(result.receipt.objectIds).toEqual(["mol_001", newId, "mol_004"]);
    expect(result.document.selection.objectIds).toEqual(result.receipt.objectIds);
  });

  it("remaps setObjectOrder and removeAnnotation after colliding insertions", () => {
    let document = documentWith(["mol_001"]);
    const pageId = document.pages[0].id;
    const annotation = {
      id: "note", type: "annotation" as const, x: 0, y: 0, width: 10, height: 10,
      rotation: 0, style: {}, targetObjectIds: [], message: "note"
    };
    document = applyPatch(document, { op: "addAnnotation", pageId, annotation });
    const proposed = ProposedDocumentPatchSchema.parse({ reason: "batch", patch: { op: "batch", patches: [
      { op: "removeObject", objectId: "mol_001" },
      { op: "addObject", pageId, object: recognizedMolecule("mol_001") },
      { op: "setObjectOrder", pageId, objectIds: ["note", "mol_001"] },
      { op: "addAnnotation", pageId, annotation },
      { op: "removeAnnotation", annotationId: "note" }
    ] } });
    const rebased = rebaseProposedInsertion(document, proposed);
    if (rebased.patch.op !== "batch") throw new Error("Expected batch");
    const add = rebased.patch.patches[1];
    if (add?.op !== "addObject") throw new Error("Expected addObject");
    expect(rebased.patch.patches[2]).toMatchObject({ objectIds: ["note", add.object.id] });
    const note = rebased.patch.patches[3];
    if (note?.op !== "addAnnotation") throw new Error("Expected addAnnotation");
    expect(note.annotation.id).not.toBe("note");
    expect(rebased.patch.patches[4]).toMatchObject({ annotationId: note.annotation.id });
    const result = applyAcceptedPluginProposal(document, proposed);
    expect(result.document.pages[0].objects.map((object) => object.id)).toEqual(["note", add.object.id]);
    expect(result.document.selection.objectIds).toEqual(["note", add.object.id]);
  });

  it("remaps native references in later insertions and updates, preserving opaque metadata", () => {
    const document = documentWith(["mol_001"]);
    const pageId = document.pages[0].id;
    const result = applyPluginDocumentPatch(document, ProposedDocumentPatchSchema.parse({ reason: "references", patch: {
      op: "batch", patches: [
        { op: "addObject", pageId, object: recognizedMolecule("mol_001") },
        { op: "addAnnotation", pageId, annotation: {
          id: "note", type: "annotation", x: 0, y: 0, width: 10, height: 10, rotation: 0,
          style: { objectId: "mol_001" }, targetObjectIds: ["mol_001"], message: "mol_001"
        } },
        { op: "updateObject", objectId: "note", changes: { targetObjectIds: ["mol_001"] } }
      ]
    } }));
    const [, inserted, note] = result.document.pages[0].objects;
    expect(note).toMatchObject({ targetObjectIds: [inserted!.id], style: { objectId: "mol_001" }, message: "mol_001" });
  });

  it("remaps every schema's object references on insert and untyped update, preserving local ids and opaque data", () => {
    const document = documentWith(["a1"]);
    const pageId = document.pages[0].id;
    function fixtures(objectId: string): DocumentObject[] {
      const warning = { code: "reference", message: "a1", objectId };
      const atomAnchor = { kind: "atom", objectId, atomId: "a1" };
      const bondAnchor = { kind: "bond", objectId, bondId: "a1" };
      const point = { kind: "point", point: { x: 110, y: 110 } };
      const attachment = { label: "a1", attachmentPoints: [atomAnchor, bondAnchor, point], warnings: [warning] };
      return [
        { ...moleculeObject(), type: "molecule", structure: "a1",
          atoms: [{ id: "a1", element: "C", x: 100, y: 100, labelBondSide: { side: "left", atomId: "a1" } }],
          bonds: [{ id: "a1", fromAtomId: "a1", toAtomId: "a1" }],
          superatoms: [attachment], rGroups: [attachment], chemistry: { warnings: [warning] } },
        { type: "reaction", components: [{ role: "reactant", objectId }], conditionsTextObjectIds: [objectId] },
        { type: "reaction-arrow", arrowKind: "forward", start: atomAnchor, end: bondAnchor, labels: [objectId] },
        { type: "mechanism-arrow", arrowKind: "full-headed", source: atomAnchor, target: bondAnchor, warnings: [warning] },
        { type: "electron-mark", markKind: "lone-pair", anchor: atomAnchor },
        { type: "bracket", bracketKind: "square", containedObjectIds: [objectId], label: "a1" },
        { type: "group", childObjectIds: [objectId] },
        { type: "annotation", targetObjectIds: [objectId], message: "a1" },
        { type: "superatom", label: "a1", metadata: attachment },
        { type: "r-group-label", label: "a1", display: attachment },
        { type: "text", text: "a1", spans: [{ text: "a1", style: { objectId: "a1" } }] },
        { type: "graphic", graphicKind: "rect", data: { artToolId: "a1" } },
        { type: "plus" },
        { type: "generic-atom-label", label: "a1" },
        { type: "unknown-compatibility-object", sourceFormat: "test", sourceObjectType: "test", warning: "a1", raw: { objectId: "a1" } }
      ].map((fields, i) => DocumentObjectSchema.parse({ x: 100, y: 100, width: 20, height: 20, ...fields,
        id: `reference_${i}`, style: fields.type === "graphic" ? {} : { objectId: "a1", atomId: "a1" }, compatibility: {
          originalId: "a1", warnings: [warning], unknown: { objectId: "a1" }
        }
      }));
    }
    const objects = fixtures("a1");
    const proposed = ProposedDocumentPatchSchema.parse({ reason: "all reference fields", patch: { op: "batch", patches: [
      { op: "addObject", pageId, object: { ...moleculeObject(), id: "a1" } },
      ...objects.flatMap(object => {
        const changes: Partial<DocumentObject> = { ...object };
        delete changes.type;
        return [{ op: "addObject", pageId, object }, { op: "updateObject", objectId: object.id, changes }];
      })
    ] } });
    const rebased = rebaseProposedInsertion(document, proposed);
    if (rebased.patch.op !== "batch") throw new Error("Expected batch");
    const target = rebased.patch.patches[0];
    if (target.op !== "addObject") throw new Error("Expected insertion");
    expect(target.object.id).not.toBe("a1");
    const expected = fixtures(target.object.id);
    for (let i = 0; i < objects.length; i++) {
      expect(rebased.patch.patches[1 + i * 2]).toEqual({ op: "addObject", pageId, object: expected[i] });
      const changes: Partial<DocumentObject> = { ...expected[i] };
      delete changes.type;
      expect(rebased.patch.patches[2 + i * 2]).toEqual({ op: "updateObject", objectId: objects[i].id, changes });
    }
  });

  it("rebases self and forward attachment references before testing whether a group is anchored", () => {
    const document = documentWith(["mol_001", "label"]);
    const pageId = document.pages[0].id;
    const proposed = ProposedDocumentPatchSchema.parse({ reason: "forward and self references", patch: { op: "batch", patches: [
      { op: "addObject", pageId, object: { id: "label", type: "superatom", label: "R", x: -180, y: -180, width: 10, height: 10,
        metadata: { label: "R", attachmentPoints: [{ kind: "atom", objectId: "mol_001", atomId: "a1" }] } } },
      { op: "addObject", pageId, object: { ...recognizedMolecule("mol_001"), x: -200, y: -200,
        superatoms: [{ label: "R", attachmentPoints: [{ kind: "atom", objectId: "mol_001", atomId: "a1" }], warnings: [] }] } }
    ] } });
    const result = applyPluginDocumentPatch(document, proposed);
    const [, , label, molecule] = result.document.pages[0].objects;
    expect(label.id).not.toBe("label");
    expect(molecule.id).not.toBe("mol_001");
    expect(label).toMatchObject({ metadata: { attachmentPoints: [{ objectId: molecule.id, atomId: "a1" }] } });
    expect(molecule).toMatchObject({ superatoms: [{ attachmentPoints: [{ objectId: molecule.id, atomId: "a1" }] }] });
    expect(molecule.x).toBeGreaterThanOrEqual(0);
    expect(label.x - molecule.x).toBe(20);
  });

  it("gives an insertion whose id is taken a fresh id, and inserts it", () => {
    const document = documentWith(["mol_ocsr_004"]);
    const accepted = applyAcceptedPluginProposal(
      document,
      proposal(document.pages[0].id, recognizedMolecule("mol_ocsr_004")),
      { now }
    );
    const ids = accepted.document.pages[0].objects.map((object) => object.id);
    expect(ids).toHaveLength(2);
    const [inserted] = accepted.receipt.objectIds;
    expect(inserted).toMatch(/^mol_ocsr_\d{3}$/);
    expect(inserted).not.toBe("mol_ocsr_004");
    expect(accepted.document.selection.objectIds).toEqual([inserted]);
    // Direct writes also allocate fresh ids, while returning the actual ids to the command.
    const direct = applyPluginDocumentPatch(document, proposal(document.pages[0].id, recognizedMolecule("mol_ocsr_004")), { now });
    expect(direct.receipt.objectIds).toEqual(accepted.receipt.objectIds);
  });

  it("puts an insertion for a page this document lacks on its first page, re-centred, chemistry untouched", () => {
    const document = documentWith([]);
    const page = document.pages[0];
    const source = recognizedMolecule("mol_ocsr_001");
    const accepted = applyAcceptedPluginProposal(document, proposal("page_from_another_document", source), { now });
    const inserted = accepted.document.pages[0].objects.find((object) => object.id === "mol_ocsr_001");
    if (inserted?.type !== "molecule") throw new Error("Expected the recognized molecule on the first page.");
    expect(inserted.x + inserted.width / 2).toBeCloseTo(page.width / 2);
    expect(inserted.y + inserted.height / 2).toBeCloseTo(page.height / 2);
    // Moved as a whole: every atom by the same offset as the box.
    const dx = inserted.x - source.x;
    const dy = inserted.y - source.y;
    expect(inserted.atoms.map((atom) => [atom.x - dx, atom.y - dy])).toEqual(source.atoms.map((atom) => [atom.x, atom.y]));
    // Identity is unchanged (AGENTS.md §10).
    expect(inserted.atoms.map(({ id, element, formalCharge }) => ({ id, element, formalCharge }))).toEqual(
      source.atoms.map(({ id, element, formalCharge }) => ({ id, element, formalCharge }))
    );
    expect(inserted.bonds).toEqual(source.bonds);
    expect(inserted.structure).toBe(source.structure);
  });

  it.each([false, true])("accepts an on-page MolScribe proposal unchanged, including a page-sized drawing (fullPage=%s)", fullPage => {
    const document = documentWith([]);
    const page = document.pages[0];
    const source = { ...recognizedMolecule("mol_ocsr_001"),
      ...(fullPage ? { x: 0, y: 0, width: page.width, height: page.height } : {}) };
    const fits = proposal(page.id, source);
    expect(rebaseProposedInsertion(document, fits)).toBe(fits);
    // A measured viewport must neither recenter the accepted drawing nor limit its size to
    // the visible rectangle. The page-sized case also exercises the strict oversize boundary.
    const result = applyPluginDocumentPatch(document, rebaseProposedInsertion(document, fits), {
      insertionTarget: { pageId: page.id, bounds: { x: 300, y: 400, width: 200, height: 200 } }
    });
    expect(result.document.pages[0].objects).toEqual([source]);
    const accepted = applyAcceptedPluginProposal(document, fits);
    expect(accepted.document.pages[0].objects).toEqual([source]);
    expect(result.document.selection.objectIds).toEqual(["mol_ocsr_001"]);
  });

  it("accepts an oversized MolScribe insertion anchored to an in-page object without a placement refusal", () => {
    const document = documentWith(["existing"]);
    const page = document.pages[0];
    const source = { ...recognizedMolecule("mol_ocsr_001"), width: page.width + 1, superatoms: [{
      label: "R", attachmentPoints: [{ kind: "object" as const, objectId: "existing" }], warnings: []
    }] };
    const result = applyAcceptedPluginProposal(document, proposal(page.id, source));
    expect(result.document.pages[0].objects).toEqual([...document.pages[0].objects, source]);
    expect(result.document.selection.objectIds).toEqual([source.id]);
  });
});

describe("plugin writes during a canvas gesture", () => {
  it("runs at once when no gesture is active", async () => {
    const gate = createPluginWriteGate({ isGestureActive: () => false });
    await expect(gate.run(() => "applied")).resolves.toBe("applied");
    expect(gate.pending()).toBe(0);
  });

  it("waits for the gesture to end, then runs queued writes in order and settles only then", async () => {
    let gesture = true;
    const timers: Array<() => void> = [];
    const gate = createPluginWriteGate({
      isGestureActive: () => gesture,
      setTimer: (callback) => timers.push(callback),
      clearTimer: () => undefined
    });
    const applied: string[] = [];
    let settled = false;
    const first = gate.run(() => {
      applied.push("first");
      return 1;
    });
    void first.then(() => {
      settled = true;
    });
    const second = gate.run(() => {
      applied.push("second");
      return 2;
    });
    await Promise.resolve();
    expect(applied).toEqual([]);
    expect(settled).toBe(false);
    expect(gate.pending()).toBe(2);

    // Still dragging when the timer fires: keep waiting.
    timers.shift()!();
    expect(applied).toEqual([]);

    gesture = false;
    gate.flush();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(applied).toEqual(["first", "second"]);
  });

  it("rejects a write that fails, and one still waiting when the window goes away", async () => {
    const gate = createPluginWriteGate({ isGestureActive: () => false });
    await expect(
      gate.run(() => {
        throw new Error("The document changed while the plugin was running; nothing was inserted.");
      })
    ).rejects.toThrow(/document changed/);

    const blocked = createPluginWriteGate({ isGestureActive: () => true, setTimer: () => 1, clearTimer: () => undefined });
    const waiting = blocked.run(() => "never");
    blocked.dispose();
    await expect(waiting).rejects.toThrow(/nothing was inserted/);
  });
});

describe("a plugin write that waits too long", () => {
  it("is refused plainly instead of hanging the plugin's command", async () => {
    let clock = 0;
    const timers: Array<() => void> = [];
    const gate = createPluginWriteGate({
      isGestureActive: () => true,
      maxWaitMs: 1_000,
      now: () => clock,
      setTimer: (callback) => timers.push(callback),
      clearTimer: () => undefined
    });
    const apply = vi.fn(() => "applied");
    const waiting = gate.run(apply);
    clock = 999;
    timers.shift()!();
    expect(gate.pending()).toBe(1);
    clock = 1_000;
    timers.shift()!();
    await expect(waiting).rejects.toThrow(/stayed busy/);
    expect(apply).not.toHaveBeenCalled();
    expect(gate.pending()).toBe(0);
  });
});
