import type { AssistantToolContext } from "../AssistantToolContext";
import {
  applyAssistantWrite, buildEditStructure, buildInsertReaction, buildInsertStructures,
  buildInsertText, buildMoveObjects, buildStyleObjects, scopeRefusal, type AssistantWrite
} from "../writeBuilder";
import type { ToolInput } from "./schemas";

export async function insertStructures(context: AssistantToolContext, input: ToolInput<"insert_structures">) {
  return applyAssistantWrite(context, await buildInsertStructures(context, input));
}
export async function insertReaction(context: AssistantToolContext, input: ToolInput<"insert_reaction">) {
  return applyAssistantWrite(context, await buildInsertReaction(context, input));
}
export async function insertText(context: AssistantToolContext, input: ToolInput<"insert_text">) {
  return applyAssistantWrite(context, buildInsertText(context, input));
}
async function scopedWrite(context: AssistantToolContext, ids: string[], builder: () => AssistantWrite | Promise<AssistantWrite>) {
  const refused = scopeRefusal(context, ids);
  if (refused) return refused;
  return applyAssistantWrite(context, await builder());
}
export async function editStructure(context: AssistantToolContext, input: ToolInput<"edit_structure">) {
  return scopedWrite(context, [input.objectId], () => buildEditStructure(context, input));
}
export async function deleteObjects(context: AssistantToolContext, input: ToolInput<"delete_objects">) {
  return scopedWrite(context, input.objectIds, () => ({
    patch: { op: "batch", patches: [...new Set(input.objectIds)].map(objectId => ({ op: "removeObject", objectId })) },
    summary: `Deleted ${new Set(input.objectIds).size} objects`, warnings: []
  }));
}
export async function styleObjects(context: AssistantToolContext, input: ToolInput<"style_objects">) {
  return scopedWrite(context, input.objectIds, () => buildStyleObjects(context, input));
}
export async function moveObjects(context: AssistantToolContext, input: ToolInput<"move_objects">) {
  return scopedWrite(context, input.objectIds, () => buildMoveObjects(context, input));
}
