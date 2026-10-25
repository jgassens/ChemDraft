import {
  applyPatch,
  createDocumentHistory,
  createEmptyDocument,
  type DocumentHistory,
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

  it("creates one undo entry, selects inserted objects, and queues no proposal review", async () => {
    const now = "2026-09-24T15:00:00.000Z";
    let history: DocumentHistory = createDocumentHistory(createEmptyDocument({ now }));
    const proposalChanged = vi.fn();
    const committedLabels: string[] = [];
    const host = new PluginHost({
      getActiveDocument: () => history.present,
      onProposedPatchesChanged: proposalChanged,
      applyDocumentPatch: (request) => {
        const applied = applyPluginDocumentPatch(history.present, request.patch, { now });
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
                op: "addObject",
                pageId: history.present.pages[0].id,
                object: moleculeObject()
              }
            })
        }
      }
    );

    await expect(host.invokeCommand("plugin.desktopDirectWrite.insert")).resolves.toEqual({
      applied: true,
      objectIds: ["mol_direct"]
    });
    expect(history.past).toHaveLength(1);
    expect(history.present.pages[0].objects.map((object) => object.id)).toEqual(["mol_direct"]);
    expect(history.present.selection.objectIds).toEqual(["mol_direct"]);
    expect(committedLabels).toEqual(["Name to Structure: Insert Named Structure"]);
    expect(host.listProposedPatches("pending")).toHaveLength(0);
    expect(proposalChanged).not.toHaveBeenCalled();
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

  it("leaves a proposal that already fits the document exactly as it was", () => {
    const document = documentWith([]);
    const fits = proposal(document.pages[0].id, recognizedMolecule("mol_ocsr_001"));
    expect(rebaseProposedInsertion(document, fits)).toBe(fits);
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
