import { applyPatch, cloneDocument, type ChemDraftDocument, type DocumentObject, type DocumentPatch } from "@chemdraft/chem-core";
import { ASSISTANT_COMMANDS, assistantCommand } from "../commandCatalog";
import { requireDocument, type AssistantToolContext } from "../AssistantToolContext";
import { assistantDocumentContentUnchanged } from "../historyPort";
import { applyAssistantWrite, inspectMolecule, scopeRefusal } from "../writeBuilder";
import type { ToolInput } from "./schemas";

export function listCommands(context: AssistantToolContext) {
  if (!context.commands) throw new Error("The document command registry is unavailable.");
  return ASSISTANT_COMMANDS.filter(command => context.commands!.has(command.id)).map(command => ({ ...command }));
}

/** Translate a staged registry result into the existing patch contract, without granting new operations. */
function commandPatch(before: ChemDraftDocument, after: ChemDraftDocument): DocumentPatch {
  const patches: DocumentPatch[] = [];
  if (before.pages.length !== after.pages.length) throw new Error("Command cannot change document pages.");
  for (const [index, page] of before.pages.entries()) {
    const next = after.pages[index]!;
    if (page.id !== next.id) throw new Error("Command cannot change document pages.");
    const originals = new Map(page.objects.map(object => [object.id, object]));
    const remaining = new Set(next.objects.map(object => object.id));
    for (const object of page.objects) if (!remaining.has(object.id)) patches.push({ op: "removeObject", objectId: object.id });
    for (const object of next.objects) {
      const original = originals.get(object.id);
      if (!original) patches.push({ op: "addObject", pageId: page.id, object });
      else if (JSON.stringify(original) !== JSON.stringify(object)) {
        if (original.type !== object.type) throw new Error("Command cannot change an object's type.");
        const changes: Partial<DocumentObject> = {};
        for (const key of new Set([...Object.keys(original), ...Object.keys(object)]) as Set<keyof DocumentObject>) {
          if (JSON.stringify(original[key]) !== JSON.stringify(object[key])) Object.assign(changes, { [key]: object[key] });
        }
        patches.push({ op: "updateObject", objectId: object.id, changes });
      }
    }
    const defaultOrder = [...page.objects.filter(object => remaining.has(object.id)), ...next.objects.filter(object => !originals.has(object.id))].map(object => object.id);
    const nextOrder = next.objects.map(object => object.id);
    if (JSON.stringify(defaultOrder) !== JSON.stringify(nextOrder)) patches.push({ op: "setObjectOrder", pageId: page.id, objectIds: nextOrder });
  }
  if (patches.length > 256) throw new Error("Command exceeds the 256 operation limit.");
  return { op: "batch", patches };
}

async function guardIdentity(context: AssistantToolContext, before: ChemDraftDocument, after: ChemDraftDocument) {
  const previous = new Map(before.pages.flatMap(page => page.objects.map(object => [object.id, object] as const)));
  const remaining = new Map(after.pages.flatMap(page => page.objects.map(object => [object.id, object] as const)));
  for (const object of previous.values()) {
    if (object.type === "molecule" && remaining.get(object.id)?.type !== "molecule") throw new Error("refused: would change identity");
  }
  for (const object of after.pages.flatMap(page => page.objects)) {
    const original = previous.get(object.id);
    if (object.type !== "molecule") continue;
    if (original?.type !== "molecule") throw new Error("refused: would change identity");
    if (JSON.stringify(original) === JSON.stringify(object)) continue;
    // The same native graph -> molfile -> app RDKit path used to verify inserted structures.
    const source = await inspectMolecule(context, original);
    const result = await inspectMolecule(context, object);
    if (source.canonicalSmiles === result.canonicalSmiles) continue;
    // Recanonicalize without stereo markers to distinguish identity changes from R/S or E/Z.
    // Isotope, charge and radical notation is retained.
    const withoutStereo = (smiles: string) => context.chemistry.inspectStructure("smiles", smiles.replace(/@+|[\\/]/g, ""));
    const a = await withoutStereo(source.canonicalSmiles);
    const b = await withoutStereo(result.canonicalSmiles);
    const reason = a.valid && b.valid && a.canonicalSmiles === b.canonicalSmiles ? "stereochemistry" : "identity";
    throw new Error(`refused: would change ${reason}`);
  }
}

export async function runCommand(context: AssistantToolContext, { id }: ToolInput<"run_command">) {
  const command = assistantCommand(id);
  if (!command) throw new Error(`Command ${id} is not allowlisted. Call list_commands for supported capabilities.`);
  if (!context.commands?.has(id)) throw new Error(`Command ${id} is unavailable in the document registry.`);
  const baseline = structuredClone(requireDocument(context));
  const before = cloneDocument(baseline);
  const selection = [...context.getSelectionAtSend()];
  if (command.needsSelection && !selection.length) throw new Error("This command needs objects selected when Send was pressed.");
  for (const selected of selection) {
    if (!before.pages.some(page => page.objects.some(object => object.id === selected))) throw new Error(`Selected object ${selected} no longer exists.`);
  }
  const checkPreconditions = (latest: ChemDraftDocument) => {
    if (!assistantDocumentContentUnchanged(baseline, latest)) throw new Error("The document changed while the assistant prepared this command; read it again and retry.");
  };
  const assertActive = () => checkPreconditions(requireDocument(context));
  let staged = cloneDocument(before);
  staged.selection = { objectIds: selection, pageId: before.pages.find(page => page.objects.some(object => selection.includes(object.id)))?.id };
  await context.commands.invoke(id, {
    tabId: context.tabId, getDocument: () => staged, assertActive,
    commit: update => {
      assertActive();
      if (command.actsOn === "view") throw new Error("View commands cannot change the document.");
      const next = typeof update === "function" ? update(staged) : update;
      const changed = !assistantDocumentContentUnchanged(staged, next);
      staged = next;
      return changed;
    }
  });
  assertActive();
  if (command.actsOn === "view") {
    if (!assistantDocumentContentUnchanged(before, staged)) throw new Error("View commands cannot change the document.");
    return { summary: "opened the 3D view", objectIds: [], warnings: [] };
  }
  const patch = commandPatch(before, staged);
  if (patch.op !== "batch") throw new Error("Expected command batch.");
  if (!patch.patches.length) return { summary: `${command.title}: no document change`, objectIds: [], warnings: [] };
  const ids = patch.patches.flatMap(op => op.op === "setObjectOrder" ? op.objectIds : "objectId" in op ? [op.objectId] : []);
  // Groups must not acquire references to objects outside the request either.
  for (const page of staged.pages) for (const object of page.objects) {
    if (object.type === "group" && patch.patches.some(op => op.op === "addObject" ? op.object.id === object.id : "objectId" in op && op.objectId === object.id)) {
      ids.push(...object.childObjectIds.filter(child => before.pages.some(p => p.objects.some(o => o.id === child))));
    }
  }
  const refused = scopeRefusal(context, ids);
  if (refused) throw new Error(refused.reason);
  const validated = applyPatch(cloneDocument(before), patch, { now: context.now() });
  // Detect implicit normalization effects too; never omit part of a command's output.
  if (!assistantDocumentContentUnchanged(staged, validated)) throw new Error("Command result cannot be represented safely by document patches.");
  await guardIdentity(context, before, validated);
  return applyAssistantWrite(context, { patch, summary: command.title, warnings: [], checkPreconditions });
}
