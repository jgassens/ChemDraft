import { vi } from "vitest";
import { applyPatch, createEmptyDocument, type ChemDraftDocument, type DocumentPatch, type MoleculeObject } from "@chemdraft/chem-core";
import { createNativeTextObject, createSmilesMolecule } from "@chemdraft/document-workflow-core";
import { pluginPermissions } from "@chemdraft/plugin-api";
import type { AssistantToolContext } from "../AssistantToolContext";

export function moleculeFixture(document: ChemDraftDocument): MoleculeObject {
  const molecule = createSmilesMolecule(document, { x: 250, y: 250 }, {
    atoms: [{ element: "C", x: 0, y: 0, charge: 0 }, { element: "C", x: 1, y: 0, charge: 0 }],
    bonds: [{ from: 0, to: 1, order: "single", wedge: null }]
  }, "CC");
  if (molecule.type !== "molecule") throw new Error("Expected molecule");
  return molecule;
}
export function testContext(selected = true) {
  let document: ChemDraftDocument | undefined = createEmptyDocument({ title: "Assistant test", now: "2026-10-22T00:00:00Z" });
  const molecule = moleculeFixture(document);
  const text = { ...createNativeTextObject(document, { x: 400, y: 400 }, "Original text"), id: "text_original" };
  document.pages[0]!.objects = [molecule, text];
  const selection = selected ? [molecule.id] : [];
  const context: AssistantToolContext = {
    plugin: { id: "org.chemdraft.assistant", name: "Assistant", permissions: [...pluginPermissions] },
    tabId: "tab_pinned", getDocument: () => document, getSelectionAtSend: () => selection,
    getViewportRect: vi.fn(() => ({ x: 0, y: 0, width: 600, height: 600 })),
    now: () => "2026-10-22T00:00:00Z",
    write: vi.fn(async (patch: DocumentPatch) => {
      document = applyPatch(document!, patch);
      const leaves = patch.op === "batch" ? patch.patches : [patch];
      return { objectIds: leaves.flatMap(leaf => leaf.op === "addObject" ? [leaf.object.id] :
        leaf.op === "updateObject" || leaf.op === "moveObject" ? [leaf.objectId] : []) };
    }),
    chemistry: {
      inspectStructure: vi.fn(async (format, value) => ({ valid: true as const, canonicalSmiles: format === "smiles" ? value : "CC",
        heavyAtoms: 2, formula: "C2H6", warnings: [] })),
      structureFromSmiles: vi.fn(async () => ({ available: true as const, built: true as const, object: moleculeFixture(document!) })),
      nameToStructure: vi.fn(async () => ({ available: true as const, parsed: true as const, smiles: "CC", engine: { id: "opsin", version: "test" } })),
      structureToName: vi.fn(async () => ({ status: "engineNotInstalled" as const }))
    },
    render: vi.fn(async () => ({ bytes: Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), width: 100, height: 80 }))
  };
  return { context, molecule, text, close: () => { document = undefined; }, replace: (next: ChemDraftDocument) => { document = next; } };
}
