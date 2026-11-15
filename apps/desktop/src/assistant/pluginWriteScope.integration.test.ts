import { beforeAll, describe, expect, it, vi } from "vitest";
import { applyPatch, toEngineDocument, type BracketObject } from "@chemdraft/chem-core";
import { createSmilesMolecule, inspectHydrogenNormalizedIdentity, pastedStructureDepictionFromMolfile } from "@chemdraft/document-workflow-core";
import { PluginApiVersion, type PluginCommandContext } from "@chemdraft/plugin-api";
import { PluginHost, type PluginPatchApplicationRequest } from "@chemdraft/plugin-host";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import { ensureRdkit, generateSmiles2DMolfile } from "../../../../packages/rdkit-adapter/src/conformer";
import { applyPluginDocumentPatch } from "../plugins/applyPluginDocumentPatch";
import { assistantScope } from "./AssistantToolContext";
import { callAssistantTool } from "./assistantTools";
import { buildEditStructure } from "./writeBuilder";
import { testContext } from "./tools/testContext";

beforeAll(() => installNodeRdkitModuleLoader());

type Membership = "geometry" | "object ids" | "crossing bonds";

/** Isolate the general host preflight from the controller's earlier normalization checks.
 * Real assistant tools/builders and real desktop patch application surround applyPatchForPlugin;
 * the request override is the same fixed-document scope used by AssistantToolsController.
 */
function fixture(selected = true, membership?: Membership, selectBrackets = false) {
  const f = testContext(selected);
  const { context, replace } = f;
  const molecule = { ...f.molecule, id: "user_molecule" };
  const selectedIds = [...(selected ? [molecule.id] : []), ...(selectBrackets ? ["repeat_open", "repeat_close"] : [])];
  context.getSelectionAtSend = () => selectedIds;
  let document = context.getDocument()!;
  document = { ...document, pages: document.pages.map(page => ({ ...page,
    objects: page.objects.map(object => object.id === f.molecule.id ? molecule : object) })) };
  if (membership) {
    const open: BracketObject = {
      id: "repeat_open", type: "bracket", bracketKind: "square", pairId: "repeat_pair", side: "open",
      repeatUnit: true, bracketUsage: "sru", x: 210, y: 210, width: 10, height: 100, rotation: 0, style: {},
      containedObjectIds: membership === "object ids" ? [molecule.id] : [],
      ...(membership === "crossing bonds" ? { crossingBondIds: [{ objectId: molecule.id, bondId: molecule.bonds[0]!.id }] } : {})
    };
    document = applyPatch(document, { op: "batch", patches: [open, {
      ...open, id: "repeat_close", x: 320, side: "close" as const, label: "n"
    }].map(object => ({ op: "addObject" as const, pageId: document.pages[0]!.id, object })) });
  }
  replace(toEngineDocument({ ...document, selection: { pageId: document.pages[0]!.id, objectIds: selectedIds } }));

  // Real chemistry makes edit_structure a genuine CC -> CO graph replacement.
  context.chemistry.inspectStructure = async (_format, value, stereoReference) => {
    const rdkit = await ensureRdkit();
    const mol = rdkit.get_mol(value, JSON.stringify({ removeHs: false })) as {
      get_smiles(): string; get_json(): string; delete(): void
    } | null;
    if (!mol) return { valid: false, reason: "RDKit could not parse the structure" };
    try {
      const identity = inspectHydrogenNormalizedIdentity(rdkit, value, stereoReference);
      if (!identity.valid) return identity;
      const graph = JSON.parse(mol.get_json()) as {
        defaults?: { atom?: { z?: number } }; molecules: { atoms: { z?: number }[] }[]
      };
      const defaultZ = graph.defaults?.atom?.z ?? 6;
      return { valid: true, canonicalSmiles: mol.get_smiles(), identitySmiles: identity.canonicalSmiles,
        identityFacts: identity.facts, formula: "test-only", warnings: [],
        heavyAtoms: graph.molecules.reduce((sum, molecule) => sum + molecule.atoms.filter(atom =>
          (atom.z ?? defaultZ) !== 1).length, 0) };
    } finally { mol.delete(); }
  };
  context.chemistry.structureFromSmiles = async ({ smiles }) => ({ available: true, built: true,
    object: createSmilesMolecule(context.getDocument()!, { x: 250, y: 250 },
      pastedStructureDepictionFromMolfile(await generateSmiles2DMolfile(smiles)), smiles)
  });

  const apply = vi.fn((application: PluginPatchApplicationRequest) => {
    const result = applyPluginDocumentPatch(context.getDocument()!, application.patch);
    replace(result.document);
    return result.receipt;
  });
  const host = new PluginHost({ getActiveDocument: context.getDocument, applyDocumentPatch: apply });
  const preflight = vi.spyOn(host, "applyPatchForPlugin"); // Observes the real implementation, never mocks it.
  context.write = async (patch, signal, check) => {
    signal?.throwIfAborted();
    check?.(context.getDocument()!);
    return host.applyPatchForPlugin(context.plugin.id, undefined, { reason: "Assistant write", patch }, {
      objectIds: [...assistantScope(context)], getDocument: context.getDocument, apply
    });
  };
  return { ...f, molecule, apply, host, preflight,
    objects: () => context.getDocument()!.pages[0]!.objects,
    run: async (action: (command: PluginCommandContext) => Promise<void>) => {
      host.registerPlugin({ id: context.plugin.id, name: "Assistant", version: "0.0.1", apiVersion: `^${PluginApiVersion}`,
        entry: "worker.js", permissions: ["document.write"],
        contributes: { commands: [{ id: "plugin.assistant.scopeTest", title: "Assistant scope test" }] }
      }, { commandHandlers: { "plugin.assistant.scopeTest": action } });
      try { await host.invokeCommand("plugin.assistant.scopeTest"); }
      finally { host.unregisterPlugin(context.plugin.id); }
    },
    tool: async (name: string, input: unknown) => {
      const calls = preflight.mock.calls.length;
      const result = await callAssistantTool(context, name, input);
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent?.refused, JSON.stringify(result)).not.toBe(true);
      expect(preflight).toHaveBeenCalledTimes(calls + 1);
      return result.structuredContent!.objectIds as string[];
    }
  };
}

describe("assistant builders through the real plugin-host write-scope preflight", () => {
  it("accepts insert_reaction with no selection, molecules, plus texts and conditions", async () => {
    const f = fixture(false);
    const before = structuredClone(f.objects());
    await f.run(async () => {
      const ids = await f.tool("insert_reaction", { reactants: ["CC", "O"], products: ["CCO"],
        above: ["catalyst"], below: ["heat"], caption: "Reaction" });
      const inserted = f.objects().filter(object => ids.includes(object.id));
      expect(inserted.filter(object => object.type === "molecule")).toHaveLength(3);
      expect(inserted.some(object => object.type === "text" && object.text === "+")).toBe(true);
      expect(inserted.some(object => object.type === "reaction-arrow")).toBe(true);
      expect(inserted.filter(object => object.type === "text").map(object => object.text))
        .toEqual(expect.arrayContaining(["catalyst", "heat"]));
      expect(f.objects().slice(0, before.length)).toEqual(before);
      expect(f.apply).toHaveBeenCalledOnce();
    });
  });

  const edits = ["style_objects", "edit_structure", "move_objects"] as const;
  it.each(edits)("accepts %s on a selected user-drawn molecule", async name => {
    const f = fixture();
    await f.run(async () => {
      const before = structuredClone(f.objects());
      const ids = await f.tool(name, name === "edit_structure" ? { objectId: f.molecule.id, smiles: "CO" }
        : name === "style_objects" ? { objectIds: [f.molecule.id], style: { color: "#123456" } }
          : { objectIds: [f.molecule.id], to: { arrange: "row" } });
      expect(ids).toHaveLength(1);
      expect(f.objects()).not.toEqual(before);
      expect(f.objects().find(object => object.id === f.text.id)).toEqual(f.text);
      expect(f.apply).toHaveBeenCalledOnce();
    });
  });

  describe.each(["geometry", "object ids", "crossing bonds"] as const)("repeat-unit membership: %s", membership => {
    describe.each([false, true])("brackets selected: %s", selected => {
      it.each(["style_objects", "edit_structure"] as const)("accepts %s on the selected member", async name => {
        const f = fixture(true, membership, selected);
        await f.run(async () => {
          const brackets = structuredClone(f.objects().filter(object => object.type === "bracket"));
          if (name === "edit_structure") {
            // Tool dispatch currently refuses the derived bracket_multiplier warning during
            // applyAssistantWrite's chemistry check, before calling the host. Feed its REAL
            // builder patch to the boundary directly so that cannot mask host-scope regressions.
            const built = await buildEditStructure(f.context, { objectId: f.molecule.id, smiles: "CO", keepPosition: true });
            if (!selected && membership !== "geometry") {
              // Replacing the molecule with a new id would prune the unselected brackets' membership.
              // TODO(assistant): edit_structure inside a repeat unit should keep the molecule id or remap bracket membership (1.3)
              const before = structuredClone(f.context.getDocument());
              await expect(f.context.write(built.patch)).rejects.toMatchObject({
                message: 'Removing "user_molecule" would change bracket "repeat_open", which is not selected'
              });
              expect(f.preflight).toHaveBeenCalledOnce();
              expect(f.apply).not.toHaveBeenCalled();
              expect(f.context.getDocument()).toEqual(before);
              return;
            }
            const before = f.context.getDocument();
            const receipt = await f.context.write(built.patch).catch(error => {
              expect(f.preflight).toHaveBeenCalledOnce();
              expect(f.apply).not.toHaveBeenCalled();
              expect(f.context.getDocument()).toBe(before);
              throw error;
            });
            expect(receipt).toMatchObject({ applied: true });
            expect(f.preflight).toHaveBeenCalledOnce();
          } else {
            await f.tool(name, { objectIds: [f.molecule.id], style: { color: "#123456", strokeWidth: 2 } });
          }
          expect(f.apply).toHaveBeenCalledOnce();
          const after = f.objects().filter(object => object.type === "bracket");
          expect(after).toHaveLength(2);
          after.forEach(object => expect(object).toMatchObject({ pairId: "repeat_pair", repeatUnit: true, bracketUsage: "sru" }));
          if (!selected) expect(after).toEqual(brackets);
        });
      });
    });
  });

  it("accepts successive writes to earlier insertions during one assistant command", async () => {
    const f = fixture(false);
    await f.run(async () => {
      const inserted = await f.tool("insert_structures", { items: [{ kind: "molecule", smiles: "CC" }] });
      // Desktop selection changes must not be what authorizes the next writes.
      f.replace({ ...f.context.getDocument()!, selection: { objectIds: [] } });
      await f.tool("style_objects", { objectIds: inserted, style: { color: "#123456" } });
      await f.tool("move_objects", { objectIds: inserted, to: { arrange: "row" } });
      const replaced = await f.tool("edit_structure", { objectId: inserted[0], smiles: "CO" });
      await f.tool("style_objects", { objectIds: replaced, style: { color: "#654321" } });
      expect(f.apply).toHaveBeenCalledTimes(5);
      expect(f.objects().find(object => object.id === replaced[0])).toMatchObject({ style: { bondColor: "#654321" } });
    });
  });

  it("also grows an ordinary plugin command's scope from accepted insertion receipts", async () => {
    const f = fixture(false);
    await f.run(async command => {
      await command.documents.applyPatch!({ reason: "Insert", patch: { op: "addObject",
        pageId: f.context.getDocument()!.pages[0]!.id, object: { ...f.text, id: "plugin_inserted" } } });
      await command.documents.applyPatch!({ reason: "Edit own insertion", patch: {
        op: "updateObject", objectId: "plugin_inserted", changes: { text: "Edited" }
      } });
      expect(f.apply).toHaveBeenCalledTimes(2);
      expect(f.objects().find(object => object.id === "plugin_inserted")).toMatchObject({ text: "Edited" });
    });
  });

  it("still refuses a genuine out-of-scope edit at the host boundary", async () => {
    const f = fixture();
    const before = f.context.getDocument();
    await f.run(async () => {
      // Bypass only the assistant's early tool-level refusal, so this exercises host enforcement.
      await expect(f.context.write({ op: "updateObject", objectId: f.text.id, changes: { text: "Unauthorized" } }))
        .rejects.toThrow(`${f.text.id} was not selected when the command started`);
      expect(f.preflight).toHaveBeenCalledOnce();
      expect(f.apply).not.toHaveBeenCalled();
      expect(f.context.getDocument()).toBe(before);
    });
  });

  it("still refuses an indirect change to an unselected bracket partner atomically", async () => {
    const f = fixture(true, "geometry");
    f.context.getSelectionAtSend = () => ["repeat_open"];
    const before = f.context.getDocument();
    await f.run(async () => {
      await expect(f.context.write({ op: "removeObject", objectId: "repeat_open" }))
        .rejects.toThrow('Patch would change object "repeat_close", which is not selected');
      expect(f.preflight).toHaveBeenCalledOnce();
      expect(f.apply).not.toHaveBeenCalled();
      expect(f.context.getDocument()).toBe(before);
    });
  });
});
