import { createDocumentHistory, createEmptyDocument, type DocumentHistory, type MoleculeObject } from "@chemdraft/chem-core";
import { PluginHost } from "@chemdraft/plugin-host";
import { describe, expect, it, vi } from "vitest";

import { applyPluginDocumentPatch } from "./applyPluginDocumentPatch";

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
